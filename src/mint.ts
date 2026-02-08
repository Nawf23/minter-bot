import { ethers, TransactionResponse, JsonRpcProvider } from 'ethers';
import { config } from './config';
import { Bot } from 'grammy';
import { replaceRecipientInCalldata, needsAddressReplacement } from './calldata_utils';

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
            `🚨 *Detected transaction on ${chainName}!*\n\n` +
            `Target: \`${originalTx.to}\`\n` +
            `From (tracked wallet): \`${originalTx.from}\`\n` +
            `Appears to be FREE! 🤑\n` +
            `Attempting copy...`,
            { parse_mode: "Markdown" }
        );

        // --- 2. Construct Transaction with Address Replacement ---
        let calldata = originalTx.data;

        // Replace recipient address if needed
        if (needsAddressReplacement(calldata)) {
            console.log(`[${chainName}] ⚙️ Replacing recipient address in calldata...`);
            calldata = replaceRecipientInCalldata(calldata, signer.address);
            console.log(`[${chainName}] ✅ Calldata modified - NFT will go to bot wallet`);
        } else {
            console.log(`[${chainName}] ℹ️ No address replacement needed`);
        }


        // --- 3. Send Transaction ---
        const txRequest = {
            to: originalTx.to,
            data: calldata,  // Use modified calldata (with replaced address if needed)
            value: 0n,
        };

        console.log(`[${chainName}] ========== MINT ATTEMPT ==========`);
        console.log(`[${chainName}] Bot wallet: ${signer.address}`);
        console.log(`[${chainName}] Target contract: ${originalTx.to}`);
        console.log(`[${chainName}] Original tx hash: ${originalTx.hash}`);
        console.log(`[${chainName}] Tracked wallet: ${originalTx.from}`);
        console.log(`[${chainName}] Sending transaction...`);

        const tx = await signer.sendTransaction(txRequest);

        console.log(`[${chainName}] ✅ Transaction sent successfully!`);
        console.log(`[${chainName}] NEW transaction hash: ${tx.hash}`);
        console.log(`[${chainName}] From: ${tx.from}`);
        console.log(`[${chainName}] =====================================`);

        const explorerUrl = chainName === 'BASE'
            ? `https://basescan.org/tx/${tx.hash}`
            : `https://etherscan.io/tx/${tx.hash}`;

        // Send success notification (wrapped to prevent silent failures)
        try {
            await bot.api.sendMessage(chatId,
                `🚀 *Mint Transaction Sent!* (${chainName})\n\n` +
                `Your wallet: \`${signer.address}\`\n` +
                `Hash: [View on Explorer](${explorerUrl})`,
                { parse_mode: "Markdown" }
            );
            console.log(`[${chainName}] ✅ Telegram notification sent to chatId: ${chatId}`);
        } catch (telegramError: any) {
            console.error(`[${chainName}] ⚠️ Failed to send Telegram notification:`, telegramError.message);
            console.error(`[${chainName}] ChatId was: ${chatId}`);
        }

    } catch (error: any) {
        console.error(`[${chainName}] ❌ Mint failed:`, error);
        console.error(`[${chainName}] Error message:`, error.message);
        console.error(`[${chainName}] Error code:`, error.code);

        const errorMsg = error.message.toLowerCase();
        let reason = error.message.substring(0, 150);

        // Detect specific errors with clear user-facing messages
        if (errorMsg.includes('invalid signature') ||
            errorMsg.includes('bad signature') ||
            errorMsg.includes('not whitelisted') ||
            errorMsg.includes('allowlist') ||
            errorMsg.includes('merkle')) {
            reason = '🚫 This mint requires a whitelist';
        } else if (errorMsg.includes('not eligible') ||
            errorMsg.includes('not allowed') ||
            errorMsg.includes('unauthorized') ||
            errorMsg.includes('not authorized')) {
            reason = '⚠️ Wallet not eligible for this mint';
        } else if (errorMsg.includes('insufficient funds') ||
            errorMsg.includes('insufficient balance') ||
            errorMsg.includes('not enough')) {
            reason = '💰 Insufficient ETH for gas fees';
        } else if (errorMsg.includes('exceeds allowance') ||
            errorMsg.includes('max supply') ||
            errorMsg.includes('sold out') ||
            errorMsg.includes('limit reached') ||
            errorMsg.includes('max mint') ||
            errorMsg.includes('already minted') ||
            errorMsg.includes('exceeds max')) {
            reason = '🚫 Mint sold out or you already minted';
        } else if (errorMsg.includes('paused') ||
            errorMsg.includes('not active') ||
            errorMsg.includes('not started') ||
            errorMsg.includes('not open')) {
            reason = '⏸️ Minting is currently paused';
        } else if (errorMsg.includes('ended') ||
            errorMsg.includes('expired') ||
            errorMsg.includes('closed') ||
            errorMsg.includes('finished')) {
            reason = '⏰ Mint has ended';
        } else if (errorMsg.includes('gas') ||
            errorMsg.includes('underpriced') ||
            errorMsg.includes('replacement fee')) {
            reason = '⛽ Gas price too low - network is congested';
        } else if (errorMsg.includes('nonce')) {
            reason = '🔄 Transaction conflict - try again';
        } else if (errorMsg.includes('revert') && errorMsg.length < 50) {
            reason = '❌ Contract rejected the transaction';
        }

        // Wrap in try-catch to prevent notification failures from crashing
        try {
            await bot.api.sendMessage(chatId,
                `❌ *Mint Failed* (${chainName})\n\n` +
                `Reason: ${reason}\n\n` +
                `_Your wallet: \`${signer.address}\`_`,
                { parse_mode: "Markdown" }
            );
        } catch (telegramError: any) {
            console.error(`[${chainName}] ⚠️ Failed to send error notification:`, telegramError.message);
        }
    }
}
