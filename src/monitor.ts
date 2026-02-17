// @ts-nocheck force update v2
import { ethers } from 'ethers';
import { config } from './config';
import { store } from './store';
import { attemptMint } from './mint';
import { Bot } from 'grammy';
import { isLikelyNFTMint, getFilterReason } from './filters';

interface ChainConfig {
    name: string;
    rpcUrls: string[];  // Multiple RPCs for fallback
    pollInterval: number; // ms between checks
}

const chains: ChainConfig[] = [
    {
        name: 'ETH',
        rpcUrls: [
            config.rpcUrl,
            'https://ethereum-rpc.publicnode.com',
            'https://rpc.ankr.com/eth',
            'https://cloudflare-eth.com',
        ].filter(Boolean),
        pollInterval: 12000  // 12 seconds (ETH block time)
    },
    {
        name: 'BASE',
        rpcUrls: [
            config.rpcUrlBase,
            'https://base-rpc.publicnode.com',
            'https://rpc.ankr.com/base',
        ].filter(Boolean),
        pollInterval: 5000  // 5 seconds (BASE block time ~2s)
    }
];

// Track last checked block for each chain
const lastCheckedBlock: Record<string, number> = {};

// Track processed tx hashes to avoid double-minting
const processedTxs = new Set<string>();
const MAX_PROCESSED_TXS = 5000;

// Admin chat ID gets priority minting
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || '6588909371';

/**
 * Create a provider with retry logic
 */
function createProvider(rpcUrls: string[]): ethers.JsonRpcProvider {
    return new ethers.JsonRpcProvider(rpcUrls[0]);
}

/**
 * Retry an RPC call with fallback providers
 */
async function rpcCallWithRetry<T>(
    rpcUrls: string[],
    action: (provider: ethers.JsonRpcProvider) => Promise<T>,
    chainName: string,
    maxRetries = 3
): Promise<T> {
    let lastError: any;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        // Try each RPC URL
        const rpcUrl = rpcUrls[attempt % rpcUrls.length];
        const provider = new ethers.JsonRpcProvider(rpcUrl);

        try {
            return await action(provider);
        } catch (err: any) {
            lastError = err;
            const isConnectionError = err.message?.includes('ECONNRESET') ||
                err.message?.includes('ETIMEDOUT') ||
                err.message?.includes('rate limit') ||
                err.message?.includes('429');

            if (isConnectionError && attempt < maxRetries - 1) {
                const delay = Math.min(1000 * (attempt + 1), 3000);
                console.log(`[${chainName}] RPC error, retrying with ${rpcUrl.substring(0, 40)}... (attempt ${attempt + 2}/${maxRetries})`);
                await new Promise(r => setTimeout(r, delay));
            } else {
                throw err;
            }
        }
    }
    throw lastError;
}

/**
 * Build a lookup map: tracked address (lowercase) → array of {userId, userData}
 */
function buildWalletMap() {
    const map = new Map<string, Array<{ userId: string; chatId: number }>>();
    const allUsers = store.getAllUsers();

    for (const { userId, data: userData } of allUsers) {
        for (const wallet of userData.trackedWallets) {
            const addr = wallet.address.toLowerCase();
            if (!map.has(addr)) {
                map.set(addr, []);
            }
            map.get(addr)!.push({ userId, chatId: userData.chatId });
        }
    }

    return map;
}

/**
 * Clean up old processed tx hashes to prevent memory leak
 */
function cleanupProcessedTxs() {
    if (processedTxs.size > MAX_PROCESSED_TXS) {
        const entries = Array.from(processedTxs);
        const toRemove = entries.slice(0, entries.length - 1000);
        toRemove.forEach(hash => processedTxs.delete(hash));
        console.log(`🧹 Cleaned up ${toRemove.length} old tx hashes`);
    }
}

/**
 * OPTIMIZED monitoring:
 * - Fetches entire block with transactions in 1 RPC call
 * - Uses wallet lookup map instead of nested loops
 * - Includes retry logic and RPC fallbacks
 */
