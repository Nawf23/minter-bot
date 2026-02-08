import { Bot, Context } from 'grammy';
import { config } from './config';
import { store } from './store';
import { ethers } from 'ethers';
import fs from 'fs';
import path from 'path';
import { startMonitoring } from './monitor';

// Initialize Bot
const bot = new Bot(config.telegramBotToken);

// Migration check on startup
function checkMigration() {
    const DB_PATH = path.resolve(__dirname, '../db.json');
    if (fs.existsSync(DB_PATH)) {
        const raw = fs.readFileSync(DB_PATH, 'utf-8');
        const parsed = JSON.parse(raw);

        // Old format detected
        if (parsed.trackedWallets && !parsed.users && parsed.chatId && config.privateKey) {
            console.log('🔄 Old data format detected. Will migrate on first user interaction.');
        }
    }
}

// Helper to get user ID
function getUserId(ctx: Context): string {
    return ctx.from?.id.toString() || '';
}

// Helper to check if migration is needed and perform it
function performMigrationIfNeeded(ctx: Context) {
    const DB_PATH = path.resolve(__dirname, '../db.json');
    if (fs.existsSync(DB_PATH)) {
        const raw = fs.readFileSync(DB_PATH, 'utf-8');
        const parsed = JSON.parse(raw);

        if (parsed.trackedWallets && !parsed.users && config.privateKey) {
            const userId = getUserId(ctx);
            const chatId = ctx.chat?.id || 0;
            store.migrateToMultiUser(userId, chatId, config.privateKey, parsed.trackedWallets);
            ctx.reply('✅ Your data has been migrated to the new multi-user system!');
            return true;
        }
    }
    return false;
}

// Commands

bot.command('start', async (ctx) => {
    performMigrationIfNeeded(ctx);

    const userId = getUserId(ctx);
    const user = store.getUser(userId);

    if (!user) {
        await ctx.reply(
            `🤖 **Welcome to NFT Copy Minter Bot!**\n\n` +
            `⚠️ **USE BURNER WALLET ONLY!** ⚠️\n\n` +
            `This bot will auto-mint NFTs when wallets you track make mints.\n\n` +
            `**Setup:**\n` +
            `1. Create a fresh burner wallet\n` +
            `2. Add funds for gas (small amount)\n` +
            `3. Use /addprivatekey to add your key\n` +
            `4. Use /track to add wallets to watch\n\n` +
            `**Commands:**\n` +
            `/addprivatekey <key> - Add your private key\n` +
            `/track <address> [name] - Track a wallet\n` +
            `/mywallets - View tracked wallets\n` +
            `/status - Check bot status\n` +
            `/help - Show all commands`,
            { parse_mode: 'Markdown' }
        );
    } else {
        const walletCount = user.trackedWallets.length;
        await ctx.reply(
            `✅ **Bot Active**\n\n` +
            `Tracking: ${walletCount}/3 wallets\n\n` +
            `Use /mywallets to view them or /help for commands.`,
            { parse_mode: 'Markdown' }
        );
    }
});

bot.command('addprivatekey', async (ctx) => {
    const userId = getUserId(ctx);

    if (store.userExists(userId)) {
        await ctx.reply('❌ You already have a private key. Use /changeprivatekey to update it.');
        return;
    }

    const args = ctx.message?.text?.split(' ').slice(1) || [];
    if (args.length === 0) {
        await ctx.reply('Usage: /addprivatekey <your_private_key>\n\n⚠️ USE BURNER WALLET ONLY!');
        return;
    }

    const privateKey = args[0];

    // Validate private key
    try {
        new ethers.Wallet(privateKey);
    } catch {
        await ctx.reply('❌ Invalid private key format.');
        return;
    }

    const chatId = ctx.chat?.id || 0;
    store.addUser(userId, chatId, privateKey);

    // Delete user's message containing private key
    try {
        await ctx.deleteMessage();
    } catch { }

    await ctx.reply(
        `✅ **Private key added!**\n\n` +
        `⚠️ Your message has been deleted for security.\n` +
        `⚠️ NEVER share your private key!\n\n` +
        `Next steps:\n` +
        `1. Use /track <address> [name] to track wallets\n` +
        `2. Bot will auto-mint when they mint!`,
        { parse_mode: 'Markdown' }
    );
});

