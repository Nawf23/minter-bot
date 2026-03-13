import { Bot, Context, InlineKeyboard } from 'grammy';
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
    const paths = [
        path.resolve(process.cwd(), 'db.json'),
        path.resolve(__dirname, '../db.json')
    ];

    for (const p of paths) {
        if (fs.existsSync(p)) {
            const raw = fs.readFileSync(p, 'utf-8');
            try {
                const parsed = JSON.parse(raw);
                if (parsed.trackedWallets && !parsed.users) {
                    console.log(`🔄 Old data format detected at ${p}. Migration ready.`);

                    // Auto-migrate admin on startup if vars are set
                    const adminId = (process.env.ADMIN_USER_ID || '').trim();
                    if (adminId && config.privateKey) {
                        console.log(`👑 Auto-migrating admin data for ${adminId}...`);
                        store.migrateToMultiUser(adminId, parsed.chatId || 0, config.privateKey, parsed.trackedWallets);
                        // Rename migrated file to avoid re-run
                        try { fs.renameSync(p, p + '.migrated'); } catch (e) { }
                    }
                }
            } catch (e) { }
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
    const text = ctx.message?.text || '(media/button)';

    console.log(`💬 [Telegram] ${username || 'user'} (${userId}): ${text}`);

    // Trigger migration on any interaction
    performMigrationIfNeeded(ctx);

    if (store.userExists(userId)) {
        store.updateUsername(userId, username);
    }
}

// ─── Menu Builders ───

function buildMainMenu(userId: string): { text: string; keyboard: InlineKeyboard } {
    const user = store.getUser(userId);
    const keyCount = user?.walletKeys.length || 0;
    const walletCount = user?.trackedWallets.length || 0;

    // Detect active chains
    const activeChains = ['ETH'];
    if (config.rpcUrlBase) activeChains.push('BASE');
    if (config.rpcUrlArb) activeChains.push('ARB');
    if (config.rpcUrlOp) activeChains.push('OP');
    if (config.rpcUrlPoly) activeChains.push('POLY');

    const text =
        `🤖 *NFT Copy Minter Bot*\n\n` +
        `🔑 Keys: ${keyCount}/${MAX_KEYS}\n` +
        `👀 Tracking: ${walletCount}/${MAX_WALLETS} wallets\n` +
        `⛓ Chains: ${activeChains.join(' · ')}\n` +
        `✅ Status: Active & Monitoring`;

    const keyboard = new InlineKeyboard()
        .text('🔑 My Keys', 'menu_keys').text('👀 Wallets', 'menu_wallets').row()
        .text('📊 Stats', 'menu_stats').text('ℹ️ Status', 'menu_status').row()
        .text('❓ Help', 'menu_help').text('🔄 Refresh', 'menu_refresh');

    return { text, keyboard };
}

function buildKeysMenu(userId: string): { text: string; keyboard: InlineKeyboard } {
    const keys = store.getWalletKeys(userId);

    let text = `🔑 *Your Keys (${keys.length}/${MAX_KEYS})*\n\n`;
    if (keys.length === 0) {
        text += `📭 No keys added yet\n\n`;
        text += `_Send /addkey <private\_key> [name] to add one_`;
    } else {
        keys.forEach((key, i) => {
            const label = key.name ? ` — "${key.name}"` : '';
            text += `${i + 1}. \`${key.address}\`${label}\n`;
        });
        text += `\n_Use commands to manage keys:_\n`;
        text += `/addkey <key> [name]\n`;
        text += `/removekey <n> · /changekey <n> <key>`;
    }

    const keyboard = new InlineKeyboard()
        .text('← Back', 'menu_main');

    return { text, keyboard };
}

function buildWalletsMenu(userId: string): { text: string; keyboard: InlineKeyboard } {
    const wallets = store.getTrackedWallets(userId);

    let text = `👀 *Tracked Wallets (${wallets.length}/${MAX_WALLETS})*\n\n`;
    if (wallets.length === 0) {
        text += `📭 Not tracking any wallets\n\n`;
        text += `_Send /track <address> [name] to add one_`;
    } else {
        // Show first 15 wallets to avoid message limit
        const show = wallets.slice(0, 15);
        show.forEach((w, i) => {
            const label = w.name ? ` — "${w.name}"` : '';
            text += `${i + 1}. \`${w.address.substring(0, 10)}...${w.address.substring(38)}\`${label}\n`;
        });
        if (wallets.length > 15) {
            text += `\n_...and ${wallets.length - 15} more. Use /mywallets to see all._\n`;
        }
        text += `\n_Commands:_\n`;
        text += `/track <address> [name]\n`;
        text += `/remove <address>`;
    }

    const keyboard = new InlineKeyboard()
        .text('← Back', 'menu_main');

    return { text, keyboard };
}

function buildStatsMenu(userId: string): { text: string; keyboard: InlineKeyboard } {
    const { keys, totals } = store.getStats(userId);
    const successRate = totals.mintsAttempted > 0
        ? Math.round((totals.mintsSucceeded / totals.mintsAttempted) * 100)
        : 0;

    let text = `📊 *Mint Statistics*\n\n`;
    text += `Attempted: ${totals.mintsAttempted}\n`;
    text += `✅ Succeeded: ${totals.mintsSucceeded}\n`;
    text += `❌ Failed: ${totals.mintsFailed}\n`;
    text += `📈 Success Rate: ${successRate}%\n`;

    if (totals.lastMintAt) {
        const d = new Date(totals.lastMintAt);
        text += `🕐 Last: ${d.toLocaleDateString()} ${d.toLocaleTimeString()}\n`;
    }

    if (keys.length > 1) {
        text += `\n*Per Key:*\n`;
        for (const k of keys) {
            const label = k.name ? `"${k.name}"` : k.address.substring(0, 10) + '...';
            const rate = k.stats.mintsAttempted > 0
                ? Math.round((k.stats.mintsSucceeded / k.stats.mintsAttempted) * 100)
                : 0;
            text += `  ${label}: ${k.stats.mintsSucceeded}✅ / ${k.stats.mintsFailed}❌ (${rate}%)\n`;
        }
    }

    const keyboard = new InlineKeyboard()
        .text('🔄 Refresh', 'menu_stats').text('← Back', 'menu_main');

    return { text, keyboard };
}

function buildStatusMenu(userId: string): { text: string; keyboard: InlineKeyboard } {
    const keys = store.getWalletKeys(userId);
    const wallets = store.getTrackedWallets(userId);

    const activeChains = ['ETH'];
    if (config.rpcUrlBase) activeChains.push('BASE');
    if (config.rpcUrlArb) activeChains.push('ARB');
    if (config.rpcUrlOp) activeChains.push('OP');
    if (config.rpcUrlPoly) activeChains.push('POLY');

    let keyList = '';
    keys.forEach((key, i) => {
        const label = key.name ? ` "${key.name}"` : '';
        keyList += `  ${i + 1}. \`${key.address}\`${label}\n`;
    });

    const text =
        `ℹ️ *Bot Status*\n\n` +
        `*Keys (${keys.length}/${MAX_KEYS}):*\n${keyList}\n` +
        `Tracking: ${wallets.length}/${MAX_WALLETS} wallets\n` +
        `Chains: ${activeChains.join(' + ')}\n` +
        `Mode: Free mints only\n\n` +
        `✅ Active and monitoring!`;

    const keyboard = new InlineKeyboard()
        .text('🔄 Refresh', 'menu_status').text('← Back', 'menu_main');

    return { text, keyboard };
}

function buildHelpMenu(): { text: string; keyboard: InlineKeyboard } {
    const text =
        `❓ *Commands*\n\n` +
        `*Keys (up to ${MAX_KEYS}):*\n` +
        `/addkey <key> [name]\n` +
        `/removekey <n> · /changekey <n> <key>\n` +
        `/mykeys\n\n` +
        `*Tracking (up to ${MAX_WALLETS}):*\n` +
        `/track <address> [name]\n` +
        `/remove <address> · /mywallets\n\n` +
        `*Info:*\n` +
        `/status · /stats · /myid\n\n` +
        `⚠️ *ALWAYS USE BURNER WALLETS!*`;

    const keyboard = new InlineKeyboard()
        .text('← Back', 'menu_main');

    return { text, keyboard };
}

// ─── Callback Query Handler ───

bot.on('callback_query:data', async (ctx) => {
    const userId = getUserId(ctx);
    const data = ctx.callbackQuery.data;

    if (!store.userExists(userId)) {
        await ctx.answerCallbackQuery({ text: '❌ Use /addkey first' });
        return;
    }

    let menu: { text: string; keyboard: InlineKeyboard };

    switch (data) {
        case 'menu_main':
        case 'menu_refresh':
            menu = buildMainMenu(userId);
            break;
        case 'menu_keys':
            menu = buildKeysMenu(userId);
            break;
        case 'menu_wallets':
            menu = buildWalletsMenu(userId);
            break;
        case 'menu_stats':
            menu = buildStatsMenu(userId);
            break;
        case 'menu_status':
            menu = buildStatusMenu(userId);
            break;
        case 'menu_help':
            menu = buildHelpMenu();
            break;
        default:
            await ctx.answerCallbackQuery();
            return;
    }

    try {
        await ctx.editMessageText(menu.text, {
            parse_mode: 'Markdown',
            reply_markup: menu.keyboard,
        });
    } catch (err: any) {
        // Telegram throws if message content hasn't changed (e.g. Refresh pressed too fast)
        if (!err.message?.includes('message is not modified')) {
            console.error(`Menu error: ${err.message}`);
        }
    }

    await ctx.answerCallbackQuery();
});

// Helper to check if migration is needed and perform it
function performMigrationIfNeeded(ctx: Context) {
    const userId = getUserId(ctx);
    if (store.userExists(userId)) return false;

    const paths = [
        path.resolve(process.cwd(), 'db.json'),
        path.resolve(__dirname, '../db.json')
    ];

    for (const p of paths) {
        if (fs.existsSync(p)) {
            try {
                const raw = fs.readFileSync(p, 'utf-8');
                const parsed = JSON.parse(raw);

                if (parsed.trackedWallets && !parsed.users && config.privateKey) {
                    const chatId = ctx.chat?.id || 0;
                    store.migrateToMultiUser(userId, chatId, config.privateKey, parsed.trackedWallets);
                    ctx.reply('✅ Your tracking data has been migrated to the new system!');
                    try { fs.renameSync(p, p + '.migrated'); } catch (e) { }
                    return true;
                }
            } catch (e) { }
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
            `🤖 *Welcome to NFT Copy Minter Bot!*\n\n` +
            `⚠️ *USE BURNER WALLETS ONLY!* ⚠️\n\n` +
            `This bot auto-mints NFTs when wallets you track make mints.\n\n` +
            `*Quick Setup:*\n` +
            `1️⃣ /addkey <private\_key> [name]\n` +
            `2️⃣ /track <wallet\_address> [name]\n` +
            `3️⃣ Done! Bot will auto-copy free mints.`,
            { parse_mode: 'Markdown' }
        );
    } else {
        const menu = buildMainMenu(userId);
        await ctx.reply(menu.text, {
            parse_mode: 'Markdown',
            reply_markup: menu.keyboard,
        });
    }
});

bot.command('myid', async (ctx) => {
    const userId = getUserId(ctx);
    await ctx.reply(`🆔 Your Telegram ID is: \`${userId}\`\n\nUse this value for \`ADMIN_USER_ID\` in Railway to prioritize yourself.`);
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
        keyList += `  ${i + 1}. \`${key.address}\`${label}\n`;
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
        `/stats - View your mint statistics\n\n` +
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
