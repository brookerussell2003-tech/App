# Money Book

A personal budget app: every bank account and card in one place, with what you spend and save each month.
It's a web app you add to your iPhone home screen, so it opens full screen like a regular app. Plaid connects
your banks.

Everything lives in **`server/`**: a small Node server that holds your Plaid keys, links banks through Plaid,
stores your transactions in a SQLite-compatible database (a local file, or a free Turso database online), and
serves the web app (`server/public/`). Screens: Month (money in, spent, saved, net
worth, category limits, 6-month chart), Accounts (link, sync, unlink banks and cards), and Activity.

Your bank username and password are only ever typed into Plaid's own sign-in screen. The server keeps Plaid's
access tokens encrypted (AES-256-GCM) and only shares your data with someone who has the app password
(`APP_TOKEN`).

## 1. Get Plaid keys

1. Sign up at <https://dashboard.plaid.com/signup>. For "Website", this repo's GitHub link works.
2. Copy your `client_id` and **Sandbox** secret from <https://dashboard.plaid.com/developers/keys>.
3. Sandbox uses Plaid's test banks (username `user_good`, password `pass_good`). To link your real banks,
   request Production access in the Plaid dashboard, then set `PLAID_ENV=production` and use the production secret.

## 2. Put it online for free

Your iPhone needs to reach the app over the internet. Two free services cover it, and both let you sign up with
GitHub. (Free plans can change; neither asks for a card today.)

**Turso: stores your data**
1. Sign up at <https://turso.tech> and create a database (any name, such as `money-book`).
2. Copy its **URL** (starts with `libsql://`) and create a **token** for it. You'll paste both into Vercel.

**Vercel: runs the app**
1. Sign up at <https://vercel.com> and choose **Add New → Project**, then import this repo.
2. Set **Root Directory** to `server`.
3. Under **Environment Variables**, add:
   - `PLAID_CLIENT_ID`, `PLAID_SECRET` and `PLAID_ENV` (`sandbox` for now)
   - `APP_TOKEN`: a password you make up
   - `ENCRYPTION_KEY`: any long random text, 30 characters or more. Don't change it after linking banks.
   - `DATABASE_URL` and `DATABASE_AUTH_TOKEN`: from Turso
4. Tap **Deploy**. Vercel gives you an address like `money-book.vercel.app`.

## 3. Add it to your iPhone

1. Open your server's address (for example `https://money-book.vercel.app`) in **Safari**.
2. Tap **Share → Add to Home Screen**.
3. Open Money Book from the home screen, enter your app password, then go to **Accounts → Link a bank or card**.

## Run it on a computer

Needs Node 20 or newer. Data goes in a local `money-book.db` file.

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
