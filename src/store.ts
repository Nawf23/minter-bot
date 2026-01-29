import fs from 'fs';
import path from 'path';

const DB_PATH = path.resolve(__dirname, '../db.json');

export interface BotData {
    trackedWallets: string[];
    botWalletAddress: string | null; // Derived from private key, just for display
    isActive: boolean;
    chatId: number | null;
}

const defaultData: BotData = {
    trackedWallets: [],
    botWalletAddress: null,
    isActive: true,
    chatId: null
};

export class Store {
    private data: BotData;

    constructor() {
        this.data = this.load();
        // Migration check: if old format exists (trackedWallet string), migrate to array
        const anyData = this.data as any;
        if (anyData.trackedWallet && !this.data.trackedWallets) {
            this.data.trackedWallets = [anyData.trackedWallet];
            delete anyData.trackedWallet;
            this.save(this.data);
        }
        // Ensure array exists
        if (!this.data.trackedWallets) {
            this.data.trackedWallets = [];
        }
    }

    private load(): BotData {
        if (!fs.existsSync(DB_PATH)) {
            this.save(defaultData);
            return defaultData;
        }
        try {
            const raw = fs.readFileSync(DB_PATH, 'utf-8');
            return JSON.parse(raw);
        } catch (error) {
            console.error("Error reading db.json, resetting to default:", error);
            return defaultData;
        }
    }

    private save(data: BotData) {
        fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
    }

    get(): BotData {
        return this.data;
    }

    getTrackedWallets(): string[] {
        return this.data.trackedWallets || [];
    }

    addTrackedWallet(address: string) {
        if (!this.data.trackedWallets) this.data.trackedWallets = [];
        // Prevent duplicates
        if (!this.data.trackedWallets.find(w => w.toLowerCase() === address.toLowerCase())) {
            this.data.trackedWallets.push(address);
            this.save(this.data);
        }
    }

    removeTrackedWallet(address: string) {
        if (!this.data.trackedWallets) return;
        this.data.trackedWallets = this.data.trackedWallets.filter(a => a.toLowerCase() !== address.toLowerCase());
        this.save(this.data);
    }

    setChatId(id: number) {
        this.data.chatId = id;
        this.save(this.data);
    }

    setBotWalletAddress(address: string) {
        this.data.botWalletAddress = address;
        this.save(this.data);
    }
}

export const store = new Store();