bot.command('changeprivatekey', async (ctx) => {
    const userId = getUserId(ctx);

    if (!store.userExists(userId)) {
        await ctx.reply('❌ Use /addprivatekey first to set up your account.');
        return;
    }

    const args = ctx.message?.text?.split(' ').slice(1) || [];
    if (args.length === 0) {
        await ctx.reply('Usage: /changeprivatekey <new_private_key>\n\n⚠️ This will NOT delete your tracked wallets!');
        return;
    }

    const newKey = args[0];

    // Validate
    try {
        new ethers.Wallet(newKey);
    } catch {
        await ctx.reply('❌ Invalid private key format.');
        return;
    }

    store.changePrivateKey(userId, newKey);

    // Delete message
    try {
        await ctx.deleteMessage();
    } catch { }

    await ctx.reply(
        `✅ **Private key updated!**\n\n` +
        `Your tracked wallets have been preserved.\n` +
        `Your message has been deleted for security.`,
        { parse_mode: 'Markdown' }
    );
});

bot.command('track', async (ctx) => {
    performMigrationIfNeeded(ctx);

    const userId = getUserId(ctx);

    if (!store.userExists(userId)) {
        await ctx.reply('❌ Use /addprivatekey first to set up your account.');
        return;
    }

    const args = ctx.message?.text?.split(' ').slice(1) || [];
    if (args.length === 0) {
        await ctx.reply('Usage: /track <wallet_address> [optional_name]\n\nExample:\n/track 0xabc... Cool Trader');
        return;
    }

    const address = args[0];
    const name = args.slice(1).join(' ') || null;

    // Validate address
    if (!ethers.isAddress(address)) {
        await ctx.reply('❌ Invalid Ethereum address.');
        return;
    }

    try {
        store.addTrackedWallet(userId, address, name);
        const displayName = name ? ` "${name}"` : '';
        await ctx.reply(`✅ Now tracking ${address}${displayName}\n\nUse /mywallets to see all tracked wallets.`);
    } catch (err: any) {
        await ctx.reply(`❌ ${err.message}`);
    }
});

bot.command('remove', async (ctx) => {
    const userId = getUserId(ctx);

    if (!store.userExists(userId)) {
        await ctx.reply('❌ No account found.');
        return;
    }

    const args = ctx.message?.text?.split(' ').slice(1) || [];
    if (args.length === 0) {
        await ctx.reply('Usage: /remove <wallet_address>');
        return;
    }

    const address = args[0];

    try {
        store.removeTrackedWallet(userId, address);
        await ctx.reply(`✅ Removed ${address} from tracking.`);
    } catch (err: any) {
        await ctx.reply(`❌ ${err.message}`);
    }
});

bot.command('mywallets', async (ctx) => {
    const userId = getUserId(ctx);

    if (!store.userExists(userId)) {
        await ctx.reply('❌ Use /addprivatekey first to set up your account.');
        return;
    }

    const wallets = store.getTrackedWallets(userId);

    if (wallets.length === 0) {
        await ctx.reply('📭 Not tracking any wallets yet.\n\nUse /track <address> [name] to add one!');
        return;
    }

    let message = `📋 **Your Tracked Wallets (${wallets.length}/3)**\n\n`;
    wallets.forEach((wallet, i) => {
        const displayName = wallet.name ? ` - "${wallet.name}"` : '';
        message += `${i + 1}. \`${wallet.address}\`${displayName}\n`;
    });

    message += `\nUse /remove <address> to stop tracking.`;

    await ctx.reply(message, { parse_mode: 'Markdown' });
});

