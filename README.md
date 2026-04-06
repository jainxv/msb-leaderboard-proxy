# MySmartBazaar — Leaderboard Proxy

Vercel serverless proxy for the monthly customer leaderboard. Uses Shopify's new OAuth Client Credentials flow (Dev Dashboard apps).

## Deploy to Vercel (Step by Step)

### 1. Create a GitHub Account
- Go to https://github.com → Sign up
- Create a **New Repository** named `msb-leaderboard-proxy`
- Upload all files from this project

### 2. Deploy on Vercel
- Go to https://vercel.com → Sign up with GitHub
- Click **Add New → Project**
- Import your `msb-leaderboard-proxy` repo
- Add these **Environment Variables**:

| Variable | Value |
|---|---|
| `SHOPIFY_STORE_DOMAIN` | `mysmartbazaar.myshopify.com` |
| `SHOPIFY_CLIENT_ID` | Your Client ID from Dev Dashboard |
| `SHOPIFY_CLIENT_SECRET` | Your Client Secret from Dev Dashboard |
| `ALLOWED_ORIGIN` | `https://mysmartbazaar.com` |

- Click **Deploy**

### 3. Update Shopify Leaderboard Page
In your `page.leaderboard.liquid`, change:
```
proxyUrl: "{{ shop.url }}/apps/leaderboard-proxy",
```
to:
```
proxyUrl: "https://YOUR-VERCEL-URL.vercel.app/api/leaderboard-proxy",
```

### 4. Test
Visit `https://YOUR-VERCEL-URL.vercel.app/api/leaderboard-proxy` — you should see JSON with order data.

## Security
- **Rotate your Client Secret** after sharing it anywhere
- Credentials are stored as Vercel env vars (never in code)
- Access tokens auto-refresh every 24 hours
- CORS restricts access to your store domain only
