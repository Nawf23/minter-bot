// @ts-nocheck v5 — Alchemy filtered pending tx subscriptions + lightweight fallback
import { ethers } from 'ethers';
import WebSocket from 'ws';
import { config } from './config';
import { store } from './store';
import { attemptMintAllKeys } from './mint';
import { Bot } from 'grammy';
import { isLikelyNFTMint } from './filters';
import { getSharedProvider } from './rpc_utils';

// ─── Chain Configuration ───

interface ChainConfig {
    name: string;
    rpcUrls: string[];
    alchemyWsUrl: string;    // Alchemy WebSocket URL for filtered pending txs
    wsUrl: string;            // Generic WebSocket URL (fallback)
    pollInterval: number;     // ms between fallback polls
}

const chains: ChainConfig[] = [
    {
        name: 'ETH',
        rpcUrls: [
            config.rpcUrl,
            'https://ethereum-rpc.publicnode.com',
            'https://rpc.ankr.com/eth',
        ].filter(Boolean),
        alchemyWsUrl: config.alchemyWsEth,
        wsUrl: config.wsUrl,
        pollInterval: 30000,  // 30s fallback (Alchemy handles real-time)
    },
    {
        name: 'BASE',
        rpcUrls: [
            config.rpcUrlBase,
            'https://base-rpc.publicnode.com',
            'https://rpc.ankr.com/base',
        ].filter(Boolean),
        alchemyWsUrl: config.alchemyWsBase,
        wsUrl: config.wsUrlBase,
        pollInterval: 30000,
    },
    {
        name: 'POLY',
        rpcUrls: [
            config.rpcUrlPoly,
            'https://polygon-bor-rpc.publicnode.com',
            'https://rpc.ankr.com/polygon',
        ].filter(Boolean),
        alchemyWsUrl: config.alchemyWsPoly,
        wsUrl: config.wsUrlPoly,
        pollInterval: 30000,
    }
];

// ─── State ───

const processedTxs = new Set<string>();
const MAX_PROCESSED_TXS = 5000;
const lastCheckedBlock: Record<string, number> = {};

const ADMIN_ID = (process.env.ADMIN_USER_ID || '').trim();
const BATCH_SIZE = 5;
const BATCH_DELAY_MS = 200;

// Track active Alchemy subscriptions for resubscription
const alchemyConnections: Record<string, WebSocket | null> = {};
let lastKnownDataVersion = -1;

// ─── Wallet Map ───

let cachedWalletMap: Map<string, Array<{ userId: string; chatId: number; username: string | null }>> | null = null;

function getWalletMap() {
    if (cachedWalletMap && store.dataVersion === lastKnownDataVersion) {
        return cachedWalletMap;
    }

    console.log(`🧠 Rebuilding wallet map (version ${store.dataVersion})...`);
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

    cachedWalletMap = map;
    lastKnownDataVersion = store.dataVersion;
    return map;
}

function getTrackedAddresses(): string[] {
    const walletMap = getWalletMap();
    return Array.from(walletMap.keys());
}

// ─── Helpers ───

function sleep(ms: number) {
    return new Promise(r => setTimeout(r, ms));
}

function cleanupProcessedTxs() {
    if (processedTxs.size > MAX_PROCESSED_TXS + 500) {
        const entries = Array.from(processedTxs);
        const toRemove = entries.slice(0, entries.length - MAX_PROCESSED_TXS);
        toRemove.forEach(hash => processedTxs.delete(hash));
    }
}

async function rpcCallWithRetry<T>(
    rpcUrls: string[],
    action: (provider: ethers.JsonRpcProvider) => Promise<T>,
    chainName: string,
    maxRetries = 3
): Promise<T> {
    let lastError: any;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        const rpcUrl = rpcUrls[attempt % rpcUrls.length];
        const provider = getSharedProvider(rpcUrl);
        try {
            return await action(provider);
        } catch (err: any) {
            lastError = err;
            const isRetryable = err.message?.includes('ECONNRESET') ||
                err.message?.includes('ETIMEDOUT') ||
                err.message?.includes('rate limit') ||
                err.message?.includes('429') ||
                err.message?.includes('failed to detect network');
            if (isRetryable && attempt < maxRetries - 1) {
                await sleep(Math.min(1000 * (attempt + 1), 3000));
            } else {
                throw err;
            }
        }
    }
    throw lastError;
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

// ─── Process a Single Transaction ───

