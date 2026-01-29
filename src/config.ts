import dotenv from 'dotenv';
import { resolve } from 'path';

// Load .env file
dotenv.config({ path: resolve(__dirname, '../.env') });

export const config = {
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
    rpcUrl: process.env.RPC_URL || '',
    rpcUrlBase: process.env.RPC_URL_BASE || '',
    privateKey: process.env.PRIVATE_KEY || '',
};

if (!config.telegramBotToken) {
    console.error("❌ Missing TELEGRAM_BOT_TOKEN in .env");
    process.exit(1);
}

if (!config.rpcUrl) {
    console.error("❌ Missing RPC_URL in .env");
    process.exit(1);
}

if (!config.privateKey) {
    console.error("❌ Missing PRIVATE_KEY in .env");
    process.exit(1);
}

console.log("✅ Configuration loaded successfully.");
