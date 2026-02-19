// @ts-nocheck force update v4 — multi-key + websocket + multi-chain
import { ethers } from 'ethers';
import { config } from './config';
import { store } from './store';
import { attemptMintAllKeys } from './mint';
import { Bot } from 'grammy';
import { isLikelyNFTMint, getFilterReason } from './filters';

// ─── Chain Configuration ───

interface ChainConfig {
    name: string;
    rpcUrls: string[];
    wsUrl: string;          // WebSocket URL (empty = polling only)
    pollInterval: number;   // ms between polls (fallback when WS active)
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
        wsUrl: config.wsUrl,
        pollInterval: 12000,
    },
    {
        name: 'BASE',
        rpcUrls: [
            config.rpcUrlBase,
            'https://base-rpc.publicnode.com',
            'https://rpc.ankr.com/base',
        ].filter(Boolean),
        wsUrl: config.wsUrlBase,
        pollInterval: 5000,
    },
    {
        name: 'ARB',
        rpcUrls: [
            config.rpcUrlArb,
            'https://arbitrum-one-rpc.publicnode.com',
            'https://rpc.ankr.com/arbitrum',
        ].filter(Boolean),
        wsUrl: config.wsUrlArb,
        pollInterval: 3000,
    },
    {
        name: 'OP',
        rpcUrls: [
            config.rpcUrlOp,
            'https://optimism-rpc.publicnode.com',
            'https://rpc.ankr.com/optimism',
        ].filter(Boolean),
        wsUrl: config.wsUrlOp,
        pollInterval: 4000,
    },
    {
        name: 'POLY',
        rpcUrls: [
            config.rpcUrlPoly,
            'https://polygon-bor-rpc.publicnode.com',
            'https://rpc.ankr.com/polygon',
        ].filter(Boolean),
        wsUrl: config.wsUrlPoly,
        pollInterval: 5000,
    }
];

// ─── State ───

const lastCheckedBlock: Record<string, number> = {};
const processedTxs = new Set<string>();
const MAX_PROCESSED_TXS = 5000;

const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || '6588909371';
const BATCH_SIZE = 20;
const BATCH_DELAY_MS = 50;

// Track active WebSocket connections for reconnection
const activeWsConnections: Record<string, ethers.WebSocketProvider | null> = {};

// ─── RPC Helpers ───

async function rpcCallWithRetry<T>(
    rpcUrls: string[],
    action: (provider: ethers.JsonRpcProvider) => Promise<T>,
    chainName: string,
    maxRetries = 3
): Promise<T> {
    let lastError: any;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        const rpcUrl = rpcUrls[attempt % rpcUrls.length];
        const provider = new ethers.JsonRpcProvider(rpcUrl);
        try {
            return await action(provider);
        } catch (err: any) {
            lastError = err;
            const isRetryable = err.message?.includes('ECONNRESET') ||
                err.message?.includes('ETIMEDOUT') ||
                err.message?.includes('rate limit') ||
                err.message?.includes('429');
            if (isRetryable && attempt < maxRetries - 1) {
                await sleep(Math.min(1000 * (attempt + 1), 3000));
            } else {
                throw err;
            }
        }
    }
    throw lastError;
}

function sleep(ms: number) {
    return new Promise(r => setTimeout(r, ms));
}

// ─── Wallet Map ───

function buildWalletMap() {
    const map = new Map<string, Array<{ userId: string; chatId: number; username: string | null }>>();
    const allUsers = store.getAllUsers();

    for (const { userId, data: userData } of allUsers) {
        for (const wallet of userData.trackedWallets) {
            const addr = wallet.address.toLowerCase();
            if (!map.has(addr)) map.set(addr, []);
            map.get(addr)!.push({
                userId,
                chatId: userData.chatId,
                username: userData.username,
            });
        }
    }
    return map;
}

// ─── Cleanup ───

function cleanupProcessedTxs() {
    if (processedTxs.size > MAX_PROCESSED_TXS) {
        const entries = Array.from(processedTxs);
        const toRemove = entries.slice(0, entries.length - 1000);
        toRemove.forEach(hash => processedTxs.delete(hash));
        console.log(`🧹 Cleaned up ${toRemove.length} old tx hashes`);
    }
}

// ─── Admin Social Feed ───

