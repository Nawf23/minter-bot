// @ts-nocheck v5.1 — CU-optimized Alchemy subscriptions
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
    alchemyWsUrl: string;
    wsUrl: string;
    pollInterval: number;
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
        pollInterval: 15000,  // 15s — fast fallback for missed WS events
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
        pollInterval: 10000,
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
        pollInterval: 10000,
    }
];

// ─── State ───

const processedTxs = new Set<string>();
const MAX_PROCESSED_TXS = 5000;
const lastCheckedBlock: Record<string, number> = {};

const ADMIN_ID = (process.env.ADMIN_USER_ID || '').trim();
const BATCH_SIZE = 5;
const BATCH_DELAY_MS = 200;

// Alchemy connections
const alchemyConnections: Record<string, WebSocket | null> = {};
const alchemySubscriptionIds: Record<string, string | null> = {};
const alchemyHealthy: Record<string, boolean> = {};  // Track WS health to skip polling
let lastKnownDataVersion = -1;

// ─── CU Tracking ───
let cuEstimate = 0;
const CU_HASH_NOTIFICATION = 50;   // hashesOnly notification
const CU_GET_TX = 17;              // eth_getTransactionByHash
const CU_GET_BLOCK = 16;           // eth_getBlockByNumber
const CU_GET_BLOCK_NUM = 10;       // eth_blockNumber

// ─── No Cooldowns (Full Mempool Stream) ───

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

// ─── Process a Full Transaction ───

async function processTx(chain: ChainConfig, tx: any, bot: Bot, source: string) {
    if (!tx || !tx.hash || !tx.from) return;

    const txKey = tx.hash;
    if (processedTxs.has(txKey)) return;

    const fromAddr = tx.from.toLowerCase();
    const walletMap = getWalletMap();
    const trackers = walletMap.get(fromAddr);
    if (!trackers) return;

    // Skip if no calldata or no target
    const txData = tx.input || tx.data || '';
    if (!txData || txData === '0x' || !tx.to) {
        processedTxs.add(txKey);
        return;
    }

    if (!isLikelyNFTMint(txData)) {
        processedTxs.add(txKey);
        return;
    }

    console.log(`[${chain.name}] ✅ MINT detected via ${source}! ${trackers.length} user(s) — ${tx.hash.substring(0, 14)}...`);
    processedTxs.add(txKey);

    // Normalize tx
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

// ─── Alchemy Filtered Pending TX Subscription (hashesOnly mode) ───

function resubscribeAlchemy(chain: ChainConfig) {
    const ws = alchemyConnections[chain.name];
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const addresses = getTrackedAddresses();
    if (addresses.length === 0) {
        console.log(`  ⏭️ [${chain.name}] No tracked wallets, skipping Alchemy subscription`);
        return;
    }

    // Unsubscribe from old filter if one exists
    const oldSubId = alchemySubscriptionIds[chain.name];
    if (oldSubId) {
        ws.send(JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'eth_unsubscribe',
            params: [oldSubId]
        }));
        alchemySubscriptionIds[chain.name] = null;
    }

    const subRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_subscribe',
        params: [
            'alchemy_pendingTransactions',
            {
                fromAddress: addresses,
                toAddress: [],
                hashesOnly: true,
            }
        ]
    };

    ws.send(JSON.stringify(subRequest));
    console.log(`[${chain.name}] 📡 Subscribed to filtered stream for ${addresses.length} tracking wallets`);
}

