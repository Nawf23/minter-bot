import { Bot, Context } from 'grammy';
import { config } from './config';
import { store, MAX_KEYS, MAX_WALLETS } from './store';
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

// Helper to get username
function getUsername(ctx: Context): string | null {
    return ctx.from?.username || null;
}

// Update username on every interaction
function touchUser(ctx: Context) {
    const userId = getUserId(ctx);
    const username = getUsername(ctx);
    if (store.userExists(userId)) {
        store.updateUsername(userId, username);
    }
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

// ─── Commands ───

bot.command('start', async (ctx) => {
    performMigrationIfNeeded(ctx);
    touchUser(ctx);

    const userId = getUserId(ctx);
    const user = store.getUser(userId);

    if (!user) {
        await ctx.reply(
            `🤖 **Welcome to NFT Copy Minter Bot!**\n\n` +
            `⚠️ **USE BURNER WALLETS ONLY!** ⚠️\n\n` +
            `This bot will auto-mint NFTs when wallets you track make mints.\n\n` +
            `**Setup:**\n` +
            `1. Create fresh burner wallet(s)\n` +
            `2. Add funds for gas (small amount)\n` +
            `3. Use /addkey to add your key(s)\n` +
            `4. Use /track to add wallets to watch\n\n` +
            `**Key Commands:**\n` +
            `/addkey <key> [name] - Add a burner key (up to ${MAX_KEYS})\n` +
            `/mykeys - View your keys\n` +
            `/track <address> [name] - Track a wallet (up to ${MAX_WALLETS})\n` +
            `/status - Check bot status\n` +
            `/help - Show all commands`,
            { parse_mode: 'Markdown' }
        );
    } else {
        const walletCount = user.trackedWallets.length;
        const keyCount = user.walletKeys.length;
        await ctx.reply(
            `✅ **Bot Active**\n\n` +
            `Keys: ${keyCount}/${MAX_KEYS}\n` +
            `Tracking: ${walletCount}/${MAX_WALLETS} wallets\n\n` +
            `Use /mykeys to view keys or /help for commands.`,
            { parse_mode: 'Markdown' }
        );
    }
});

// ─── Key Management ───

bot.command('addkey', async (ctx) => {
    touchUser(ctx);
    const userId = getUserId(ctx);

    const args = ctx.message?.text?.split(' ').slice(1) || [];
    if (args.length === 0) {
        await ctx.reply(
            `Usage: /addkey <private_key> [name]\n\n` +
            `Examples:\n` +
            `/addkey 0xabc123... Main Burner\n` +
            `/addkey 0xabc123...\n\n` +
            `⚠️ USE BURNER WALLETS ONLY!\n` +
            `Max: ${MAX_KEYS} keys`
        );
        return;
    }

    const privateKey = args[0];
    const keyName = args.slice(1).join(' ') || null;

    // Validate private key
    try {
        new ethers.Wallet(privateKey);
    } catch {
        await ctx.reply('❌ Invalid private key format.');
        return;
    }

    // Delete message containing private key ASAP
    try {
        await ctx.deleteMessage();
    } catch { }

    // If user doesn't exist yet, create them
    if (!store.userExists(userId)) {
        const chatId = ctx.chat?.id || 0;
        store.addUser(userId, chatId, privateKey, keyName);
        store.updateUsername(userId, getUsername(ctx));

        const wallet = new ethers.Wallet(privateKey);
        await ctx.reply(
            `✅ **Key added!**\n\n` +
            `Name: "${keyName || 'Key 1'}"\n` +
            `Address: \`${wallet.address}\`\n\n` +
            `⚠️ Your message has been deleted for security.\n\n` +
            `Next: Use /track <address> [name] to track wallets!`,
            { parse_mode: 'Markdown' }
        );
        return;
    }

    // Add additional key
    try {
        const walletKey = store.addWalletKey(userId, privateKey, keyName);
        const keyCount = store.getWalletKeys(userId).length;

        await ctx.reply(
            `✅ **Key ${keyCount} added!**\n\n` +
            `Name: "${walletKey.name}"\n` +
            `Address: \`${walletKey.address}\`\n` +
            `Total keys: ${keyCount}/${MAX_KEYS}\n\n` +
            `⚠️ Your message has been deleted for security.`,
            { parse_mode: 'Markdown' }
        );
    } catch (err: any) {
        await ctx.reply(`❌ ${err.message}`);
    }
});

// Backwards compat: alias /addprivatekey → /addkey
bot.command('addprivatekey', async (ctx) => {
    touchUser(ctx);
    const userId = getUserId(ctx);

    if (store.userExists(userId)) {
        await ctx.reply('💡 Use /addkey to add additional keys (up to 3).\nUse /changekey <number> <new_key> to update an existing key.');
        return;
    }

    // Forward to addkey logic
    const args = ctx.message?.text?.split(' ').slice(1) || [];
    if (args.length === 0) {
        await ctx.reply('Usage: /addkey <your_private_key> [name]\n\n⚠️ USE BURNER WALLET ONLY!');
        return;
    }

    const privateKey = args[0];
    try {
        new ethers.Wallet(privateKey);
    } catch {
        await ctx.reply('❌ Invalid private key format.');
        return;
    }

    try { await ctx.deleteMessage(); } catch { }

    const chatId = ctx.chat?.id || 0;
    store.addUser(userId, chatId, privateKey);
    store.updateUsername(userId, getUsername(ctx));

    const wallet = new ethers.Wallet(privateKey);
    await ctx.reply(
        `✅ **Key added!**\n\n` +
        `Address: \`${wallet.address}\`\n\n` +
        `⚠️ Your message has been deleted for security.\n` +
        `Next: /track <address> [name] to track wallets!`,
        { parse_mode: 'Markdown' }
    );
});

bot.command('removekey', async (ctx) => {
    touchUser(ctx);
    const userId = getUserId(ctx);

    if (!store.userExists(userId)) {
        await ctx.reply('❌ Use /addkey first to set up your account.');
        return;
    }

    const args = ctx.message?.text?.split(' ').slice(1) || [];
    if (args.length === 0) {
        const keys = store.getWalletKeys(userId);
        let msg = `Usage: /removekey <number>\n\nYour keys:\n`;
        keys.forEach((k, i) => {
            msg += `${i + 1}. "${k.name}" - \`${k.address}\`\n`;
        });
        await ctx.reply(msg, { parse_mode: 'Markdown' });
        return;
    }

    const index = parseInt(args[0]);
    if (isNaN(index)) {
        await ctx.reply('❌ Please provide a key number. Use /mykeys to see your keys.');
        return;
    }

    try {
        const removed = store.removeWalletKey(userId, index);
        await ctx.reply(
            `✅ Removed key "${removed.name}" (\`${removed.address}\`)`,
            { parse_mode: 'Markdown' }
        );
    } catch (err: any) {
        await ctx.reply(`❌ ${err.message}`);
    }
});

bot.command('changekey', async (ctx) => {
    touchUser(ctx);
    const userId = getUserId(ctx);

    if (!store.userExists(userId)) {
        await ctx.reply('❌ Use /addkey first to set up your account.');
        return;
    }

    const args = ctx.message?.text?.split(' ').slice(1) || [];
    if (args.length < 2) {
        await ctx.reply(
            `Usage: /changekey <number> <new_private_key>\n\n` +
            `Example: /changekey 1 0xnew_key_here\n\n` +
            `Use /mykeys to see your key numbers.`
        );
        return;
    }

    const index = parseInt(args[0]);
    const newKey = args[1];

    if (isNaN(index)) {
        await ctx.reply('❌ First argument must be a key number.');
        return;
    }

    try {
        new ethers.Wallet(newKey);
    } catch {
        await ctx.reply('❌ Invalid private key format.');
        return;
    }

    try { await ctx.deleteMessage(); } catch { }

    try {
        const updated = store.changeWalletKey(userId, index, newKey);
        await ctx.reply(
            `✅ **Key ${index} updated!**\n\n` +
            `Name: "${updated.name}"\n` +
            `New address: \`${updated.address}\`\n\n` +
            `⚠️ Your message has been deleted for security.`,
            { parse_mode: 'Markdown' }
        );
    } catch (err: any) {
        await ctx.reply(`❌ ${err.message}`);
    }
});

// Backwards compat: alias /changeprivatekey → changekey 1
bot.command('changeprivatekey', async (ctx) => {
    touchUser(ctx);
    const userId = getUserId(ctx);

    if (!store.userExists(userId)) {
        await ctx.reply('❌ Use /addkey first to set up your account.');
        return;
    }

    const args = ctx.message?.text?.split(' ').slice(1) || [];
    if (args.length === 0) {
        await ctx.reply('Usage: /changekey <number> <new_private_key>\n\nThis updates key #1 by default.');
        return;
    }

    const newKey = args[0];
    try {
        new ethers.Wallet(newKey);
    } catch {
        await ctx.reply('❌ Invalid private key format.');
        return;
    }

    try { await ctx.deleteMessage(); } catch { }

    try {
        const updated = store.changeWalletKey(userId, 1, newKey);
        await ctx.reply(
            `✅ **Key 1 updated!**\n\n` +
            `New address: \`${updated.address}\`\n\n` +
            `⚠️ Your message has been deleted for security.`,
            { parse_mode: 'Markdown' }
        );
    } catch (err: any) {
        await ctx.reply(`❌ ${err.message}`);
    }
});

bot.command('mykeys', async (ctx) => {
    touchUser(ctx);
    const userId = getUserId(ctx);

    if (!store.userExists(userId)) {
        await ctx.reply('❌ Use /addkey first to set up your account.');
        return;
    }

    const keys = store.getWalletKeys(userId);

    if (keys.length === 0) {
        await ctx.reply('📭 No keys added yet.\n\nUse /addkey <key> [name] to add one!');
        return;
    }

    let message = `🔑 **Your Keys (${keys.length}/${MAX_KEYS})**\n\n`;
    keys.forEach((key, i) => {
        const displayName = key.name ? ` - "${key.name}"` : '';
        message += `${i + 1}. \`${key.address}\`${displayName}\n`;
    });

    message += `\n/addkey - Add another key\n/removekey <n> - Remove\n/changekey <n> <key> - Replace`;

    await ctx.reply(message, { parse_mode: 'Markdown' });
});

// ─── Wallet Tracking ───

bot.command('track', async (ctx) => {
    performMigrationIfNeeded(ctx);
    touchUser(ctx);

    const userId = getUserId(ctx);

    if (!store.userExists(userId)) {
        await ctx.reply('❌ Use /addkey first to set up your account.');
        return;
    }

    const args = ctx.message?.text?.split(' ').slice(1) || [];
    if (args.length === 0) {
        await ctx.reply(`Usage: /track <wallet_address> [optional_name]\n\nExample:\n/track 0xabc... Cool Trader\n\nMax: ${MAX_WALLETS} wallets`);
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
    touchUser(ctx);
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
    touchUser(ctx);
    const userId = getUserId(ctx);

    if (!store.userExists(userId)) {
        await ctx.reply('❌ Use /addkey first to set up your account.');
        return;
    }

    const wallets = store.getTrackedWallets(userId);

    if (wallets.length === 0) {
        await ctx.reply('📭 Not tracking any wallets yet.\n\nUse /track <address> [name] to add one!');
        return;
    }

    let message = `📋 **Your Tracked Wallets (${wallets.length}/${MAX_WALLETS})**\n\n`;
    wallets.forEach((wallet, i) => {
        const displayName = wallet.name ? ` - "${wallet.name}"` : '';
        message += `${i + 1}. \`${wallet.address}\`${displayName}\n`;
    });

    message += `\nUse /remove <address> to stop tracking.`;

    await ctx.reply(message, { parse_mode: 'Markdown' });
});

// ─── Info ───

bot.command('status', async (ctx) => {
    touchUser(ctx);
    const userId = getUserId(ctx);

    if (!store.userExists(userId)) {
        await ctx.reply('❌ Use /addkey first to set up your account.');
        return;
    }

    const keys = store.getWalletKeys(userId);
    const wallets = store.getTrackedWallets(userId);

    let keyList = '';
    keys.forEach((key, i) => {
        const label = key.name ? ` "${key.name}"` : '';
        const autoListIcon = key.autoList ? ' 🏷️' : '';
        keyList += `  ${i + 1}. \`${key.address}\`${label}${autoListIcon}\n`;
    });

    // Detect active chains
    const activeChains = ['ETH'];
    if (config.rpcUrlBase) activeChains.push('BASE');
    if (config.rpcUrlArb) activeChains.push('ARB');
    if (config.rpcUrlOp) activeChains.push('OP');
    if (config.rpcUrlPoly) activeChains.push('POLY');

    await ctx.reply(
        `🤖 **Bot Status**\n\n` +
        `**Your Keys (${keys.length}/${MAX_KEYS}):**\n${keyList}\n` +
        `Tracking: ${wallets.length}/${MAX_WALLETS} wallets\n` +
        `Chains: ${activeChains.join(' + ')}\n` +
        `Mode: Free mints only\n\n` +
        `✅ Active and monitoring!`,
        { parse_mode: 'Markdown' }
    );
});

// ─── Stats ───

bot.command('stats', async (ctx) => {
    touchUser(ctx);
    const userId = getUserId(ctx);

    if (!store.userExists(userId)) {
        await ctx.reply('❌ Use /addkey first to set up your account.');
        return;
    }

    const { keys, totals } = store.getStats(userId);

    const successRate = totals.mintsAttempted > 0
        ? Math.round((totals.mintsSucceeded / totals.mintsAttempted) * 100)
        : 0;

    let msg = `📊 **Your Mint Stats**\n\n`;
    msg += `**Overall:**\n`;
    msg += `  Attempted: ${totals.mintsAttempted}\n`;
    msg += `  ✅ Succeeded: ${totals.mintsSucceeded}\n`;
    msg += `  ❌ Failed: ${totals.mintsFailed}\n`;
    msg += `  📈 Success Rate: ${successRate}%\n`;

    if (totals.lastMintAt) {
        const lastMint = new Date(totals.lastMintAt);
        msg += `  🕐 Last Activity: ${lastMint.toLocaleDateString()} ${lastMint.toLocaleTimeString()}\n`;
    }

    if (keys.length > 1) {
        msg += `\n**Per Key:**\n`;
        for (const k of keys) {
            const label = k.name ? `"${k.name}"` : k.address.substring(0, 10) + '...';
            const rate = k.stats.mintsAttempted > 0
                ? Math.round((k.stats.mintsSucceeded / k.stats.mintsAttempted) * 100)
                : 0;
            msg += `  ${label}: ${k.stats.mintsSucceeded}✅ / ${k.stats.mintsFailed}❌ (${rate}%)\n`;
        }
    }

    await ctx.reply(msg, { parse_mode: 'Markdown' });
});

// ─── Auto-List ───

bot.command('autolist', async (ctx) => {
    touchUser(ctx);
    const userId = getUserId(ctx);

    if (!store.userExists(userId)) {
        await ctx.reply('❌ Use /addkey first to set up your account.');
        return;
    }

    const args = ctx.message?.text?.split(' ').slice(1) || [];
    if (args.length < 2) {
        const keys = store.getWalletKeys(userId);
        let msg = `🏷️ **Auto-List Settings**\n\n`;
        msg += `Usage: /autolist <key_number> <on|off>\n\n`;
        msg += `**Your Keys:**\n`;
        keys.forEach((key, i) => {
            const status = key.autoList ? '✅ ON' : '❌ OFF';
            const label = key.name || `Key ${i + 1}`;
            msg += `  ${i + 1}. "${label}" - ${status}\n`;
        });
        msg += `\n_When enabled, successfully minted NFTs will be auto-listed on OpenSea._`;
        await ctx.reply(msg, { parse_mode: 'Markdown' });
        return;
    }

    const keyNum = parseInt(args[0]);
    const toggle = args[1].toLowerCase();

    if (isNaN(keyNum)) {
        await ctx.reply('❌ First argument must be a key number.');
        return;
    }

    if (toggle !== 'on' && toggle !== 'off') {
        await ctx.reply('❌ Second argument must be "on" or "off".');
        return;
    }

    try {
        const enabled = toggle === 'on';
        store.setAutoList(userId, keyNum, enabled);
        const keys = store.getWalletKeys(userId);
        const key = keys[keyNum - 1];
        const label = key?.name || `Key ${keyNum}`;

        if (enabled && !config.openSeaApiKey) {
            await ctx.reply(
                `⚠️ Auto-list enabled for "${label}", but OpenSea API key is not configured.\n` +
                `Contact the admin to set OPENSEA_API_KEY.`
            );
        } else {
            await ctx.reply(
                `✅ Auto-list ${enabled ? 'enabled' : 'disabled'} for "${label}" (\`${key?.address}\`)`,
                { parse_mode: 'Markdown' }
            );
        }
    } catch (err: any) {
        await ctx.reply(`❌ ${err.message}`);
    }
});

bot.command('deleteaccount', async (ctx) => {
    touchUser(ctx);
    const userId = getUserId(ctx);

    if (!store.userExists(userId)) {
        await ctx.reply('❌ No account found.');
        return;
    }

    const keys = store.getWalletKeys(userId);

    await ctx.reply(
        `⚠️ **WARNING**\n\n` +
        `This will delete:\n` +
        `- All ${keys.length} encrypted key(s)\n` +
        `- All tracked wallets\n\n` +
        `Type /confirmdelete to proceed.`,
        { parse_mode: 'Markdown' }
    );
});

bot.command('confirmdelete', async (ctx) => {
    touchUser(ctx);
    const userId = getUserId(ctx);

    if (!store.userExists(userId)) {
        await ctx.reply('❌ No account found.');
        return;
    }

    store.deleteUser(userId);
    await ctx.reply('✅ Account deleted. Use /start to set up again.');
});

bot.command('help', async (ctx) => {
    touchUser(ctx);
    await ctx.reply(
        `🤖 **NFT Copy Minter Bot - Commands**\n\n` +
        `**Keys (up to ${MAX_KEYS}):**\n` +
        `/addkey <key> [name] - Add a burner key\n` +
        `/removekey <number> - Remove a key\n` +
        `/changekey <n> <key> - Replace a key\n` +
        `/mykeys - View your keys\n\n` +
        `**Tracking (up to ${MAX_WALLETS}):**\n` +
        `/track <address> [name] - Track a wallet\n` +
        `/remove <address> - Stop tracking wallet\n` +
        `/mywallets - View tracked wallets\n\n` +
        `**Stats & Settings:**\n` +
        `/stats - View your mint statistics\n` +
        `/autolist - Auto-list mints on OpenSea\n\n` +
        `**Info:**\n` +
        `/status - Check bot status\n` +
        `/deleteaccount - Delete all data\n` +
        `/help - Show this message\n\n` +
        `⚠️ **ALWAYS USE BURNER WALLETS!**`,
        { parse_mode: 'Markdown' }
    );
});

// ─── Admin Commands ───

const ADMIN_USER_ID = process.env.ADMIN_USER_ID || '';

bot.command('broadcast', async (ctx) => {
    const userId = getUserId(ctx);

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

// ─── Start Bot ───

async function startBot() {
    checkMigration();
    await bot.init();
    bot.start();
    console.log('✅ Bot running as @' + bot.botInfo.username);

    // Start blockchain monitoring
    startMonitoring(bot);
}

startBot().catch(console.error);
