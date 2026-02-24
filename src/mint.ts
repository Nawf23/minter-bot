import { ethers, TransactionResponse } from 'ethers';
import { Bot } from 'grammy';
import { store } from './store';
import { config } from './config';
import {
    replaceRecipientInCalldata,
    needsAddressReplacement,
    genericReplaceAddress,
    calldataContainsAddress
} from './calldata_utils';
import { getSharedProvider } from './rpc_utils';

// ─── Types ───

interface ReplayOptions {
    originalTx: TransactionResponse;
    bot: Bot;
    chatId: number;
    chainName: string;
    signer: ethers.Wallet;
    keyName: string | null;
    userId: string;
}

export interface MintResult {
    success: boolean;
    keyName: string | null;
    address: string;
    txHash?: string;
    explorerUrl?: string;
    error?: string;
    autoList?: boolean;
    skippedPrecheck?: boolean;
}

interface MultiMintOptions {
    originalTx: TransactionResponse;
    bot: Bot;
    chatId: number;
    chainName: string;
    keys: Array<{ privateKey: string; name: string | null; address: string; autoList: boolean }>;
    rpcUrl: string;
    userLabel: string;
    userId: string;
}

// ─── Explorer URLs per chain ───

function getExplorerUrl(chainName: string, txHash: string): string {
    switch (chainName) {
        case 'BASE': return `https://basescan.org/tx/${txHash}`;
        case 'ARB': return `https://arbiscan.io/tx/${txHash}`;
        case 'OP': return `https://optimistic.etherscan.io/tx/${txHash}`;
        case 'POLY': return `https://polygonscan.com/tx/${txHash}`;
        default: return `https://etherscan.io/tx/${txHash}`;
    }
}

/** 
 * Decodes human-readable revert reasons from contract error data.
 * Handles Error(string) and Panic(uint256) selectors.
 */
function decodeRevertReason(data: string): string {
    if (!data || data === '0x') return 'Execution reverted';

    // 0x08c379a0: Error(string)
    if (data.startsWith('0x08c379a0')) {
        try {
            // Remove selector and decode as string
            const reason = ethers.AbiCoder.defaultAbiCoder().decode(['string'], '0x' + data.substring(10));
            return reason[0];
        } catch {
            return 'Contract rejected (custom error)';
        }
    }

    // 0x4e487b71: Panic(uint256)
    if (data.startsWith('0x4e487b71')) {
        return 'Contract panicked (internal error)';
    }

    // SeaDrop: MintQuantityExceedsMaxMintedPerWallet
    if (data.startsWith('0xedc01273')) {
        return 'Max per wallet reached (SeaDrop)';
    }

    // Default to showing just the selector if unknown
    return `Contract rejected (${data.substring(0, 10)})`;
}

// ─── Allowlist Pre-Check (estimateGas before sending) ───