function startAlchemyListener(chain: ChainConfig, bot: Bot) {
    if (!chain.alchemyWsUrl) return;

    const connect = () => {
        try {
            if (alchemyConnections[chain.name]) {
                if (alchemyConnections[chain.name]!.readyState === WebSocket.OPEN) {
                    resubscribeAlchemy(chain);
                    return;
                }
                try { alchemyConnections[chain.name]!.close(); } catch { }
            }

            const ws = new WebSocket(chain.alchemyWsUrl);
            alchemyConnections[chain.name] = ws;

            ws.on('open', () => {
                console.log(`[${chain.name}] ✅ Alchemy WebSocket connected`);
                alchemyHealthy[chain.name] = true;
                resubscribeAlchemy(chain);
            });

            ws.on('message', async (data: Buffer) => {
                try {
                    const msg = JSON.parse(data.toString());

                    // Subscription confirmation
                    if (msg.id === 1 && msg.result) {
                        console.log(`[${chain.name}] ✅ Subscription active: ${msg.result}`);
                        alchemySubscriptionIds[chain.name] = msg.result;
                        return;
                    }

                    // Unsubscribe confirmation
                    if (msg.id === 2 && msg.result) {
                        return; // Successfully unsubscribed from old filter
                    }

                    // Pending tx hash notification (hashesOnly mode)
                    if (msg.method === 'eth_subscription' && msg.params?.result) {
                        const txHash = msg.params.result;
                        cuEstimate += CU_HASH_NOTIFICATION;

                        if (typeof txHash !== 'string' || !txHash.startsWith('0x')) return;

                        // Skip if already processed
                        if (processedTxs.has(txHash)) return;

                        // Fetch full tx from Alchemy HTTP (fast, has pending pool)
                        try {
                            cuEstimate += CU_GET_TX;
                            const provider = getSharedProvider(chain.rpcUrls[0]);
                            const tx = await provider.getTransaction(txHash);
                            if (!tx || !tx.from) return;

                            const fromAddr = tx.from.toLowerCase();

                            console.log(`[${chain.name}] ⚡ MEMPOOL: ${fromAddr.substring(0, 10)}... (${txHash.substring(0, 14)}...)`);

                            await processTx(chain, {
                                hash: tx.hash,
                                from: tx.from,
                                to: tx.to,
                                input: tx.data,
                                value: tx.value.toString(),
                            }, bot, 'MEMPOOL');

                            cleanupProcessedTxs();
                        } catch (fetchErr: any) {
                            // Silently skip fetch failures — polling will catch it
                        }
                    }
                } catch (err: any) {
                    console.error(`[${chain.name}] Alchemy WS parse error: ${err.message}`);
                }
            });

            ws.on('error', (err: any) => {
                console.error(`[${chain.name}] ⚠️ Alchemy WS error: ${err.message}`);
                alchemyHealthy[chain.name] = false;
            });

            ws.on('close', () => {
                console.log(`[${chain.name}] 🔌 Alchemy WS disconnected, reconnecting in 5s...`);
                alchemyConnections[chain.name] = null;
                alchemyHealthy[chain.name] = false;
                setTimeout(connect, 5000);
            });

        } catch (err: any) {
            console.error(`[${chain.name}] ❌ Alchemy WS connection failed: ${err.message}`);
            alchemyConnections[chain.name] = null;
            alchemyHealthy[chain.name] = false;
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

            cachedWalletMap = null;
            lastKnownDataVersion = -1;

            for (const chain of chains) {
                if (chain.alchemyWsUrl) {
                    if (alchemyConnections[chain.name] && alchemyConnections[chain.name]!.readyState === WebSocket.OPEN) {
                        resubscribeAlchemy(chain);
                    } else {
                        startAlchemyListener(chain, bot);
                    }
                }
            }
        }
    }, 2000);
}

// ─── Lightweight Polling Fallback ───
// ONLY runs when Alchemy WS is disconnected, or every 60s as a safety net
// Uses FREE public RPCs (not Alchemy)

