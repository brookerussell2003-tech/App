import { makeApp } from "./app.js";
import { openDb } from "./db.js";
import { makeSealer } from "./crypto.js";
import { makePlaidClient } from "./plaid.js";

// Builds the app from environment variables. Used by `npm start` and by Vercel (api/index.js).
export async function buildApp(rawEnv = process.env) {
  // Values pasted into a host's settings page often pick up spaces, quotes or capitals ("Sandbox").
  const env = Object.fromEntries(Object.entries(rawEnv).map(([k, v]) => [k, typeof v === "string" ? v.trim().replace(/^["']|["']$/g, "") : v]));
  if (env.PLAID_ENV) env.PLAID_ENV = env.PLAID_ENV.toLowerCase();
  const missing = ["PLAID_CLIENT_ID", "PLAID_SECRET", "ENCRYPTION_KEY", "APP_TOKEN"].filter((k) => !env[k]);
  if (missing.length) throw new Error(`Missing ${missing.join(", ")}. Add it in Vercel under Settings → Environment Variables (or in server/.env on a computer), then redeploy.`);
  // Vercel's disk is wiped between requests, so a hosted database is required there.
  if (env.VERCEL && !env.DATABASE_URL) throw new Error("Missing DATABASE_URL. Add your Turso database URL and token in Vercel's settings.");
  return makeApp({
    db: await openDb(env.DATABASE_URL ?? "file:money-book.db", env.DATABASE_AUTH_TOKEN),
    plaid: makePlaidClient({ clientId: env.PLAID_CLIENT_ID, secret: env.PLAID_SECRET, env: env.PLAID_ENV ?? "sandbox" }),
    sealer: makeSealer(env.ENCRYPTION_KEY),
    appToken: env.APP_TOKEN,
  });
}
