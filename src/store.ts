import fs from 'fs';
import path from 'path';
import { encrypt, decrypt } from './crypto';
import { ethers } from 'ethers';

const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, '../data');
const DB_PATH = path.join(DATA_DIR, 'db.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    console.log(`📁 Created data directory: ${DATA_DIR}`);
}

// ─── Limits ───
export const MAX_KEYS = 3;
export const MAX_WALLETS = 20;

// ─── Interfaces ───

export interface WalletKey {
    privateKey: string;     // Encrypted
    name: string | null;    // User-given name (e.g. "Main Burner")
    address: string;        // Public address (derived, for display)
    autoList: boolean;      // Auto-list minted NFTs on OpenSea
}

export interface TrackedWallet {
    address: string;
    name: string | null;
}

export interface KeyStats {
    mintsAttempted: number;
    mintsSucceeded: number;
    mintsFailed: number;
    lastMintAt: string | null;  // ISO timestamp
}

export interface UserStats {
    [keyAddress: string]: KeyStats;
}

export interface UserData {
    walletKeys: WalletKey[];        // Up to MAX_KEYS
    trackedWallets: TrackedWallet[];  // Up to MAX_WALLETS
    chatId: number;
    username: string | null;         // Telegram @username
    stats: UserStats;                // Per-key stats
}

export interface BotData {
    users: {
        [userId: string]: UserData;
    };
}

// ─── Helpers ───

/** Derive public address from a raw private key */
function deriveAddress(rawPrivateKey: string): string {
    try {
        const wallet = new ethers.Wallet(rawPrivateKey);
        return wallet.address;
    } catch {
        return '0x???';
    }
}

/** Format user identifier for logs: @username (chatId) or just (chatId) */
export function formatUserLog(userId: string, userData: UserData): string {
    if (userData.username) {
        return `@${userData.username} (${userId})`;
    }
    return `user ${userId}`;
}

// ─── Store Class ───

class Store {
    private data: BotData = { users: {} };
    public dataVersion: number = 0;

    constructor() {
        this.load();
    }

    private load() {
        try {
            if (fs.existsSync(DB_PATH)) {
                const raw = fs.readFileSync(DB_PATH, 'utf-8');
                const parsed = JSON.parse(raw);

                // Check if old format (needs migration)
                if (parsed.trackedWallets && !parsed.users) {
                    console.log('🔄 Detected old data format. Migration needed.');
                    this.data = { users: {} };
                } else {
                    this.data = parsed;
                    // Auto-migrate any users still on old format
                    this.migrateExistingUsersToMultiKey();
                }
            }
        } catch (err) {
            console.error('Error loading database:', err);
            this.data = { users: {} };
        }
    }

    /**
     * Migrate users from old single `privateKey` field to new `walletKeys[]` array.
     * Also adds missing fields (stats, autoList, username).
     */
    private migrateExistingUsersToMultiKey() {
        let migrated = 0;
        for (const [userId, userData] of Object.entries(this.data.users)) {
            const raw = userData as any;

            // Old format: has `privateKey` string, no `walletKeys` array
            if (raw.privateKey && !raw.walletKeys) {
                let address = '0x???';
                try {
                    const decrypted = decrypt(raw.privateKey);
                    address = deriveAddress(decrypted);
                } catch { }

                (userData as UserData).walletKeys = [{
                    privateKey: raw.privateKey,
                    name: 'Key 1',
                    address,
                    autoList: false,
                }];

                delete raw.privateKey;
                migrated++;
                console.log(`  🔄 Migrated user ${userId} → walletKeys[0] (${address.substring(0, 10)}...)`);
            }

            // Ensure new fields exist
            if (!raw.username) userData.username = null;
            if (!raw.stats) userData.stats = {};

            // Ensure autoList field exists on all keys
            if (userData.walletKeys) {
                for (const key of userData.walletKeys) {
                    if ((key as any).autoList === undefined) {
                        key.autoList = false;
                    }
                }
            }
        }

        if (migrated > 0) {
            this.save();
            console.log(`✅ Migrated ${migrated} user(s) to multi-key format.`);
        }
    }

    private save(structuralChange: boolean = false) {
        try {
            if (structuralChange) {
                this.dataVersion++;
            }
            fs.writeFileSync(DB_PATH, JSON.stringify(this.data, null, 2));
        } catch (err) {
            console.error('Error saving database:', err);
        }
    }

