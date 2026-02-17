# Deployment Guide - Persistent Storage Setup

## Railway Volume Configuration

### Step 1: Add Volume (One-time setup)

1. Go to **Railway Dashboard** → your project
2. Click on **minter-bot** service
3. Click **Settings** tab
4. Scroll down to **Volumes** section
5. Click **+ New Volume**
6. Configure:
   - **Mount Path**: `/app/data`
   - **Size**: 1GB (default is fine)
7. Click **Add**

### Step 2: Set Environment Variable

1. Still in Railway, click **Variables** tab
2. Click **New Variable**
3. Add:
   - **Name**: `DATA_DIR`
   - **Value**: `/app/data`
4. Click **Add**

### Step 3: Deploy Code

```bash
git add .
git commit -m "add persistent storage with Railway Volumes"
git push
```

Railway will automatically redeploy with the new volume mounted.

---

## What This Does

✅ **Data persists** across deployments
✅ **Users don't lose** private keys or tracked wallets
✅ **Crash recovery** - bot automatically restarts on failure
✅ **Error handling** - graceful degradation if monitoring fails

---

## Testing

After deployment:

1. Send `/start` to bot
2. If you had data before, it should be preserved
3. If starting fresh, add a user with `/addprivatekey`
4. Track a wallet with `/track`
5. Push a small code change
6. After redeploy, verify data survived with `/mywallets`

---

## Cost

- **Railway Volume**: $5/month
- Worth it to prevent data loss!
