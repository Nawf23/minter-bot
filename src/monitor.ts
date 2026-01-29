// @ts-nocheck force update
import { ethers } from 'ethers';
import { config } from './config';
import { store } from './store';
import { attemptMint } from './mint';
import { Bot } from 'grammy';

interface ChainConfig {
    name: string;
    rpcUrl: string;
}

const chains: ChainConfig[] = [
    { name: 'ETH', rpcUrl: config.rpcUrl },
    { name: 'BASE', rpcUrl: config.rpcUrlBase }
];

export function startMonitoring(bot: Bot) {
    console.log("👀 Starting Blockchain Monitors...");

    chains.forEach(chain => {
        if (!chain.rpcUrl) {
            console.warn(`⚠️ No RPC URL for ${chain.name}, skipping.`);
            return;
        }

        const provider = new ethers.JsonRpcProvider(chain.rpcUrl);

        console.log(`✅ Listening on ${chain.name}`);

        provider.on("block", async (blockNumber) => {
            const allUsers = store.getAllUsers();

            if (allUsers.length === 0) return;

            try {
                const block = await provider.getBlock(blockNumber, true);
                if (!block || !block.prefetchedTransactions) return;

                for (const tx of block.prefetchedTransactions) {
                    // Check if ANY user is tracking this wallet
                    for (const { userId, data: userData } of allUsers) {
                        const isTracked = userData.trackedWallets.some(
                            w => w.address.toLowerCase() === tx.from.toLowerCase()
                        );

                        if (isTracked) {
                            console.log(`[${chain.name}] Found tx from ${tx.from} (tracked by user ${userId})`);

                            // Filter: Must have data (contract interaction) and a 'to' address
                            if (tx.data && tx.data !== '0x' && tx.to) {
                                const privateKey = store.getDecryptedPrivateKey(userId);
                                if (!privateKey) {
                                    console.error(`Failed to decrypt key for user ${userId}`);
                                    continue;
                                }

                                const wallet = new ethers.Wallet(privateKey, provider);

                                await attemptMint({
                                    originalTx: tx,
                                    bot,
                                    chatId: userData.chatId,
                                    chainName: chain.name,
                                    signer: wallet
                                });
                            }
                        }
                    }
                }
            } catch (err: any) {
                // Console error is noisy on public RPCs sometimes, keep it clean
                console.error(`[${chain.name}] Error processing block ${blockNumber}`);
            }
        });
    });
}
