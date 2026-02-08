// @ts-nocheck force update
import { ethers } from 'ethers';
import { config } from './config';
import { store } from './store';
import { attemptMint } from './mint';
import { Bot } from 'grammy';
import { isLikelyNFTMint, getFilterReason } from './filters';

interface ChainConfig {
    name: string;
    rpcUrl: string;
}

const chains: ChainConfig[] = [
    { name: 'ETH', rpcUrl: config.rpcUrl },
    { name: 'BASE', rpcUrl: config.rpcUrlBase }
];

// Track last checked block for each chain to avoid re-checking
const lastCheckedBlock: Record<string, number> = {};

/**
 * MEMORY-EFFICIENT monitoring:
 * Instead of fetching full blocks, we poll for specific wallet activity
 */
export function startMonitoring(bot: Bot) {
    console.log("👀 Starting Blockchain Monitors (Memory-Optimized)...");

    chains.forEach(chain => {
        if (!chain.rpcUrl) {
            console.warn(`⚠️ No RPC URL for ${chain.name}, skipping.`);
            return;
        }

        const provider = new ethers.JsonRpcProvider(chain.rpcUrl);
        console.log(`✅ Listening on ${chain.name}`);

        // Poll every 15 seconds instead of every block to reduce load
        setInterval(async () => {
            try {
                const allUsers = store.getAllUsers();
                if (allUsers.length === 0) return;

                const currentBlock = await provider.getBlockNumber();
                const lastBlock = lastCheckedBlock[chain.name] || currentBlock - 1;

                // Skip if we've already checked this block
                if (currentBlock <= lastBlock) return;

                // Only check last 1 block to avoid memory issues
                const blockToCheck = currentBlock;

                console.log(`[${chain.name}] Checking block ${blockToCheck}...`);

                // Check each tracked wallet individually (memory efficient)
                for (const { userId, data: userData } of allUsers) {
                    for (const wallet of userData.trackedWallets) {
                        try {
                            // Get transaction count to see if wallet sent anything
                            const txCount = await provider.getTransactionCount(
                                wallet.address,
                                blockToCheck
                            );

                            // Check previous block tx count
                            const prevTxCount = await provider.getTransactionCount(
                                wallet.address,
                                blockToCheck - 1
                            );

                            // If count increased, wallet sent a transaction
                            if (txCount > prevTxCount) {
                                console.log(`[${chain.name}] Activity detected from ${wallet.address}`);
                                console.log(`[${chain.name}] ↳ Checking for user: ${userId} (chatId: ${userData.chatId})`);

                                // Fetch only the block header (no transactions) to get tx hashes
                                const block = await provider.getBlock(blockToCheck, false);
                                if (!block || !block.transactions) continue;

                                // Check each transaction hash
                                for (const txHash of block.transactions) {
                                    const tx = await provider.getTransaction(txHash);
                                    if (!tx) continue;

                                    // Check if this tx is from our tracked wallet
                                    if (tx.from.toLowerCase() === wallet.address.toLowerCase()) {
                                        console.log(`[${chain.name}] Found tx from tracked wallet (user: ${userId})`);

                                        // Apply filters
                                        if (tx.data && tx.data !== '0x' && tx.to) {
                                            if (isLikelyNFTMint(tx.data)) {
                                                console.log(`  ✅ NFT Mint detected! Processing for user ${userId}...`);

                                                const privateKey = store.getDecryptedPrivateKey(userId);
                                                if (!privateKey) {
                                                    console.error(`Failed to decrypt key for user ${userId}`);
                                                    continue;
                                                }

                                                const walletSigner = new ethers.Wallet(privateKey, provider);
                                                console.log(`  📨 User ${userId} will mint with wallet: ${walletSigner.address}`);

                                                await attemptMint({
                                                    originalTx: tx,
                                                    bot,
                                                    chatId: userData.chatId,
                                                    chainName: chain.name,
                                                    signer: walletSigner
                                                });
                                            } else {
                                                const reason = getFilterReason(tx.data);
                                                console.log(`  ⏭️ Skipped (user ${userId}): ${reason}`);
                                            }
                                        }
                                    }
                                }
                            }
                        } catch (err: any) {
                            console.error(`[${chain.name}] Error checking wallet ${wallet.address}:`, err.message);
                        }
                    }
                }

                lastCheckedBlock[chain.name] = blockToCheck;

            } catch (err: any) {
                console.error(`[${chain.name}] Error in monitoring loop:`, err.message);
            }
        }, 15000); // Check every 15 seconds
    });
}