bot.command('status', async (ctx) => {
    const userId = getUserId(ctx);

    if (!store.userExists(userId)) {
        await ctx.reply('❌ Use /addprivatekey first to set up your account.');
        return;
    }

    const privateKey = store.getDecryptedPrivateKey(userId);
    if (!privateKey) {
        await ctx.reply('❌ Error decrypting private key. Contact support.');
        return;
    }

    const wallet = new ethers.Wallet(privateKey);
    const wallets = store.getTrackedWallets(userId);

    await ctx.reply(
        `🤖 **Bot Status**\n\n` +
        `Your Wallet: \`${wallet.address}\`\n` +
        `Tracking: ${wallets.length}/3 wallets\n` +
        `Chains: ETH + BASE\n` +
        `Mode: Free mints only\n\n` +
        `✅ Active and monitoring!`,
        { parse_mode: 'Markdown' }
    );
});

bot.command('deleteaccount', async (ctx) => {
    const userId = getUserId(ctx);

    if (!store.userExists(userId)) {
        await ctx.reply('❌ No account found.');
        return;
    }

    await ctx.reply(
        `⚠️ **WARNING**\n\n` +
        `This will delete:\n` +
        `- Your encrypted private key\n` +
        `- All tracked wallets\n\n` +
        `Type /confirmdelete to proceed.`,
        { parse_mode: 'Markdown' }
    );
});

bot.command('confirmdelete', async (ctx) => {
    const userId = getUserId(ctx);

    if (!store.userExists(userId)) {
        await ctx.reply('❌ No account found.');
        return;
    }

    store.deleteUser(userId);
    await ctx.reply('✅ Account deleted. Use /start to set up again.');
});

bot.command('help', async (ctx) => {
    await ctx.reply(
        `🤖 **NFT Copy Minter Bot - Commands**\n\n` +
        `**Setup:**\n` +
        `/addprivatekey <key> - Add your private key (BURNER WALLET!)\n` +
        `/changeprivatekey <key> - Update key (keeps wallets)\n\n` +
        `**Tracking:**\n` +
        `/track <address> [name] - Track a wallet\n` +
        `/remove <address> - Stop tracking wallet\n` +
        `/mywallets - View tracked wallets (max 3)\n\n` +
        `**Info:**\n` +
        `/status - Check bot status\n` +
        `/deleteaccount - Delete all data\n` +
        `/help - Show this message\n\n` +
        `⚠️ **ALWAYS USE BURNER WALLETS!**`,
        { parse_mode: 'Markdown' }
    );
});

// Admin broadcast command - sends sample success message to all users
// Set ADMIN_USER_ID environment variable to your Telegram user ID
const ADMIN_USER_ID = process.env.ADMIN_USER_ID || '';

bot.command('broadcast', async (ctx) => {
    const userId = getUserId(ctx);

    // Security: Only allow if ADMIN_USER_ID is set AND matches sender
    if (!ADMIN_USER_ID) {
        await ctx.reply('❌ Broadcast disabled. Set ADMIN_USER_ID in environment variables.');
        return;
    }

    if (userId !== ADMIN_USER_ID) {
        await ctx.reply('❌ Only the bot admin can use this command.');
        return;
    }

    const allUsers = store.getAllUsers();

    if (allUsers.length === 0) {
        await ctx.reply('❌ No users to broadcast to.');
        return;
    }

    const sampleMessage =
        `🚀 *Sample Mint Notification*\n\n` +
        `Your wallet: \`0xYour...Wallet\`\n` +
        `Hash: [View on Explorer](https://etherscan.io/)\n\n` +
        `_If you enjoy my services, give my creator a follow on X_ 👉 [@victornawf](https://x.com/victornawf2)`;

    let successCount = 0;
    let failCount = 0;

    for (const { userId: uid, data: userData } of allUsers) {
        try {
            await bot.api.sendMessage(
                userData.chatId,
                sampleMessage,
                { parse_mode: "Markdown", link_preview_options: { is_disabled: true } }
            );
            successCount++;
        } catch (err: any) {
            console.error(`Failed to broadcast to user ${uid}:`, err.message);
            failCount++;
        }
    }

    await ctx.reply(`✅ Broadcast complete!\n\nSent: ${successCount}\nFailed: ${failCount}`);
});

// Start bot
async function startBot() {
    checkMigration();
    await bot.init();
    bot.start();
    console.log('✅ Bot running as @' + bot.botInfo.username);

    // Start blockchain monitoring
    startMonitoring(bot);
}

startBot().catch(console.error);
