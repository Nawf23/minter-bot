# Deploying Your Vibe Bot on Railway 🚂

Railway is the easiest way to keep this bot running 24/7.

## 1. Setup Railway Account
1.  Go to [Railway.app](https://railway.app/).
2.  Login with GitHub.

## 2. Create Project
1.  Click **"New Project"**.
2.  Select **"Empty Project"**.
3.  Click **"Create"**.

## 3. Add Service
Since your code is on your computer (not GitHub yet), we will use the **Railway CLI** to upload it.
*Alternatively, you can put this code on GitHub and connect it, which is easier if you know git.*

**Optimized Path: Connect to GitHub (Recommended)**
1.  Create a repo on GitHub called `vibe-bot`.
2.  Push this code to it:
    ```bash
    git init
    git add .
    git commit -m "initial commit"
    git branch -M main
    git remote add origin https://github.com/YOUR_USERNAME/vibe-bot.git
    git push -u origin main
    ```
3.  In Railway, choose **"Deploy from GitHub repo"**.
4.  Select your `vibe-bot` repo.

## 4. Configure Variables (IMPORTANT)
1.  Click on your new Service in Railway.
2.  Click the **"Variables"** tab.
3.  Add your secrets here (COPY form your local `.env` file):
    - `TELEGRAM_BOT_TOKEN`: `...`
    - `RPC_URL`: `...`
    - `RPC_URL_BASE`: `...`
    - `PRIVATE_KEY`: `...`

## 5. Start Command
Railway detects `npm start` automatically from `package.json`.
It should just work!

## 6. Verify
1.  Wait for the deployment to finish (Green checkmark).
2.  Open Telegram.
3.  Send `/start` to make sure it's alive.

> **Note on Cost:** Railway gives you \$5 trial credit. Use it! If it runs out, the "Hobby" plan is very cheap ($5/month).