function startPollingFallback(chain: ChainConfig, bot: Bot) {
    const mode = chain.alchemyWsUrl ? 'safety-net' : 'primary';
    const interval = chain.alchemyWsUrl ? chain.pollInterval : 12000;

    // Filter out Alchemy URLs from polling — only use free RPCs
    const freeRpcUrls = chain.rpcUrls.filter(url => !url.includes('alchemy.com'));
    if (freeRpcUrls.length === 0) {
        console.log(`  ⚠️ [${chain.name}] No free RPCs for polling, using all RPCs`);
        freeRpcUrls.push(...chain.rpcUrls);
    }

    console.log(`  📡 [${chain.name}] Polling fallback (${mode}, every ${interval / 1000}s, ${freeRpcUrls.length} free RPCs)`);

    setInterval(async () => {
        try {
            // ALWAYS poll as safety net — WS can silently drop transactions.
            // processedTxs set prevents duplicate processing.

            const walletMap = getWalletMap();
            if (walletMap.size === 0) return;

            const currentBlock = await rpcCallWithRetry(
                freeRpcUrls,
                (provider) => provider.getBlockNumber(),
                chain.name
            );

            const lastBlock = lastCheckedBlock[chain.name] || currentBlock - 1;
            if (currentBlock <= lastBlock) return;

            // Scan ALL blocks since last check (cap at 10 to avoid RPC abuse)
            const MAX_BLOCKS_PER_POLL = 10;
            const startBlock = Math.max(lastBlock + 1, currentBlock - MAX_BLOCKS_PER_POLL + 1);
            lastCheckedBlock[chain.name] = currentBlock;

            let totalFound = 0;
            for (let blockNum = startBlock; blockNum <= currentBlock; blockNum++) {
                try {
                    const block = await rpcCallWithRetry(
                        freeRpcUrls,
                        (provider) => provider.getBlock(blockNum, true),
                        chain.name
                    );

                    if (!block || !block.prefetchedTransactions) continue;

                    for (const tx of block.prefetchedTransactions) {
                        const fromAddr = tx.from.toLowerCase();
                        if (!walletMap.has(fromAddr)) continue;
                        totalFound++;
                        await processTx(chain, {
                            hash: tx.hash,
                            from: tx.from,
                            to: tx.to,
                            input: tx.data,
                            value: tx.value.toString(),
                        }, bot, 'POLL');
                    }
                } catch (blockErr: any) {
                    // Skip individual block errors, continue with next
                    if (!blockErr.message?.includes('429') && !blockErr.message?.includes('rate limit')) {
                        console.error(`[${chain.name}] Poll block ${blockNum} error: ${blockErr.message}`);
                    }
                }
            }

            if (totalFound > 0) {
                console.log(`[${chain.name}] 📡 Poll caught ${totalFound} tracked tx(s) in blocks ${startBlock}-${currentBlock}`);
            }

            cleanupProcessedTxs();
        } catch (err: any) {
            if (!err.message?.includes('429') && !err.message?.includes('rate limit')) {
                console.error(`[${chain.name}] Poll error: ${err.message}`);
            }
        }
    }, interval);
}

// ─── Memory & CU Monitor ───

function startMonitors() {
    setInterval(() => {
        const used = process.memoryUsage();
        const heapUsed = Math.round(used.heapUsed / 1024 / 1024);
        const rss = Math.round(used.rss / 1024 / 1024);
        const RAILWAY_LIMIT_MB = 2048;
        const usagePercent = (rss / RAILWAY_LIMIT_MB) * 100;

        let memStatus = '🟢';
        if (usagePercent > 85) memStatus = '🔴';
        else if (usagePercent > 70) memStatus = '🟡';

        // Alchemy WS status
        const wsStatus = chains.map(c => {
            if (!c.alchemyWsUrl) return `${c.name}:OFF`;
            return `${c.name}:${alchemyHealthy[c.name] ? '🟢' : '🔴'}`;
        }).join(' ');

        console.log(
            `📊 [${memStatus}] Heap ${heapUsed}MB | RSS ${rss}MB (${Math.round(usagePercent)}%) | ` +
            `WS: ${wsStatus} | Est CU: ~${Math.round(cuEstimate / 1000)}K`
        );

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
    console.log("👀 Starting Blockchain Monitors (v5.1 — CU Optimized)...");

    startMonitors();
    setupShutdownHandlers();

    const trackedCount = getTrackedAddresses().length;
    console.log(`📋 Tracking ${trackedCount} wallet(s) across ${chains.length} chain(s)`);
    console.log(`⚡ Optimizations: smart polling | full mempool tx stream`);

    chains.forEach(chain => {
        if (chain.rpcUrls.length === 0) {
            console.warn(`⚠️ No RPC URLs for ${chain.name}, skipping.`);
            return;
        }

        if (chain.alchemyWsUrl) {
            console.log(`✅ [${chain.name}] Alchemy hashesOnly + smart polling`);
            startAlchemyListener(chain, bot);
        } else {
            console.log(`⚠️ [${chain.name}] No Alchemy WS — using polling only`);
        }

        startPollingFallback(chain, bot);
    });

    startWalletChangeWatcher(bot);
}