async function notifyAdminFeed(
    bot: Bot,
    chainName: string,
    trackedAddress: string,
    contractAddress: string,
    txHash: string,
    trackerCount: number
) {
    if (!ADMIN_CHAT_ID) return;

    const walletName = getTrackedWalletName(trackedAddress);
    const label = walletName ? `"${walletName}"` : trackedAddress.substring(0, 12) + '...';

    try {
        const explorerBase = chainName === 'BASE' ? 'basescan.org' :
            chainName === 'ARB' ? 'arbiscan.io' :
                chainName === 'OP' ? 'optimistic.etherscan.io' :
                    chainName === 'POLY' ? 'polygonscan.com' : 'etherscan.io';

        await bot.api.sendMessage(parseInt(ADMIN_CHAT_ID),
            `📡 *Alpha Feed* (${chainName})\n\n` +
            `Wallet ${label} minted!\n` +
            `Contract: \`${contractAddress}\`\n` +
            `[View TX](https://${explorerBase}/tx/${txHash})\n` +
            `Tracked by: ${trackerCount} user(s)`,
            { parse_mode: "Markdown", link_preview_options: { is_disabled: true } }
        );
    } catch { }
}

/** Look up a friendly name for a tracked address across all users */
function getTrackedWalletName(address: string): string | null {
    const allUsers = store.getAllUsers();
    for (const { data } of allUsers) {
        for (const w of data.trackedWallets) {
            if (w.address.toLowerCase() === address.toLowerCase() && w.name) {
                return w.name;
            }
        }
    }
    return null;
}

// ─── Batch Processing ───

async function processMintBatches(
    tasks: Array<() => Promise<void>>,
    chainName: string
) {
    if (tasks.length === 0) return;
    for (let i = 0; i < tasks.length; i += BATCH_SIZE) {
        const batch = tasks.slice(i, i + BATCH_SIZE);
        const batchNum = Math.floor(i / BATCH_SIZE) + 1;
        const totalBatches = Math.ceil(tasks.length / BATCH_SIZE);
        console.log(`[${chainName}]   📦 Batch ${batchNum}/${totalBatches}: ${batch.length} task(s)`);
        await Promise.allSettled(batch.map(task => task()));
        if (i + BATCH_SIZE < tasks.length) await sleep(BATCH_DELAY_MS);
    }
}

// ─── Core Block Processing ───

async function processBlock(chain: ChainConfig, blockNum: number, bot: Bot) {
    const walletMap = buildWalletMap();
    if (walletMap.size === 0) return;

    let block;
    try {
        block = await rpcCallWithRetry(
            chain.rpcUrls,
            (provider) => provider.getBlock(blockNum, true),
            chain.name
        );
    } catch (err: any) {
        console.error(`[${chain.name}] Failed to fetch block ${blockNum}: ${err.message}`);
        return;
    }

    if (!block || !block.prefetchedTransactions) return;

    for (const tx of block.prefetchedTransactions) {
        const fromAddr = tx.from.toLowerCase();
        const trackers = walletMap.get(fromAddr);
        if (!trackers) continue;

        const txKey = tx.hash;
        if (processedTxs.has(txKey)) continue;

        console.log(`[${chain.name}] 🎯 TX from tracked wallet ${fromAddr.substring(0, 10)}... (${tx.hash.substring(0, 14)}...)`);

        if (!tx.data || tx.data === '0x') {
            processedTxs.add(txKey);
            continue;
        }
        if (!tx.to) {
            processedTxs.add(txKey);
            continue;
        }
        if (!isLikelyNFTMint(tx.data)) {
            const reason = getFilterReason(tx.data);
            console.log(`  ⏭️ Filtered: ${reason}`);
            processedTxs.add(txKey);
            continue;
        }

        console.log(`  ✅ NFT Mint detected! ${trackers.length} user(s)`);
        processedTxs.add(txKey);

        // Admin social feed notification
        notifyAdminFeed(bot, chain.name, fromAddr, tx.to, tx.hash, trackers.length);

        // Separate admin from others
        const adminTracker = ADMIN_CHAT_ID
            ? trackers.find(t => t.chatId.toString() === ADMIN_CHAT_ID)
            : null;
        const otherTrackers = ADMIN_CHAT_ID
            ? trackers.filter(t => t.chatId.toString() !== ADMIN_CHAT_ID)
            : trackers;

        // ADMIN PRIORITY: fire admin's keys first
        if (adminTracker) {
            const userLabel = adminTracker.username
                ? `@${adminTracker.username} (${adminTracker.userId})`
                : `user ${adminTracker.userId}`;
            console.log(`  👑 ADMIN ${userLabel} first...`);

            const keys = store.getAllDecryptedKeys(adminTracker.userId);
            if (keys.length > 0) {
                try {
                    await attemptMintAllKeys({
                        originalTx: tx, bot,
                        chatId: adminTracker.chatId,
                        chainName: chain.name,
                        keys, rpcUrl: chain.rpcUrls[0],
                        userLabel, userId: adminTracker.userId,
                    });
                } catch (err: any) {
                    console.error(`  ❌ Admin error: ${err.message}`);
                }
            }
        }

        // Everyone else in staggered batches
        if (otherTrackers.length > 0) {
            const mintTasks: Array<() => Promise<void>> = [];

            for (const tracker of otherTrackers) {
                const keys = store.getAllDecryptedKeys(tracker.userId);
                if (keys.length === 0) continue;

                const userLabel = tracker.username
                    ? `@${tracker.username} (${tracker.userId})`
                    : `user ${tracker.userId}`;

                mintTasks.push(async () => {
                    try {
                        await attemptMintAllKeys({
                            originalTx: tx, bot,
                            chatId: tracker.chatId,
                            chainName: chain.name,
                            keys, rpcUrl: chain.rpcUrls[0],
                            userLabel, userId: tracker.userId,
                        });
                    } catch (err: any) {
                        console.error(`  ❌ ${userLabel}: ${err.message}`);
                    }
                });
            }

            await processMintBatches(mintTasks, chain.name);
        }
    }
}

