import dotenv from 'dotenv';
import { resolve } from 'path';

// Load .env file
dotenv.config({ path: resolve(__dirname, '../.env') });

export const config = {
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',

    // ─── Chain RPCs (HTTP) ───
    rpcUrl: process.env.RPC_URL || '',
    rpcUrlBase: process.env.RPC_URL_BASE || '',
    rpcUrlArb: process.env.RPC_URL_ARB || '',
    rpcUrlOp: process.env.RPC_URL_OP || '',
    rpcUrlPoly: process.env.RPC_URL_POLY || '',

    // ─── WebSocket RPCs (optional, for faster block detection) ───
    wsUrl: process.env.WS_URL || '',
    wsUrlBase: process.env.WS_URL_BASE || '',
    wsUrlArb: process.env.WS_URL_ARB || '',
    wsUrlOp: process.env.WS_URL_OP || '',
    wsUrlPoly: process.env.WS_URL_POLY || '',

    // ─── Legacy ───
    privateKey: process.env.PRIVATE_KEY || '',

    // ─── Security ───
    encryptionKey: process.env.ENCRYPTION_KEY || '',

    // ─── OpenSea (optional) ───
    openSeaApiKey: process.env.OPENSEA_API_KEY || '',
};

// Validation
const missing: string[] = [];
if (!config.telegramBotToken) missing.push('TELEGRAM_BOT_TOKEN');
if (!config.rpcUrl) missing.push('RPC_URL');
if (!config.encryptionKey) missing.push('ENCRYPTION_KEY');

if (missing.length > 0) {
    console.error(`❌ Missing required environment variables: ${missing.join(', ')}`);
    process.exit(1);
}

console.log('✅ Configuration loaded successfully.');

// Log which chains are active
const activeChains = ['ETH'];
if (config.rpcUrlBase) activeChains.push('BASE');
if (config.rpcUrlArb) activeChains.push('ARB');
if (config.rpcUrlOp) activeChains.push('OP');
if (config.rpcUrlPoly) activeChains.push('POLY');
console.log(`🔗 Active chains: ${activeChains.join(', ')}`);

const wsChains: string[] = [];
if (config.wsUrl) wsChains.push('ETH');
if (config.wsUrlBase) wsChains.push('BASE');
if (config.wsUrlArb) wsChains.push('ARB');
if (config.wsUrlOp) wsChains.push('OP');
if (config.wsUrlPoly) wsChains.push('POLY');
if (wsChains.length > 0) {
    console.log(`⚡ WebSocket enabled for: ${wsChains.join(', ')}`);
} else {
    console.log(`📡 Using HTTP polling only (set WS_URL for faster detection)`);
}
