// Works with a local file (file:money-book.db) or a free hosted Turso database (libsql://...).
// A hosted database uses the pure-JavaScript client: the default one loads a native SQLite
// binary that Vercel's functions don't include, which crashes the whole server.
export async function openDb(url = ":memory:", authToken) {
  const remote = /^(libsql|https?|wss?):/.test(url);
  const { createClient } = remote ? await import("@libsql/client/web") : await import("@libsql/client");
  const client = createClient({ url, authToken });
  await client.executeMultiple(`
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
  const plain = (row) => (row ? { ...row } : undefined);
  return {
    prepare: (sql) => ({
      get: async (...args) => plain((await client.execute({ sql, args })).rows[0]),
      all: async (...args) => (await client.execute({ sql, args })).rows.map(plain),
      run: async (...args) => client.execute({ sql, args }),
    }),
    close: () => client.close(),
  };
}
