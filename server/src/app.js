import express from "express";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { CountryCode, Products } from "plaid";
import { syncAll, syncItem } from "./sync.js";
import { monthSummary, netWorth, shiftMonth, classifiedMonth, CATEGORY_LABELS, KIND_LABELS, COUNTED_KINDS } from "./summary.js";

const MONTH = /^\d{4}-\d{2}$/;

export function makeApp({ db, plaid, sealer, appToken, plaidEnv = "sandbox" }) {
  const app = express();
  app.use(express.json({ limit: "100kb" }));

  app.get("/health", (_req, res) => res.json({ ok: true }));

  // The web app (add it to your iPhone home screen). Its data calls below need the app password.
  app.use(express.static(fileURLToPath(new URL("../public", import.meta.url))));

  // Public, harmless check that requests reach the API with their path intact (no data, no password needed).
  app.get("/api/ping", (req, res) => res.json({ ok: true, path: req.originalUrl.split("?")[0] }));

  // Single-user app: the web app sends APP_TOKEN (the app password) as a bearer token on every request.
  const expected = Buffer.from(appToken);
  app.use("/api", (req, res, next) => {
    const got = Buffer.from((req.get("authorization") ?? "").replace(/^Bearer /, ""));
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) return res.status(401).json({ error: "Wrong or missing app token" });
    next();
  });

  const wrap = (fn) => (req, res) =>
    Promise.resolve(fn(req, res)).catch((err) => {
      const plaidError = err.response?.data;
      console.error(plaidError ?? err);
      res.status(plaidError ? 502 : 500).json({ error: plaidError?.error_message ?? "Something went wrong on the server" });
    });

  // Test banks linked before switching to real banks keep their fake data; leave them out of the numbers.
  const testItems = async () => {
    if (plaidEnv !== "production") return new Set();
    const items = await db.prepare("SELECT id, access_token FROM items").all();
    return new Set(items.filter((i) => { try { return sealer.open(i.access_token).startsWith("access-sandbox"); } catch { return false; } }).map((i) => i.id));
  };

  app.post("/api/link-token", wrap(async (_req, res) => {
    const { data } = await plaid.linkTokenCreate({
      user: { client_user_id: "owner" },
      client_name: "Money Book",
      products: [Products.Transactions],
      transactions: { days_requested: 730 },
      country_codes: [CountryCode.Us],
      language: "en",
    });
    res.json({ linkToken: data.link_token });
  }));

  app.post("/api/exchange", wrap(async (req, res) => {
    const { publicToken, institution } = req.body ?? {};
    if (typeof publicToken !== "string") return res.status(400).json({ error: "publicToken is required" });
    const { data } = await plaid.itemPublicTokenExchange({ public_token: publicToken });
    await db.prepare("INSERT INTO items (id, access_token, institution) VALUES (?, ?, ?)")
      .run(data.item_id, sealer.seal(data.access_token), typeof institution === "string" ? institution.slice(0, 100) : null);
    const item = await db.prepare("SELECT * FROM items WHERE id = ?").get(data.item_id);
    res.json({ itemId: data.item_id, ...(await syncItem({ db, plaid, sealer }, item)) });
  }));

  app.post("/api/sync", wrap(async (_req, res) => res.json({ results: await syncAll({ db, plaid, sealer }) })));

  app.get("/api/accounts", wrap(async (_req, res) => {
    const test = await testItems();
    const banks = (await db.prepare("SELECT id, institution, synced_at FROM items ORDER BY created_at").all()).map((b) => ({ ...b, test: test.has(b.id) }));
    const accounts = await db.prepare("SELECT id, item_id, name, mask, type, subtype, current, available, currency FROM accounts ORDER BY type, name").all();
    res.json({ banks, accounts, netWorth: await netWorth(db, { testItems: test }) });
  }));

  app.delete("/api/banks/:id", wrap(async (req, res) => {
    const item = await db.prepare("SELECT * FROM items WHERE id = ?").get(req.params.id);
    if (!item) return res.status(404).json({ error: "No bank with that id" });
    // A link Plaid no longer recognizes (e.g. a test bank after switching to real banks) is still removed here.
    try { await plaid.itemRemove({ access_token: sealer.open(item.access_token) }); }
    catch (err) { console.error("Plaid itemRemove failed, removing locally anyway:", err.response?.data ?? err.message); }
    // Deleted explicitly: hosted databases don't always honor ON DELETE CASCADE across requests.
    await db.prepare("DELETE FROM transactions WHERE account_id IN (SELECT id FROM accounts WHERE item_id = ?)").run(item.id);
    await db.prepare("DELETE FROM accounts WHERE item_id = ?").run(item.id);
    await db.prepare("DELETE FROM items WHERE id = ?").run(item.id);
    res.json({ removed: item.id });
  }));

  app.get("/api/summary", wrap(async (req, res) => {
    const month = String(req.query.month ?? new Date().toISOString().slice(0, 7));
    if (!MONTH.test(month)) return res.status(400).json({ error: "month must look like 2026-10" });
    const opts = { testItems: await testItems() };
    const trend = await Promise.all([-5, -4, -3, -2, -1, 0].map(async (n) => {
      const s = await monthSummary(db, shiftMonth(month, n), opts);
      return { month: s.month, spent: s.spent, saved: s.saved };
    }));
    res.json({ ...(await monthSummary(db, month, opts)), trend, netWorth: await netWorth(db, opts) });
  }));

  app.get("/api/transactions", wrap(async (req, res) => {
    const month = String(req.query.month ?? new Date().toISOString().slice(0, 7));
    if (!MONTH.test(month)) return res.status(400).json({ error: "month must look like 2026-10" });
    const rows = await classifiedMonth(db, month, { testItems: await testItems() });
    res.json({ transactions: rows.map((r) => ({
      id: r.id, date: r.date, name: r.name, merchant: r.merchant, amount: r.amount, category: r.category, account: r.account,
      pending: !!r.pending, label: CATEGORY_LABELS[r.category] ?? r.category ?? "Other",
      kind: r.kind, counted: COUNTED_KINDS.has(r.kind), why: KIND_LABELS[r.kind], override: r.counted ?? null,
    })) });
  }));

  // Tap a transaction to stop or start counting it. counted: true, false, or null to go back to automatic.
  app.put("/api/transactions/:id", wrap(async (req, res) => {
    const c = req.body?.counted;
    if (![true, false, null].includes(c)) return res.status(400).json({ error: "counted must be true, false or null" });
    const r = await db.prepare("UPDATE transactions SET counted = ? WHERE id = ?").run(c === null ? null : c ? 1 : 0, req.params.id);
    if (!r.rowsAffected) return res.status(404).json({ error: "No transaction with that id" });
    res.json({ id: req.params.id, counted: c });
  }));

  app.get("/api/budgets", wrap(async (_req, res) => {
    res.json({ budgets: await db.prepare("SELECT category, monthly_limit AS monthlyLimit FROM budgets").all(), labels: CATEGORY_LABELS });
  }));

  app.put("/api/budgets/:category", wrap(async (req, res) => {
    const { category } = req.params;
    if (!(category in CATEGORY_LABELS)) return res.status(400).json({ error: "Unknown category" });
    const limit = Number(req.body?.monthlyLimit);
    if (!limit || limit <= 0) await db.prepare("DELETE FROM budgets WHERE category = ?").run(category);
    else await db.prepare("INSERT INTO budgets (category, monthly_limit) VALUES (?, ?) ON CONFLICT(category) DO UPDATE SET monthly_limit = excluded.monthly_limit").run(category, limit);
    res.json({ category, monthlyLimit: limit > 0 ? limit : null });
  }));

  return app;
}
