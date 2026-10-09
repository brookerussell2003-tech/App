import { DatabaseSync } from "node:sqlite";

export function openDb(path = ":memory:") {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      access_token TEXT NOT NULL,          -- encrypted, see crypto.js
      institution TEXT,
      cursor TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      synced_at TEXT
    );
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      mask TEXT,
      type TEXT,                           -- depository | credit | loan | investment
      subtype TEXT,                        -- checking | savings | credit card | ...
      current REAL,
      available REAL,
      currency TEXT
    );
    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      date TEXT NOT NULL,                  -- YYYY-MM-DD
      name TEXT NOT NULL,
      merchant TEXT,
      amount REAL NOT NULL,                -- Plaid convention: positive = money out
      category TEXT,                       -- personal_finance_category.primary
      detailed TEXT,                       -- personal_finance_category.detailed
      pending INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS tx_date ON transactions(date);
    CREATE TABLE IF NOT EXISTS budgets (
      category TEXT PRIMARY KEY,
      monthly_limit REAL NOT NULL
    );
  `);
  return db;
}