    // ─── Data Access ───

    get(): BotData {
        return this.data;
    }

    // ─── User Management ───

    getUser(userId: string): UserData | null {
        return this.data.users[userId] || null;
    }

    userExists(userId: string): boolean {
        return !!this.data.users[userId];
    }

    updateUsername(userId: string, username: string | null) {
        if (this.data.users[userId] && this.data.users[userId].username !== username) {
            this.data.users[userId].username = username || null;
            this.save();
        }
    }

    addUser(userId: string, chatId: number, privateKey: string, keyName: string | null = null) {
        const address = deriveAddress(privateKey);
        const encryptedKey = encrypt(privateKey);

        this.data.users[userId] = {
            walletKeys: [{
                privateKey: encryptedKey,
                name: keyName || 'Key 1',
                address,
                autoList: false,
            }],
            trackedWallets: [],
            chatId,
            username: null,
            stats: {},
        };
        this.save(true);
    }

    deleteUser(userId: string) {
        delete this.data.users[userId];
        this.save(true);
    }

    getAllUsers(): Array<{ userId: string; data: UserData }> {
        return Object.entries(this.data.users).map(([userId, data]) => ({
            userId,
            data,
        }));
    }

    // ─── Multi-Key Management ───

    addWalletKey(userId: string, privateKey: string, name: string | null = null): WalletKey {
        const user = this.data.users[userId];
        if (!user) throw new Error('User not found');
        if (user.walletKeys.length >= MAX_KEYS) {
            throw new Error(`Maximum ${MAX_KEYS} keys allowed`);
        }

        const address = deriveAddress(privateKey);

        if (user.walletKeys.some(k => k.address.toLowerCase() === address.toLowerCase())) {
            throw new Error('This wallet is already added');
        }

        const keyIndex = user.walletKeys.length + 1;
        const walletKey: WalletKey = {
            privateKey: encrypt(privateKey),
            name: name || `Key ${keyIndex}`,
            address,
            autoList: false,
        };

        user.walletKeys.push(walletKey);
        this.save();
        return walletKey;
    }

    removeWalletKey(userId: string, index: number) {
        const user = this.data.users[userId];
        if (!user) throw new Error('User not found');

        if (index < 1 || index > user.walletKeys.length) {
            throw new Error(`Invalid key number. You have ${user.walletKeys.length} key(s)`);
        }

        if (user.walletKeys.length <= 1) {
            throw new Error('Cannot remove your last key. Use /deleteaccount to remove everything');
        }

        const removed = user.walletKeys.splice(index - 1, 1)[0];
        this.save();
        return removed;
    }

    changeWalletKey(userId: string, index: number, newPrivateKey: string): WalletKey {
        const user = this.data.users[userId];
        if (!user) throw new Error('User not found');

        if (index < 1 || index > user.walletKeys.length) {
            throw new Error(`Invalid key number. You have ${user.walletKeys.length} key(s)`);
        }

        const address = deriveAddress(newPrivateKey);
        const oldName = user.walletKeys[index - 1].name;
        const oldAutoList = user.walletKeys[index - 1].autoList;

        user.walletKeys[index - 1] = {
            privateKey: encrypt(newPrivateKey),
            name: oldName,
            address,
            autoList: oldAutoList,
        };

        this.save();
        return user.walletKeys[index - 1];
    }

    getWalletKeys(userId: string): WalletKey[] {
        return this.data.users[userId]?.walletKeys || [];
    }

    getDecryptedPrivateKey(userId: string): string | null {
        const user = this.data.users[userId];
        if (!user || user.walletKeys.length === 0) return null;
        try {
            return decrypt(user.walletKeys[0].privateKey);
        } catch {
            return null;
        }
    }

    getAllDecryptedKeys(userId: string): Array<{ privateKey: string; name: string | null; address: string; autoList: boolean }> {
        const user = this.data.users[userId];
        if (!user) return [];

        const results: Array<{ privateKey: string; name: string | null; address: string; autoList: boolean }> = [];
        for (const key of user.walletKeys) {
            try {
                const decrypted = decrypt(key.privateKey);
                results.push({
                    privateKey: decrypted,
                    name: key.name,
                    address: key.address,
                    autoList: key.autoList || false,
                });
            } catch (err) {
                console.error(`Failed to decrypt key for user ${userId}:`, err);
            }
        }
        return results;
    }