async function preCheckMint(
    signer: ethers.Wallet,
    txRequest: { to: string; data: string; value: bigint },
    chainName: string,
    keyName: string | null
): Promise<{ pass: boolean; reason?: string }> {
    try {
        await signer.estimateGas(txRequest);
        return { pass: true };
    } catch (err: any) {
        const msg = err.message?.toLowerCase() || '';
        let reason = 'Pre-check failed';

        if (msg.includes('not whitelisted') || msg.includes('allowlist') || msg.includes('merkle')) {
            reason = 'Not on allowlist';
        } else if (msg.includes('not eligible') || msg.includes('not allowed') || msg.includes('unauthorized')) {
            reason = 'Not eligible';
        } else if (msg.includes('already minted') || msg.includes('exceeds max') || msg.includes('sold out')) {
            reason = 'Already minted or sold out';
        } else if (msg.includes('paused') || msg.includes('not active')) {
            reason = 'Minting paused';
        } else if (msg.includes('ended') || msg.includes('expired')) {
            reason = 'Mint ended';
        } else if (msg.includes('insufficient funds')) {
            reason = 'Insufficient gas funds';
        } else if (msg.includes('unknown custom error') || msg.includes('execution reverted') || msg.includes('reverted')) {
            const dataMatch = err.message?.match(/data="(0x[a-fA-F0-9]+)"/);
            reason = dataMatch ? decodeRevertReason(dataMatch[1]) : 'Contract rejected';
        } else if (msg.includes('missing revert data')) {
            // FALLBACK: If estimateGas is vague, try a static call to see if it gives a clearer revert reason
            try {
                await signer.call(txRequest);
                reason = 'Estimate failed but call passed (unusual)';
            } catch (callErr: any) {
                const callMsg = callErr.message?.toLowerCase() || '';
                const dataMatch = callErr.message?.match(/data="(0x[a-fA-F0-9]+)"/);
                reason = dataMatch ? decodeRevertReason(dataMatch[1]) : 'Contract rejected (silent)';
            }
        } else {
            // Unhandled error pattern - log raw message for debugging
            reason = msg.length > 100 ? msg.substring(0, 100) + '...' : msg;
        }

        console.log(`[${chainName}]   🛡️ [${keyName}] Pre-check FAILED: ${reason}`);
        // If we still just have a generic failure, log the raw error for developer investigation
        if (reason.toLowerCase().includes('pre-check failed') || reason.toLowerCase().includes('rejected')) {
            console.log(`[${chainName}]   DEBUG [${keyName}] Raw error from provider: ${err.message}`);
        }
        return { pass: false, reason };
    }
}

// ─── Single Mint (returns result, no Telegram message) ───

async function attemptSingleMint({
    originalTx, chainName, signer, keyName, userId
}: ReplayOptions): Promise<MintResult> {
    if (!originalTx.to) {
        return { success: false, keyName, address: signer.address, error: 'No target address' };
    }

    try {
        // Free Mint Check
        if (originalTx.value > 0n) {
            const cost = ethers.formatEther(originalTx.value);
            return { success: false, keyName, address: signer.address, error: `Skipped paid mint (${cost} ETH)` };
        }

        // Self-Copy protection: Don't copy our own transactions
        if (originalTx.from.toLowerCase() === signer.address.toLowerCase()) {
            console.log(`[${chainName}]   ⏭️ [${keyName}] Skipping self-copy`);
            return { success: false, keyName, address: signer.address, error: 'Self-copy skipped' };
        }

        // Construct calldata with address replacement
        let calldata = originalTx.data;
        let addressReplaced = false;

        if (needsAddressReplacement(calldata)) {
            calldata = replaceRecipientInCalldata(calldata, signer.address);
            addressReplaced = true;
        }

        if (!addressReplaced && calldataContainsAddress(calldata, originalTx.from)) {
            const result = genericReplaceAddress(calldata, originalTx.from, signer.address);
            calldata = result.data;
            addressReplaced = true;
            console.log(`[${chainName}]   ⚙️ [${keyName}] Generic replaced ${result.replacements} addr(s)`);
        }

        const txRequest = {
            to: originalTx.to,
            data: calldata,
            value: 0n,
        };

        // ─── Allowlist Pre-Check ───
        const preCheck = await preCheckMint(signer, txRequest, chainName, keyName);
        if (!preCheck.pass) {
            console.log(`  🛡️ [${keyName}] Pre-check failed: ${preCheck.reason}`);
            store.recordMintAttempt(userId, signer.address, false);
            return {
                success: false,
                keyName,
                address: signer.address,
                error: preCheck.reason,
                skippedPrecheck: true,
            };
        }

        // ─── Send Transaction (pre-check passed) ───
        console.log(`[${chainName}]   📨 [${keyName}] Sending from ${signer.address}`);

        // Send with manual gas limit (since we already estimated)
        const tx = await signer.sendTransaction(txRequest);
        console.log(`[${chainName}]   ✅ [${keyName}] TX sent: ${tx.hash}`);

        const explorerUrl = getExplorerUrl(chainName, tx.hash);

        // Record success
        store.recordMintAttempt(userId, signer.address, true);

        return {
            success: true,
            keyName,
            address: signer.address,
            txHash: tx.hash,
            explorerUrl,
        };

    } catch (error: any) {
        console.error(`[${chainName}]   ❌ [${keyName}] Failed: ${error.message?.substring(0, 100)}`);

        store.recordMintAttempt(userId, signer.address, false);

        const errorMsg = error.message?.toLowerCase() || '';
        let reason = error.message?.substring(0, 120) || 'Unknown error';

        if (errorMsg.includes('insufficient funds') || errorMsg.includes('not enough')) {
            reason = 'Insufficient ETH for gas';
        } else if (errorMsg.includes('nonce')) {
            reason = 'Nonce conflict';
        } else if (errorMsg.includes('gas') || errorMsg.includes('underpriced')) {
            reason = 'Gas too low';
        } else if (errorMsg.includes('revert')) {
            const dataMatch = error.message?.match(/data="(0x[a-fA-F0-9]+)"/);
            reason = dataMatch ? decodeRevertReason(dataMatch[1]) : 'Transaction reverted';
        }

        return { success: false, keyName, address: signer.address, error: reason };
    }
}

