# Setup Guide: Getting Your Keys

To run your NFT Vibe Bot, you need 3 secret keys. Follow this guide to get them.

## 1. Telegram Bot Token
This allows the code to control your bot.
1. Open Telegram.
2. Search for **@BotFather**.
3. Type `/newbot` and send.
4. Follow the prompts (give it a name and a username like `MyCoolMintBot`).
5. BotFather will give you a token that looks like: `123456789:ABCdefGhIJKlmNoPQRstUVwxYz`.
6. **Save this Token.**

## 2. Ethereum RPC URL
This allows your bot to "talk" to the blockchain.
1. Go to [Alchemy.com](https://www.alchemy.com/) and Sign Up (it's free).
2. on the Dashboard, click **"+ Create new app"**.
3. Name: `Mint Bot`, Chain: `Ethereum`, Network: `Mainnet` (or `Sepolia` for testing).
4. Click **"View Key"** on your new app.
5. Copy the **HTTPS** URL (e.g., `https://eth-mainnet.g.alchemy.com/v2/your-api-key`).
6. **Save this URL.**

## 3. Burner Wallet Private Key
**⚠️ CRITICAL SAFETY WARNING:**
**NEVER USE YOUR MAIN WALLET.**
Create a simplified "Burner Wallet" with only the funds you intend to mint with.

1. Open your wallet extension (e.g., MetaMask, Rabby).
2. Click the specific account icon -> **"Add account"** or **"Create new account"**. Name it "Mint Bot Burner".
3. Go to **Account Details** (often 3 dots menu -> Account Details).
4. Click **"Show Private Key"**. (You may need to enter your password).
5. Copy the Private Key (starts with `0x` or just a long string of hex characters).
6. **Save this Key.**

---

## How to add them to the project
I will create a `.env` file for you. You will paste these values there.
