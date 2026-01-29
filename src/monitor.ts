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
        const wallet = new ethers.Wallet(config.privateKey, provider);

        console.log(`✅ Listening on ${chain.name}`);

        provider.on("block", async (blockNumber) => {
            const trackedWallets = store.getTrackedWallets();
            if (trackedWallets.length === 0) return;

            try {
                const block = await provider.getBlock(blockNumber, true);
                if (!block || !block.prefetchedTransactions) return;

                for (const tx of block.prefetchedTransactions) {
                    // Check if 'from' is in our tracked list
                    if (trackedWallets.some(w => w.toLowerCase() === tx.from.toLowerCase())) {
                        console.log(`[${chain.name}] Found tx from ${tx.from} in block ${blockNumber}`);

                        // Filter: Must have data (contract interaction) and a 'to' address
                        if (tx.data && tx.data !== '0x' && tx.to) {
                            const chatId = store.get().chatId;
                            if (chatId) {
                                await attemptMint({
                                    originalTx: tx,
                                    bot,
                                    chatId,
                                    chainName: chain.name,
                                    signer: wallet
                                });
                            }
                        }
                    }
                }
            } catch (err) {
                // Console error is noisy on public RPCs sometimes, keep it clean
                console.error(`[${chain.name}] Error processing block ${blockNumber}:`, err.message);
            }
        });
    });
}