// ─── WebSocket Listener ───

function startWebSocketListener(chain: ChainConfig, bot: Bot) {
    if (!chain.wsUrl) return;

    console.log(`  ⚡ [${chain.name}] Starting WebSocket subscription: ${chain.wsUrl.substring(0, 45)}...`);

    let wsProvider: ethers.WebSocketProvider;

    const connect = () => {
        try {
            wsProvider = new ethers.WebSocketProvider(chain.wsUrl);
            activeWsConnections[chain.name] = wsProvider;

            wsProvider.on('block', async (blockNumber: number) => {
                // Skip if we already processed this block via polling
                const lastBlock = lastCheckedBlock[chain.name] || 0;
                if (blockNumber <= lastBlock) return;

                console.log(`[${chain.name}] ⚡ WS block ${blockNumber}`);

                try {
                    await processBlock(chain, blockNumber, bot);
                    lastCheckedBlock[chain.name] = blockNumber;
                    cleanupProcessedTxs();
                } catch (err: any) {
                    console.error(`[${chain.name}] WS block error: ${err.message}`);
                }
            });

            wsProvider.on('error', (err: any) => {
                console.error(`[${chain.name}] ⚠️ WS error: ${err.message}`);
            });

            // Monitor for disconnection and reconnect
            const ws = (wsProvider as any)._websocket || (wsProvider as any).websocket;
            if (ws) {
                ws.on('close', () => {
                    console.log(`[${chain.name}] 🔌 WS disconnected, reconnecting in 5s...`);
                    activeWsConnections[chain.name] = null;
                    setTimeout(connect, 5000);
                });
            }

        } catch (err: any) {
            console.error(`[${chain.name}] ❌ WS connection failed: ${err.message}. Falling back to polling.`);
            activeWsConnections[chain.name] = null;
        }
    };

    connect();
}

// ─── Polling Fallback ───

function startPollingListener(chain: ChainConfig, bot: Bot) {
    setInterval(async () => {
        try {
            const walletMap = buildWalletMap();
            if (walletMap.size === 0) return;

            const currentBlock = await rpcCallWithRetry(
                chain.rpcUrls,
                (provider) => provider.getBlockNumber(),
                chain.name
            );

            const lastBlock = lastCheckedBlock[chain.name] || currentBlock - 1;
            if (currentBlock <= lastBlock) return;

            const startBlock = Math.max(lastBlock + 1, currentBlock - 2);

            for (let blockNum = startBlock; blockNum <= currentBlock; blockNum++) {
                console.log(`[${chain.name}] Checking block ${blockNum}...`);
                await processBlock(chain, blockNum, bot);
            }

            lastCheckedBlock[chain.name] = currentBlock;
            cleanupProcessedTxs();

        } catch (err: any) {
            console.error(`[${chain.name}] Poll error: ${err.message}`);
        }
    }, chain.pollInterval);
}

// ─── Entry Point ───

export function startMonitoring(bot: Bot) {
    console.log("👀 Starting Blockchain Monitors (v4 — Multi-Key + WebSocket + Multi-Chain)...");

    chains.forEach(chain => {
        if (chain.rpcUrls.length === 0) {
            console.warn(`⚠️ No RPC URLs for ${chain.name}, skipping.`);
            return;
        }

        const mode = chain.wsUrl ? 'WebSocket + Polling fallback' : 'Polling only';
        console.log(`✅ [${chain.name}] ${mode} (${chain.rpcUrls.length} RPCs, ${chain.pollInterval / 1000}s poll)`);

        // Start WebSocket if URL provided (primary, faster)
        if (chain.wsUrl) {
            startWebSocketListener(chain, bot);
        }

        // Always start polling as fallback (or primary if no WS)
        startPollingListener(chain, bot);
    });
}