// ─── Multi-Key Mint (fires all keys, sends ONE bundled notification) ───

export async function attemptMintAllKeys({
    originalTx, bot, chatId, chainName, keys, rpcUrl, userLabel, userId
}: MultiMintOptions): Promise<MintResult[]> {
    if (!originalTx.to) return [];

    // Skip paid mints early
    if (originalTx.value > 0n) {
        const cost = ethers.formatEther(originalTx.value);
        console.log(`[${chainName}] ⏭️ [${userLabel}] Skipped paid mint: ${cost} ETH`);

        // Notify user about skipping paid mint (non-blocking)
        bot.api.sendMessage(chatId,
            `⚠️ *Skipped Paid Mint*\n\n` +
            `Target: \`${originalTx.to}\`\n` +
            `Cost: ${cost} ETH | Chain: ${chainName}\n\n` +
            `_I only auto-mint free NFTs._`,
            { parse_mode: "Markdown" }
        ).then(() => {
            console.log(`  📱 [${userLabel}] Skip notification sent`);
        }).catch((err: any) => {
            console.error(`[${chainName}] ⚠️ [${userLabel}] Skip notification failed: ${err.message}`);
        });

        return keys.map(k => ({ success: false, keyName: k.name, address: k.address, error: `Paid (${cost} ETH)` }));
    }

    // 1. Fire all keys in parallel IMMEDIATELY (Highest Priority)
    const mintPromise = Promise.allSettled(
        keys.map(async (key) => {
            const provider = getSharedProvider(rpcUrl);
            const signer = new ethers.Wallet(key.privateKey, provider);
            return attemptSingleMint({
                originalTx,
                bot,
                chatId,
                chainName,
                signer,
                keyName: key.name,
                userId,
            });
        })
    );

    // 2. Notify: mint detected (Asynchronously, don't await)
    bot.api.sendMessage(chatId,
        `🚨 *Mint detected on ${chainName}!*\n\n` +
        `Target: \`${originalTx.to}\`\n` +
        `From: \`${originalTx.from}\`\n` +
        `FREE mint! 🤑 Firing ${keys.length} key(s)...`,
        { parse_mode: "Markdown" }
    ).catch(() => { });

    // 3. Wait for transactions to finish sending
    const results = await mintPromise;

    const mintResults: MintResult[] = results.map((r, i) =>
        r.status === 'fulfilled' ? r.value : {
            success: false,
            keyName: keys[i]?.name || null,
            address: keys[i]?.address || '???',
            error: r.status === 'rejected' ? r.reason?.message : 'Unknown error',
        }
    );

    // Build bundled notification
    const successes = mintResults.filter(r => r.success);
    const failures = mintResults.filter(r => !r.success);
    const prechecked = mintResults.filter(r => r.skippedPrecheck);

    let msg = '';

    if (successes.length > 0) {
        msg += `🚀 *Transactions Broadcast* (${chainName})\n\n`;
        for (const r of successes) {
            const label = r.keyName ? `"${r.keyName}"` : 'Key';
            msg += `📨 ${label} (\`${r.address}\`)\n`;
            msg += `   → [View on Explorer](${r.explorerUrl})\n\n`;
        }
        msg += `_Note: Transactions are broadcast but not yet confirmed._\n\n`;
    }

    if (failures.length > 0) {
        if (successes.length === 0) msg += `❌ *Mint Failed* (${chainName})\n\n`;
        for (const r of failures) {
            const label = r.keyName ? `"${r.keyName}"` : 'Key';
            let icon = '❌';
            if (r.skippedPrecheck) icon = '🛡️';
            if (r.error?.includes('Insufficient ETH')) icon = '💰';

            msg += `${icon} ${label} (\`${r.address}\`)\n`;
            msg += `   → ${r.error}\n\n`;
        }
    }

    if (prechecked.length > 0 && prechecked.length === mintResults.length) {
        msg += `_🛡️ All keys failed pre-check — no gas was spent._\n\n`;
    }

    if (successes.length > 0) {
        msg += `_Give my creator a follow on X_ 👉 [@victornawf](https://x.com/victornawf2)`;
    }

    // 4. Send bundled notification
    if (msg) {
        bot.api.sendMessage(chatId, msg, {
            parse_mode: "Markdown",
            link_preview_options: { is_disabled: true }
        }).catch(err => console.error(`[${chainName}] Failed to send results: ${err.message}`));
    }

    // 5. Asynchronously wait for confirmations and notify (don't block the loop)
    successes.forEach(res => {
        if (res.txHash) {
            waitForConfirmation(res.txHash, res.keyName, res.address, chainName, bot, chatId, rpcUrl);
        }
    });

    return mintResults;
}

