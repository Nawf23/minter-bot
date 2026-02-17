import dotenv from 'dotenv';
import { resolve } from 'path';

// Load .env file
dotenv.config({ path: resolve(__dirname, '../.env') });

export const config = {
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
    rpcUrl: process.env.RPC_URL || '',
    rpcUrlBase: process.env.RPC_URL_BASE || '',
    privateKey: process.env.PRIVATE_KEY || '', // Legacy, for migration only
    encryptionKey: process.env.ENCRYPTION_KEY || '',
};

// Validation
if (!config.telegramBotToken || !config.rpcUrl || !config.encryptionKey) {
    console.error('❌ Missing required environment variables. Check .env file.');
    process.exit(1);
}

console.log('✅ Configuration loaded successfully.');
