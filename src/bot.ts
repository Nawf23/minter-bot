import { Bot, Context } from 'grammy';
import { config } from './config';
import { store } from './store';
import { ethers } from 'ethers';
import { startMonitoring } from './monitor';

// Initialize Bot
const bot = new Bot(config.telegramBotToken);

// Initialize Provider & Wallet
const provider = new ethers.JsonRpcProvider(config.rpcUrl);
// We just need a wallet instance for address display, strictly speaking we have two providers now
const wallet = new ethers.Wallet(config.privateKey, provider);

// Store bot wallet address
store.setBotWalletAddress(wallet.address);

// Start Monitoring
startMonitoring(bot);

// --- Commands ---

bot.command('start', async (ctx) => {
    if (ctx.chatId) store.setChatId(ctx.chatId);
    await ctx.reply(
        `🚀 *NFT Vibe Bot v2*\n\n` +
        `I am monitoring *Ethereum & Base* for alpha.\n` +
        `I only copy *FREE MINTS* (0 ETH).\n\n` +
        `*Your Bot Wallet:* \`${wallet.address}\`\n\n` +
        `*Commands:*\n` +
        `/track <address> - Add wallet to watch (Max 3)\n` +
        `/remove <address> - Stop watching a wallet\n` +
        `/status - Check tracked wallets\n` +
        `/wallet - View bot wallet info`,
        { parse_mode: "Markdown" }
    );
});

bot.command('track', async (ctx) => {
    const address = ctx.match as string;
    if (!address || !ethers.isAddress(address)) {
        return ctx.reply("❌ Invalid Address.\nUsage: `/track 0x...`", { parse_mode: "Markdown" });
    }

    const current = store.getTrackedWallets();
    if (current.length >= 3) {
        return ctx.reply("⚠️ Limit Reached! You can only track 3 wallets.\nUse `/remove <address>` to free up a slot.", { parse_mode: "Markdown" });
    }

    if (current.includes(address)) {
        return ctx.reply("⚠️ Already tracking this wallet.", { parse_mode: "Markdown" });
    }

    store.addTrackedWallet(address);
    await ctx.reply(`🎯 *Tracking Added!*\n\nNow watching: \`${address}\`\n(Total: ${current.length + 1}/3)`, { parse_mode: "Markdown" });
});

bot.command('remove', async (ctx) => {
    const address = ctx.match as string;
    if (!address) {
        return ctx.reply("❌ Provide an address to remove.\nUsage: `/remove 0x...`", { parse_mode: "Markdown" });
    }

    const current = store.getTrackedWallets();
    if (!current.find(w => w.toLowerCase() === address.toLowerCase())) {
        return ctx.reply("⚠️ Not tracking this wallet.", { parse_mode: "Markdown" });
    }

    store.removeTrackedWallet(address);
    await ctx.reply(`🗑️ *Stopped Tracking:*\n\`${address}\``, { parse_mode: "Markdown" });
});

bot.command('status', async (ctx) => {
    const data = store.get();
    const balance = ethers.formatEther(await provider.getBalance(wallet.address));

    const walletsList = data.trackedWallets && data.trackedWallets.length > 0
        ? data.trackedWallets.map(w => `• \`${w}\``).join("\n")
        : "None";

    await ctx.reply(
        `📊 *Bot Status*\n\n` +
        `*Tracked Wallets:* (${data.trackedWallets?.length || 0}/3)\n${walletsList}\n\n` +
        `*Bot Wallet:* \`${wallet.address}\`\n` +
        `*ETH Balance:* ${parseFloat(balance).toFixed(4)} ETH\n` +
        `*Active Chains:* Ethereum, Base`,
        { parse_mode: "Markdown" }
    );
});

bot.command('wallet', async (ctx) => {
    const balance = ethers.formatEther(await provider.getBalance(wallet.address));
    await ctx.reply(
        `💳 *Wallet Info*\n\n` +
        `address: \`${wallet.address}\`\n` +
        `ETH Balance: ${balance} ETH\n` +
        `_Note: Same address for Base & ETH._`,
        { parse_mode: "Markdown" }
    );
});

// --- Error Handling ---
bot.catch((err) => {
    console.error("Bot error:", err);
});

// --- Start ---
console.log("🤖 Starting Bot...");
bot.start({
    onStart: (botInfo) => {
        console.log(`✅ Bot running as @${botInfo.username}`);
    }
});
