import { makeApp } from "./app.js";
import { openDb } from "./db.js";
import { makeSealer } from "./crypto.js";
import { makePlaidClient } from "./plaid.js";

const need = (name) => {
  const v = process.env[name];
  if (!v) { console.error(`Missing ${name}. See server/.env.example.`); process.exit(1); }
  return v;
};

const app = makeApp({
  db: openDb(process.env.DB_PATH ?? "money-book.db"),
  plaid: makePlaidClient({ clientId: need("PLAID_CLIENT_ID"), secret: need("PLAID_SECRET"), env: process.env.PLAID_ENV ?? "sandbox" }),
  sealer: makeSealer(need("ENCRYPTION_KEY")),
  appToken: need("APP_TOKEN"),
});

const port = Number(process.env.PORT ?? 8787);
app.listen(port, () => console.log(`Money Book server on http://localhost:${port} (Plaid ${process.env.PLAID_ENV ?? "sandbox"})`));
