import fs from 'fs';
import path from 'path';
import { encrypt, decrypt } from './crypto';

const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, '../data');
const DB_PATH = path.join(DATA_DIR, 'db.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    console.log(`📁 Created data directory: ${DATA_DIR}`);
}

export interface TrackedWallet {
    address: string;
    name: string | null;
}

export interface UserData {
    privateKey: string; // Encrypted
    trackedWallets: TrackedWallet[];
    chatId: number;
}

export interface BotData {
    users: {
        [userId: string]: UserData;
    };
}

class Store {
    private data: BotData = { users: {} };

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
                    // Don't auto-migrate, let bot.ts handle it with proper user ID
                    this.data = { users: {} };
                } else {
                    this.data = parsed;
                }
            }
        } catch (err) {
            console.error('Error loading database:', err);
            this.data = { users: {} };
        }
    }

    private save() {
        try {
            fs.writeFileSync(DB_PATH, JSON.stringify(this.data, null, 2));
        } catch (err) {
            console.error('Error saving database:', err);
        }
    }

    // Get entire data (for checking migration)
    get(): BotData {
        return this.data;
    }

    // User Management
    getUser(userId: string): UserData | null {
        return this.data.users[userId] || null;
    }

    userExists(userId: string): boolean {
        return !!this.data.users[userId];
    }

    addUser(userId: string, chatId: number, privateKey: string) {
        const encryptedKey = encrypt(privateKey);
        this.data.users[userId] = {
            privateKey: encryptedKey,
            trackedWallets: [],
            chatId,
        };
        this.save();
    }

    changePrivateKey(userId: string, newPrivateKey: string) {
        if (!this.data.users[userId]) {
            throw new Error('User not found');
        }
        this.data.users[userId].privateKey = encrypt(newPrivateKey);
        this.save();
    }

    getDecryptedPrivateKey(userId: string): string | null {
        const user = this.data.users[userId];
        if (!user) return null;
        try {
            return decrypt(user.privateKey);
        } catch {
            return null;
        }
    }

    // Wallet Management
    addTrackedWallet(userId: string, address: string, name: string | null = null) {
        if (!this.data.users[userId]) {
            throw new Error('User not found');
        }

        const wallets = this.data.users[userId].trackedWallets;

        // Check if already tracking
        if (wallets.some(w => w.address.toLowerCase() === address.toLowerCase())) {
            throw new Error('Already tracking this wallet');
        }

        // Max 3 wallets
        if (wallets.length >= 3) {
            throw new Error('Maximum 3 wallets allowed');
        }

        wallets.push({ address, name });
        this.save();
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
        this.save();
    }

    getTrackedWallets(userId: string): TrackedWallet[] {
        return this.data.users[userId]?.trackedWallets || [];
    }

    deleteUser(userId: string) {
        delete this.data.users[userId];
        this.save();
    }

    getAllUsers(): Array<{ userId: string; data: UserData }> {
        return Object.entries(this.data.users).map(([userId, data]) => ({
            userId,
            data,
        }));
    }

    // Migration from old format
    migrateToMultiUser(userId: string, chatId: number, oldPrivateKey: string, oldWallets: string[]) {
        const encryptedKey = encrypt(oldPrivateKey);
        this.data.users[userId] = {
            privateKey: encryptedKey,
            trackedWallets: oldWallets.map(addr => ({ address: addr, name: null })),
            chatId,
        };
        this.save();
        console.log(`✅ Migrated data to user ${userId}`);
    }
}

export const store = new Store();
