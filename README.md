# Money Book

A personal budget app: every bank account and card in one place, with what you spend and save each month.
It's a web app you add to your iPhone home screen, so it opens full screen like a regular app. Plaid connects
your banks.

Everything lives in **`server/`**: a small Node server that holds your Plaid keys, links banks through Plaid,
stores your transactions, and serves the web app (`server/public/`). Screens: Month (money in, spent, saved, net
worth, category limits, 6-month chart), Accounts (link, sync, unlink banks and cards), and Activity.

Your bank username and password are only ever typed into Plaid's own sign-in screen. The server keeps Plaid's
access tokens encrypted (AES-256-GCM) and only shares your data with someone who has the app password
(`APP_TOKEN`).

## 1. Get Plaid keys

1. Sign up at <https://dashboard.plaid.com/signup>. For "Website", this repo's GitHub link works.
2. Copy your `client_id` and **Sandbox** secret from <https://dashboard.plaid.com/developers/keys>.
3. Sandbox uses Plaid's test banks (username `user_good`, password `pass_good`). To link your real banks,
   request Production access in the Plaid dashboard, then set `PLAID_ENV=production` and use the production secret.

## 2. Put it online

Your iPhone needs to reach the server over HTTPS, so it has to run on a host.

**Render (easiest):** in Render choose **New → Blueprint**, pick this repo, and fill in `PLAID_CLIENT_ID`,
`PLAID_SECRET`, `ENCRYPTION_KEY` and `APP_TOKEN` when asked. `render.yaml` sets up the rest, including a disk so
your data survives restarts. Generate `ENCRYPTION_KEY` and `APP_TOKEN` with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Keep `ENCRYPTION_KEY` safe: without it the stored bank connections can't be read and you'd re-link your banks.

Any other Node host with a persistent disk works too (Railway, Fly.io); set the same environment variables.

## 3. Add it to your iPhone

1. Open your server's address (for example `https://money-book.onrender.com`) in **Safari**.
2. Tap **Share → Add to Home Screen**.
3. Open Money Book from the home screen, enter your app password, then go to **Accounts → Link a bank or card**.

## Run it on a computer

Needs Node 22.13 or newer.

```bash
cd server
npm install
cp .env.example .env    # then fill it in
npm run dev             # open http://localhost:8787
npm test                # runs against a fake Plaid, no keys needed
```

## How the numbers work

- **Spent**: money out of any account, by Plaid category. Credit card payments and transfers between your own
  accounts are left out so nothing is counted twice.
- **Money in**: deposits and income, excluding your own transfers.
- **Saved**: money in minus spent.
- **Net worth**: account balances, with card and loan balances counted as owed.