export function startMonitoring(bot: Bot) {
    console.log("👀 Starting Blockchain Monitors (Optimized v2)...");

    chains.forEach(chain => {
        if (chain.rpcUrls.length === 0) {
            console.warn(`⚠️ No RPC URLs for ${chain.name}, skipping.`);
            return;
        }

        console.log(`✅ Listening on ${chain.name} (${chain.rpcUrls.length} RPC endpoints, ${chain.pollInterval / 1000}s interval)`);

        setInterval(async () => {
            try {
                const walletMap = buildWalletMap();
                if (walletMap.size === 0) return;

                // 1. Get current block number
                const currentBlock = await rpcCallWithRetry(
                    chain.rpcUrls,
                    (provider) => provider.getBlockNumber(),
                    chain.name
                );

                const lastBlock = lastCheckedBlock[chain.name] || currentBlock - 1;
                if (currentBlock <= lastBlock) return;

                // Process any blocks we missed (in case of lag)
                const startBlock = Math.max(lastBlock + 1, currentBlock - 2); // Max 3 blocks back

                for (let blockNum = startBlock; blockNum <= currentBlock; blockNum++) {
                    console.log(`[${chain.name}] Checking block ${blockNum}...`);

                    // 2. Fetch ENTIRE block with ALL transactions in ONE call
                    let block;
                    try {
                        block = await rpcCallWithRetry(
                            chain.rpcUrls,
                            (provider) => provider.getBlock(blockNum, true),
                            chain.name
                        );
                    } catch (err: any) {
                        console.error(`[${chain.name}] Failed to fetch block ${blockNum}: ${err.message}`);
                        continue;
                    }

                    if (!block || !block.prefetchedTransactions) continue;

                    // 3. Check ALL transactions against our wallet map (in memory - instant)
                    for (const tx of block.prefetchedTransactions) {
                        const fromAddr = tx.from.toLowerCase();

                        // Is this from a tracked wallet?
                        const trackers = walletMap.get(fromAddr);
                        if (!trackers) continue;

                        // Skip if already processed (dedup across users)
                        const txKey = tx.hash;
                        if (processedTxs.has(txKey)) continue;

                        // Log what we found
                        console.log(`[${chain.name}] 🎯 Found tx from tracked wallet ${fromAddr.substring(0, 10)}... (hash: ${tx.hash.substring(0, 14)}...)`);

                        // Check if it's a contract interaction
                        if (!tx.data || tx.data === '0x') {
                            console.log(`  ⏭️ Simple ETH transfer (no calldata) - skipping`);
                            processedTxs.add(txKey);
                            continue;
                        }

                        if (!tx.to) {
                            console.log(`  ⏭️ Contract deployment - skipping`);
                            processedTxs.add(txKey);
                            continue;
                        }

                        // Apply mint filters
                        if (!isLikelyNFTMint(tx.data)) {
                            const reason = getFilterReason(tx.data);
                            console.log(`  ⏭️ Filtered: ${reason}`);
                            processedTxs.add(txKey);
                            continue;
                        }

                        console.log(`  ✅ NFT Mint detected! Processing for ${trackers.length} user(s) in PARALLEL...`);
                        processedTxs.add(txKey);

                        // 4. Build mint tasks for all users
                        const mintTask = async (tracker: { userId: string; chatId: number }) => {
                            const privateKey = store.getDecryptedPrivateKey(tracker.userId);
                            if (!privateKey) {
                                console.error(`  ❌ Failed to decrypt key for user ${tracker.userId}`);
                                return;
                            }
                            const provider = new ethers.JsonRpcProvider(chain.rpcUrls[0]);
                            const walletSigner = new ethers.Wallet(privateKey, provider);
                            console.log(`  📨 User ${tracker.userId} minting with wallet: ${walletSigner.address}`);
                            await attemptMint({
                                originalTx: tx,
                                bot,
                                chatId: tracker.chatId,
                                chainName: chain.name,
                                signer: walletSigner
                            });
                        };

                        // 5. ADMIN PRIORITY: process admin first, then everyone else in parallel
                        const adminChatId = ADMIN_CHAT_ID;
                        const adminTracker = adminChatId ? trackers.find(t => t.chatId.toString() === adminChatId) : null;
                        const otherTrackers = adminChatId ? trackers.filter(t => t.chatId.toString() !== adminChatId) : trackers;

                        // Admin goes first
                        if (adminTracker) {
                            console.log(`  👑 Processing ADMIN user ${adminTracker.userId} first...`);
                            try {
                                await mintTask(adminTracker);
                            } catch (err: any) {
                                console.error(`  ❌ Admin mint error: ${err.message}`);
                            }
                        }

                        // Everyone else fires simultaneously
                        if (otherTrackers.length > 0) {
                            console.log(`  🚀 Firing ${otherTrackers.length} mint(s) in parallel...`);
                            const results = await Promise.allSettled(
                                otherTrackers.map(tracker => mintTask(tracker).catch(err => {
                                    console.error(`  ❌ Error for user ${tracker.userId}: ${err.message}`);
                                }))
                            );
                            const succeeded = results.filter(r => r.status === 'fulfilled').length;
                            const failed = results.filter(r => r.status === 'rejected').length;
                            console.log(`  📊 Parallel results: ${succeeded} sent, ${failed} failed`);
                        }
                    }
                }

                lastCheckedBlock[chain.name] = currentBlock;
                cleanupProcessedTxs();

            } catch (err: any) {
                console.error(`[${chain.name}] Error in monitoring loop: ${err.message}`);
            }
        }, chain.pollInterval);
    });
}
