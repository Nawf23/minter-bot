# Testing Your Vibe Bot (Safe Method)

Since you are running on **Ethereum Mainnet** with real funds, we want to test safely without spending much money.

## Prerequisites
1.  **Fund the Bot**: Send a tiny amount (e.g., 0.002 ETH) to your Bot's Wallet address (get it via `/start`).
2.  **Start the Bot**: Run `npm start` in your terminal.
3.  **Track Yourself**: In Telegram, send `/track 0xYourMainWalletAddress`.

## The "Hex Data" Test
The bot ignores simple money transfers. It only reacts to transactions with **Data** (contract interactions).
We can trick it by sending a 0 ETH transaction to ourselves with some random data.

### Step 1: Enable Hex Data in MetaMask
1.  Open MetaMask -> Click your Profile Icon -> **Settings**.
2.  Go to **Advanced**.
3.  Scroll down to **"Show Hex Data"** and toggle it **ON**.

### Step 2: Send the Trigger Transaction
1.  From your **Main Wallet** (the one you are tracking).
2.  Click **Send**.
3.  Paste **Your OWN Address** (send to yourself).
4.  Amount: **0 ETH**.
5.  **Hex Data** field: Type `0x123456`.
6.  Click **Next** and **Confirm**.

### Step 3: Watch the Magic
1.  The Bot should instantly message you: `🚨 Detected Transaction!`
2.  It will say "Target: `0xYourAddress`" (since you sent to yourself).
3.  It will attempt to "Copy" it (sending 0 ETH to you with data `0x123456`).
4.  If successful, it will reply with a Transaction Hash link.

---

## 2. The "Real" Test (Cheap Mint)
Find a free mint or a cheap open edition (e.g., on Zora or Mint.fun).
1.  Mint it with your Main Wallet.
2.  Bot should see it -> Copy it -> Mint one for itself!

> **Note**: If the mint is limited to "1 per wallet", the bot might fail if it already minted or if the contract has strict checks. But for open mints, it works perfectly.