/**
 * Asynchronously waits for a transaction receipt and notifies the user of the result.
 */
async function waitForConfirmation(
    hash: string,
    keyName: string | null,
    address: string,
    chainName: string,
    bot: Bot,
    chatId: number,
    rpcUrl: string
) {
    try {
        const provider = getSharedProvider(rpcUrl);
        console.log(`[${chainName}]   ⏳ Waiting for confirmation: ${hash.substring(0, 14)}...`);

        const receipt = await provider.waitForTransaction(hash);

        if (receipt && receipt.status === 1) {
            const label = keyName ? `"${keyName}"` : 'Key';
            const gasUsed = receipt.gasUsed.toString();
            const gasPrice = ethers.formatUnits(receipt.gasPrice || 0n, 'gwei');

            console.log(`[${chainName}]   ✅ [${label}] Confirmed: ${hash}`);

            await bot.api.sendMessage(chatId,
                `✅ *Transaction Confirmed!*\n\n` +
                `Key: ${label} (\`${address}\`)\n` +
                `Status: Success\n` +
                `Hash: [View on Explorer](${getExplorerUrl(chainName, hash)})\n\n` +
                `_Gas used: ${gasUsed} | Price: ${gasPrice} gwei_`,
                { parse_mode: "Markdown", link_preview_options: { is_disabled: true } }
            ).catch(() => { });
        } else {
            const label = keyName ? `"${keyName}"` : 'Key';
            console.log(`[${chainName}]   ❌ [${label}] Reverted on-chain: ${hash}`);

            await bot.api.sendMessage(chatId,
                `❌ *Transaction Reverted on-chain*\n\n` +
                `Key: ${label} (\`${address}\`)\n` +
                `Hash: [View on Explorer](${getExplorerUrl(chainName, hash)})\n\n` +
                `_Your gas was spent but the contract rejected the execution._`,
                { parse_mode: "Markdown", link_preview_options: { is_disabled: true } }
            ).catch(() => { });
        }
    } catch (err: any) {
        console.error(`[${chainName}] Confirmation error for ${hash}:`, err.message);
    }
}