    // ─── Auto-List Management ───

    setAutoList(userId: string, keyIndex: number, enabled: boolean) {
        const user = this.data.users[userId];
        if (!user) throw new Error('User not found');
        if (keyIndex < 1 || keyIndex > user.walletKeys.length) {
            throw new Error(`Invalid key number. You have ${user.walletKeys.length} key(s)`);
        }
        user.walletKeys[keyIndex - 1].autoList = enabled;
        this.save(true);
    }

    // ─── Stats ───

    recordMintAttempt(userId: string, keyAddress: string, success: boolean) {
        const user = this.data.users[userId];
        if (!user) return;

        if (!user.stats) user.stats = {};
        if (!user.stats[keyAddress]) {
            user.stats[keyAddress] = {
                mintsAttempted: 0,
                mintsSucceeded: 0,
                mintsFailed: 0,
                lastMintAt: null,
            };
        }

        const stats = user.stats[keyAddress];
        stats.mintsAttempted++;
        if (success) {
            stats.mintsSucceeded++;
        } else {
            stats.mintsFailed++;
        }
        stats.lastMintAt = new Date().toISOString();
        this.save(false);
    }

    getStats(userId: string): { keys: Array<{ name: string | null; address: string; stats: KeyStats }>; totals: KeyStats } {
        const user = this.data.users[userId];
        if (!user) return { keys: [], totals: { mintsAttempted: 0, mintsSucceeded: 0, mintsFailed: 0, lastMintAt: null } };

        const totals: KeyStats = { mintsAttempted: 0, mintsSucceeded: 0, mintsFailed: 0, lastMintAt: null };
        const keys: Array<{ name: string | null; address: string; stats: KeyStats }> = [];

        for (const key of user.walletKeys) {
            const keyStats = user.stats?.[key.address] || {
                mintsAttempted: 0,
                mintsSucceeded: 0,
                mintsFailed: 0,
                lastMintAt: null,
            };

            keys.push({ name: key.name, address: key.address, stats: keyStats });

            totals.mintsAttempted += keyStats.mintsAttempted;
            totals.mintsSucceeded += keyStats.mintsSucceeded;
            totals.mintsFailed += keyStats.mintsFailed;

            if (keyStats.lastMintAt) {
                if (!totals.lastMintAt || keyStats.lastMintAt > totals.lastMintAt) {
                    totals.lastMintAt = keyStats.lastMintAt;
                }
            }
        }

        return { keys, totals };
    }

    // ─── Wallet Management ───

    addTrackedWallet(userId: string, address: string, name: string | null = null) {
        if (!this.data.users[userId]) {
            throw new Error('User not found');
        }

        const wallets = this.data.users[userId].trackedWallets;

        if (wallets.some(w => w.address.toLowerCase() === address.toLowerCase())) {
            throw new Error('Already tracking this wallet');
        }

        if (wallets.length >= MAX_WALLETS) {
            throw new Error(`Maximum ${MAX_WALLETS} wallets allowed`);
        }

        wallets.push({ address, name });
        this.save(true);
    }

    removeTrackedWallet(userId: string, address: string) {
        if (!this.data.users[userId]) {
            throw new Error('User not found');
        }

        const wallets = this.data.users[userId].trackedWallets;
        const index = wallets.findIndex(w => w.address.toLowerCase() === address.toLowerCase());

        if (index === -1) {
            throw new Error('Wallet not found');
        }

        wallets.splice(index, 1);
        this.save(true);
    }

    getTrackedWallets(userId: string): TrackedWallet[] {
        return this.data.users[userId]?.trackedWallets || [];
    }

    // ─── Legacy Migration ───

    migrateToMultiUser(userId: string, chatId: number, oldPrivateKey: string, oldWallets: string[]) {
        const address = deriveAddress(oldPrivateKey);
        const encryptedKey = encrypt(oldPrivateKey);

        this.data.users[userId] = {
            walletKeys: [{
                privateKey: encryptedKey,
                name: 'Key 1',
                address,
                autoList: false,
            }],
            trackedWallets: oldWallets.map(addr => ({ address: addr, name: null })),
            chatId,
            username: null,
            stats: {},
        };
        this.save();
        console.log(`✅ Migrated data to user ${userId}`);
    }
}

export const store = new Store();
