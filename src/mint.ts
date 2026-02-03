import { ethers, TransactionResponse, JsonRpcProvider } from 'ethers';
import { config } from './config';
import { Bot } from 'grammy';

interface ReplayOptions {
    originalTx: TransactionResponse;
    bot: Bot;
    chatId: number;
    chainName: string; // 'ETH' or 'BASE'
    signer: ethers.Wallet; // The wallet connected to the correct provider
}

export async function attemptMint({ originalTx, bot, chatId, chainName, signer }: ReplayOptions) {
    if (!originalTx.to) return;

    try {
        // --- 1. Free Mint Check ---
        if (originalTx.value > 0n) {
            console.log(`[${chainName}] Skipped paid mint: ${ethers.formatEther(originalTx.value)} ETH`);
            await bot.api.sendMessage(chatId,
                `⚠️ *Skipped Paid Mint*\n\n` +
                `Target: \`${originalTx.to}\`\n` +
                `Cost: ${ethers.formatEther(originalTx.value)} ETH\n` +
                `Chain: ${chainName}\n\n` +
                `_I only auto-mint free NFTs._`,
                { parse_mode: "Markdown" }
            );
            return;
        }

        await bot.api.sendMessage(chatId,
            `🚨 *detected transaction on ${chainName}!*\n\n` +
            `Target: \`${originalTx.to}\`\n` +
            `Appears to be FREE! 🤑\n` +
            `Attempting copy...`,
            { parse_mode: "Markdown" }
        );

        // --- 2. Construct Transaction ---
        const txRequest = {
            to: originalTx.to,
            data: originalTx.data, // Copy calldata exactly
            value: 0n, // Enforce 0 value since we checked it's free, but original was 0 anyway
        };

        console.log(`[${chainName}] Creating transaction to ${originalTx.to}...`);

        const tx = await signer.sendTransaction(txRequest);

        console.log(`[${chainName}] Sent! Hash: ${tx.hash}`);

        const explorerUrl = chainName === 'BASE'
            ? `https://basescan.org/tx/${tx.hash}`
            : `https://etherscan.io/tx/${tx.hash}`;

        await bot.api.sendMessage(chatId,
            `🚀 *Mint Transaction Sent!* (${chainName})\n\n` +
            `Hash: [View on Explorer](${explorerUrl})`,
            { parse_mode: "Markdown" }
        );

    } catch (error: any) {
        console.error(`[${chainName}] Mint failed:`, error);
        await bot.api.sendMessage(chatId, `❌ *Mint Failed* (${chainName})\n\nReason: ${error.message.substring(0, 100)}...`, { parse_mode: "Markdown" });
    }
}