async function processTx(chain: ChainConfig, tx: any, bot: Bot, source: string) {
    if (!tx || !tx.hash || !tx.from) return;

    const txKey = tx.hash;
    if (processedTxs.has(txKey)) return;

    const fromAddr = tx.from.toLowerCase();
    const walletMap = getWalletMap();
    const trackers = walletMap.get(fromAddr);
    if (!trackers) return;

    console.log(`[${chain.name}] 🎯 ${source} TX from tracked wallet ${fromAddr.substring(0, 10)}... (${tx.hash.substring(0, 14)}...)`);

    // Skip if no calldata
    if (!tx.input || tx.input === '0x') {
        processedTxs.add(txKey);
        return;
    }
    if (!tx.to) {
        processedTxs.add(txKey);
        return;
    }

    // Use tx.input (Alchemy format) or tx.data (ethers format)
    const txData = tx.input || tx.data || '';

    if (!isLikelyNFTMint(txData)) {
        processedTxs.add(txKey);
        return;
    }

    console.log(`  ✅ NFT Mint detected via ${source}! ${trackers.length} user(s)`);
    processedTxs.add(txKey);

    // Normalize tx for attemptMintAllKeys (needs ethers TransactionResponse shape)
    const normalizedTx = {
        hash: tx.hash,
        from: tx.from,
        to: tx.to,
        data: txData,
        value: BigInt(tx.value || '0'),
    };

    // Separate admin from others
    const adminTracker = ADMIN_ID
        ? trackers.find(t => t.chatId.toString().trim() === ADMIN_ID || t.userId.toString().trim() === ADMIN_ID)
        : null;
    const otherTrackers = ADMIN_ID
        ? trackers.filter(t => t.chatId.toString().trim() !== ADMIN_ID && t.userId.toString().trim() !== ADMIN_ID)
        : trackers;

    // ADMIN PRIORITY
    if (adminTracker) {
        const userLabel = adminTracker.username
            ? `@${adminTracker.username} (${adminTracker.userId})`
            : `user ${adminTracker.userId}`;
        console.log(`  👑 ADMIN PRIORITY: ${userLabel} triggered first.`);

        const keys = store.getAllDecryptedKeys(adminTracker.userId);
        if (keys.length > 0) {
            try {
                await attemptMintAllKeys({
                    originalTx: normalizedTx as any, bot,
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

    // Everyone else
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
                        originalTx: normalizedTx as any, bot,
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

// ─── Alchemy Filtered Pending TX Subscription ───

function startAlchemyListener(chain: ChainConfig, bot: Bot) {
    if (!chain.alchemyWsUrl) return;

    const addresses = getTrackedAddresses();
    if (addresses.length === 0) {
        console.log(`  ⏭️ [${chain.name}] No tracked wallets, skipping Alchemy subscription`);
        return;
    }

    console.log(`  ⚡ [${chain.name}] Starting Alchemy filtered subscription (${addresses.length} wallets)`);

    const connect = () => {
        try {
            // Clean up old connection
            if (alchemyConnections[chain.name]) {
                try { alchemyConnections[chain.name]!.close(); } catch { }
            }

            const ws = new WebSocket(chain.alchemyWsUrl);
            alchemyConnections[chain.name] = ws;

            ws.on('open', () => {
                console.log(`[${chain.name}] ✅ Alchemy WebSocket connected`);

                // Subscribe to pending transactions from tracked wallets only
                const subRequest = {
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'eth_subscribe',
                    params: [
                        'alchemy_pendingTransactions',
                        {
                            fromAddress: addresses,
                            toAddress: [],
                            hashesOnly: false,  // Get full tx data
                        }
                    ]
                };

                ws.send(JSON.stringify(subRequest));
                console.log(`[${chain.name}] 📡 Subscribed to pending txs from ${addresses.length} wallets`);
            });

            ws.on('message', async (data: Buffer) => {
                try {
                    const msg = JSON.parse(data.toString());

                    // Subscription confirmation
                    if (msg.id === 1 && msg.result) {
                        console.log(`[${chain.name}] ✅ Subscription active: ${msg.result}`);
                        return;
                    }

                    // Pending transaction notification
                    if (msg.method === 'eth_subscription' && msg.params?.result) {
                        const tx = msg.params.result;
                        console.log(`[${chain.name}] ⚡ MEMPOOL: Pending tx from ${tx.from?.substring(0, 10)}...`);
                        await processTx(chain, tx, bot, 'MEMPOOL');
                        cleanupProcessedTxs();
                    }
                } catch (err: any) {
                    console.error(`[${chain.name}] Alchemy WS parse error: ${err.message}`);
                }
            });

            ws.on('error', (err: any) => {
                console.error(`[${chain.name}] ⚠️ Alchemy WS error: ${err.message}`);
            });

            ws.on('close', () => {
                console.log(`[${chain.name}] 🔌 Alchemy WS disconnected, reconnecting in 5s...`);
                alchemyConnections[chain.name] = null;
                setTimeout(connect, 5000);
            });

        } catch (err: any) {
            console.error(`[${chain.name}] ❌ Alchemy WS connection failed: ${err.message}`);
            alchemyConnections[chain.name] = null;
            setTimeout(connect, 10000);
        }
    };

    connect();
}

// ─── Resubscribe When Wallets Change ───

function startWalletChangeWatcher(bot: Bot) {
    let lastVersion = store.dataVersion;

    setInterval(() => {
        if (store.dataVersion !== lastVersion) {
            lastVersion = store.dataVersion;
            console.log('🔄 Wallet list changed, resubscribing Alchemy listeners...');

            // Rebuild cached wallet map
            cachedWalletMap = null;
            lastKnownDataVersion = -1;

            // Reconnect all Alchemy listeners with updated addresses
            for (const chain of chains) {
                if (chain.alchemyWsUrl) {
                    startAlchemyListener(chain, bot);
                }
            }
        }
    }, 2000); // Check every 2 seconds
}

// ─── Lightweight Polling Fallback ───
// Only activates for chains WITHOUT Alchemy, or as a safety net
// Uses getBlock(blockNum, true) but polls much less frequently (every 30s)

function startPollingFallback(chain: ChainConfig, bot: Bot) {
    const interval = chain.alchemyWsUrl ? chain.pollInterval : 12000; // Faster if no Alchemy
    const mode = chain.alchemyWsUrl ? 'safety-net' : 'primary';

    console.log(`  📡 [${chain.name}] Polling fallback (${mode}, every ${interval / 1000}s)`);

    setInterval(async () => {
        try {
            const walletMap = getWalletMap();
            if (walletMap.size === 0) return;

            const currentBlock = await rpcCallWithRetry(
                chain.rpcUrls,
                (provider) => provider.getBlockNumber(),
                chain.name
            );

            const lastBlock = lastCheckedBlock[chain.name] || currentBlock - 1;
            if (currentBlock <= lastBlock) return;

            // Only check latest block (not gap-filling — Alchemy handles that)
            lastCheckedBlock[chain.name] = currentBlock;

            const block = await rpcCallWithRetry(
                chain.rpcUrls,
                (provider) => provider.getBlock(currentBlock, true),
                chain.name
            );

            if (!block || !block.prefetchedTransactions) return;

            let found = 0;
            for (const tx of block.prefetchedTransactions) {
                const fromAddr = tx.from.toLowerCase();
                if (!walletMap.has(fromAddr)) continue;
                found++;
                await processTx(chain, {
                    hash: tx.hash,
                    from: tx.from,
                    to: tx.to,
                    input: tx.data,
                    value: tx.value.toString(),
                }, bot, 'POLL');
            }

            if (found > 0) {
                console.log(`[${chain.name}] 📡 Poll caught ${found} tracked tx(s) in block ${currentBlock}`);
            }

            cleanupProcessedTxs();
        } catch (err: any) {
            if (!err.message?.includes('429') && !err.message?.includes('rate limit')) {
                console.error(`[${chain.name}] Poll error: ${err.message}`);
            }
        }
    }, interval);
}

// ─── Memory Monitor ───

function startMemoryMonitor() {
    setInterval(() => {
        const used = process.memoryUsage();
        const heapUsed = Math.round(used.heapUsed / 1024 / 1024);
        const rss = Math.round(used.rss / 1024 / 1024);

        const RAILWAY_LIMIT_MB = 2048;
        const usagePercent = (rss / RAILWAY_LIMIT_MB) * 100;

        let status = '🟢 GOOD';
        if (usagePercent > 85) status = '🔴 CRITICAL';
        else if (usagePercent > 70) status = '🟡 HIGH';

        console.log(`📊 [${status}] Memory: Heap ${heapUsed}MB | RSS ${rss}MB (${Math.round(usagePercent)}%) | ${chains.length} chains`);

        if (usagePercent > 92) {
            console.warn('🚨 MEMORY CRITICAL! Triggering emergency cleanup...');
            if (global.gc) global.gc();
        }
    }, 60000);
}

// ─── Graceful Shutdown ───

function setupShutdownHandlers() {
    const cleanup = (signal: string) => {
        console.log(`🛑 [${signal}] Shutting down...`);
        // Close all Alchemy WebSocket connections
        for (const [name, ws] of Object.entries(alchemyConnections)) {
            if (ws) {
                try { ws.close(); } catch { }
                console.log(`  🔌 Closed Alchemy WS for ${name}`);
            }
        }
        process.exit(0);
    };

    process.on('SIGTERM', () => cleanup('SIGTERM'));
    process.on('SIGINT', () => cleanup('SIGINT'));
}

// ─── Entry Point ───

export function startMonitoring(bot: Bot) {
    console.log("👀 Starting Blockchain Monitors (v5.0 — Alchemy Filtered Subscriptions)...");

    startMemoryMonitor();
    setupShutdownHandlers();

    const trackedCount = getTrackedAddresses().length;
    console.log(`📋 Tracking ${trackedCount} wallet(s) across ${chains.length} chain(s)`);

    chains.forEach(chain => {
        if (chain.rpcUrls.length === 0) {
            console.warn(`⚠️ No RPC URLs for ${chain.name}, skipping.`);
            return;
        }

        if (chain.alchemyWsUrl) {
            console.log(`✅ [${chain.name}] Alchemy filtered subscription + polling fallback`);
            startAlchemyListener(chain, bot);
        } else {
            console.log(`⚠️ [${chain.name}] No Alchemy WS — using polling only`);
        }

        // Always start polling as fallback
        startPollingFallback(chain, bot);
    });

    // Watch for wallet changes and resubscribe
    startWalletChangeWatcher(bot);
}
