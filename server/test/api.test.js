import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { makeApp } from "../src/app.js";
import { openDb } from "../src/db.js";
import { makeSealer } from "../src/crypto.js";

const month = new Date().toISOString().slice(0, 7);
const d = (day) => `${month}-${String(day).padStart(2, "0")}`;
const pfc = (primary, detailed = primary + "_OTHER") => ({ primary, detailed });

// Stands in for Plaid so the tests run without keys. Mirrors the response shapes the server reads.
function fakePlaid() {
  const calls = [];
  const pages = [
    {
      added: [
        { transaction_id: "t1", account_id: "chk", date: d(1), name: "ACME PAYROLL", amount: -2500, personal_finance_category: pfc("INCOME", "INCOME_WAGES") },
        { transaction_id: "t2", account_id: "card", date: d(2), name: "Trader Joe's", merchant_name: "Trader Joe's", amount: 82.4, personal_finance_category: pfc("FOOD_AND_DRINK", "FOOD_AND_DRINK_GROCERIES") },
        { transaction_id: "t3", account_id: "chk", date: d(3), name: "Rent", amount: 1400, personal_finance_category: pfc("RENT_AND_UTILITIES", "RENT_AND_UTILITIES_RENT") },
      ],
      modified: [], removed: [], next_cursor: "c1", has_more: true,
    },
    {
      added: [
        { transaction_id: "t4", account_id: "chk", date: d(4), name: "Card payment", amount: 500, personal_finance_category: pfc("LOAN_PAYMENTS", "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT") },
        { transaction_id: "t5", account_id: "sav", date: d(4), name: "Transfer from checking", amount: -300, personal_finance_category: pfc("TRANSFER_IN", "TRANSFER_IN_ACCOUNT_TRANSFER") },
        { transaction_id: "t6", account_id: "chk", date: d(4), name: "Transfer to savings", amount: 300, personal_finance_category: pfc("TRANSFER_OUT", "TRANSFER_OUT_ACCOUNT_TRANSFER") },
      ],
      modified: [], removed: [], next_cursor: "c2", has_more: false,
    },
  ];
  return {
    calls,
    linkTokenCreate: async (req) => (calls.push(["link", req]), { data: { link_token: "link-sandbox-123" } }),
    itemPublicTokenExchange: async () => ({ data: { item_id: "item1", access_token: "access-sandbox-secret" } }),
    accountsGet: async (req) => (calls.push(["accounts", req.access_token]), { data: { accounts: [
      { account_id: "chk", name: "Checking", mask: "0000", type: "depository", subtype: "checking", balances: { current: 1200, available: 1150, iso_currency_code: "USD" } },
      { account_id: "sav", name: "Savings", mask: "1111", type: "depository", subtype: "savings", balances: { current: 5000, iso_currency_code: "USD" } },
      { account_id: "card", name: "Visa", mask: "3333", type: "credit", subtype: "credit card", balances: { current: 410, iso_currency_code: "USD" } },
    ] } }),
    transactionsSync: async (req) => (calls.push(["sync", req.cursor]), { data: pages[req.cursor === "c1" ? 1 : 0] }),
    itemRemove: async () => ({ data: {} }),
  };
}

async function start() {
  const db = await openDb();
  const plaid = fakePlaid();
  const app = makeApp({ db, plaid, sealer: makeSealer(randomBytes(32).toString("base64")), appToken: "test-token" });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, opts = {}) => fetch(base + path, { ...opts, headers: { authorization: "Bearer test-token", "content-type": "application/json", ...opts.headers } })
    .then(async (r) => ({ status: r.status, body: await r.json() }));
  return { db, plaid, server, call, base };
}

test("rejects requests without the app token", async (t) => {
  const { server, call } = await start(); t.after(() => server.close());
  const r = await call("/api/accounts", { headers: { authorization: "Bearer nope" } });
  assert.equal(r.status, 401);
});

test("links a bank, syncs every page, and summarizes the month", async (t) => {
  const { db, plaid, server, call } = await start(); t.after(() => server.close());

  assert.equal((await call("/api/link-token", { method: "POST" })).body.linkToken, "link-sandbox-123");

  const ex = await call("/api/exchange", { method: "POST", body: JSON.stringify({ publicToken: "public-sandbox", institution: "Chase" }) });
  assert.equal(ex.status, 200);
  assert.equal(ex.body.added, 6);
  assert.deepEqual(plaid.calls.filter((c) => c[0] === "sync").map((c) => c[1]), [undefined, "c1"]);

  // Access token is stored encrypted, not in plain text.
  const stored = await db.prepare("SELECT access_token, cursor FROM items").get();
  assert.ok(!stored.access_token.includes("access-sandbox-secret"));
  assert.equal(stored.cursor, "c2");
  assert.equal(plaid.calls.find((c) => c[0] === "accounts")[1], "access-sandbox-secret");

  const s = (await call(`/api/summary?month=${month}`)).body;
  assert.equal(s.income, 2500);
  assert.equal(s.spent, 1482.4);           // groceries + rent; card payment and transfers excluded
  assert.equal(s.saved, 1017.6);
  assert.equal(s.movedToSavings, 300);
  assert.equal(s.netWorth, 1200 + 5000 - 410);
  assert.equal(s.cardPayments, 500);       // shown on its own, not added to spending
  assert.equal(s.cardsOwed, 410);
  assert.equal(s.totalSavings, 5000);      // the savings account

  // Pick which accounts make up total savings.
  assert.equal((await call("/api/accounts/chk", { method: "PUT", body: JSON.stringify({ savings: true }) })).status, 200);
  assert.equal((await call(`/api/summary?month=${month}`)).body.totalSavings, 6200);
  assert.equal((await call("/api/accounts")).body.accounts.find((a) => a.id === "chk").savings, true);
  await call("/api/accounts/chk", { method: "PUT", body: JSON.stringify({ savings: null }) });
  assert.equal(s.trend.length, 6);
  assert.equal(s.categories[0].category, "RENT_AND_UTILITIES");

  await call("/api/budgets/FOOD_AND_DRINK", { method: "PUT", body: JSON.stringify({ monthlyLimit: 400 }) });
  const food = (await call(`/api/summary?month=${month}`)).body.categories.find((c) => c.category === "FOOD_AND_DRINK");
  assert.deepEqual([food.spent, food.limit], [82.4, 400]);

  const tx = (await call(`/api/transactions?month=${month}`)).body.transactions;
  assert.equal(tx.length, 6);
  assert.equal(tx.find((x) => x.id === "t2").account, "Visa");

  const accts = (await call("/api/accounts")).body;
  assert.equal(accts.banks[0].institution, "Chase");
  assert.equal(accts.accounts.length, 3);

  // Plaid refusing the removal (a test bank after switching to real banks) still unlinks it.
  plaid.itemRemove = async () => { throw Object.assign(new Error("400"), { response: { data: { error_code: "INVALID_ACCESS_TOKEN" } } }); };
  assert.equal((await call("/api/banks/item1", { method: "DELETE" })).status, 200);
  assert.equal((await call("/api/accounts")).body.accounts.length, 0);
  assert.equal((await call(`/api/transactions?month=${month}`)).body.transactions.length, 0);
});

test("rejects a malformed month", async (t) => {
  const { server, call } = await start(); t.after(() => server.close());
  assert.equal((await call("/api/summary?month=oct")).status, 400);
});

test("serves the web app without the password, but not its data", async (t) => {
  const { server, call } = await start(); t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(base + "/");
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>Money Book<\/title>/);
  assert.equal((await fetch(base + "/manifest.webmanifest")).status, 200);
  assert.equal((await fetch(base + "/api/summary")).status, 401);
});

test("accepts any long encryption key, not only 32-byte base64", () => {
  const sealer = makeSealer("a-generated-value-that-is-not-base64!");
  assert.equal(sealer.open(sealer.seal("access-sandbox-secret")), "access-sandbox-secret");
  assert.throws(() => makeSealer("short"));
});

test("the Vercel entry point builds the app from environment variables", async (t) => {
  const { default: handler } = await import("../api/index.js");
  Object.assign(process.env, { PLAID_CLIENT_ID: "id", PLAID_SECRET: "secret", ENCRYPTION_KEY: "a-long-enough-secret-value", APP_TOKEN: "pw", DATABASE_URL: ":memory:", PLAID_ENV: " Development " });
  const { createServer } = await import("node:http");
  const server = createServer(handler).listen(0);
  t.after(() => server.close());
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await (await fetch(base + "/health")).json();
  assert.equal(health.ok, true);
  assert.equal(health.settings.PLAID_SECRET, "set");
  assert.equal(health.settings.plaidMode, "sandbox");
  assert.ok(!JSON.stringify(health).includes("secret"));
  const s = await fetch(base + `/api/summary?month=${month}`, { headers: { authorization: "Bearer pw" } });
  assert.equal(s.status, 200);
  assert.equal((await s.json()).spent, 0);
});

test("reads PLAID_ENV forgivingly", async () => {
  const { resolvePlaidEnv } = await import("../src/setup.js");
  for (const v of [undefined, "", "Sandbox", "sandbox ", "development", "sandbx"]) assert.equal(resolvePlaidEnv(v), "sandbox");
  for (const v of ["production", "Production", " PROD "]) assert.equal(resolvePlaidEnv(v), "production");
});

test("/api/ping answers without the app password and shows the path it received", async () => {
  const { server, base } = await start();
  try {
    const r = await fetch(base + "/api/ping?x=1");
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, path: "/api/ping" });
  } finally { server.close(); }
});

test("card payments, refunds and loan accounts don't inflate income or spending", async () => {
  const { classifyAll } = await import("../src/summary.js");
  const chk = { account_type: "depository", account_subtype: "checking", item_id: "a", counted: null };
  const card = { account_type: "credit", account_subtype: "credit card", item_id: "b", counted: null };
  const rows = [
    // Card payment Plaid mislabeled on both sides: paired by amount and date.
    { id: "p1", account_id: "chk", date: "2026-10-03", name: "CAPITAL ONE ONLINE PMT", amount: 812.5, category: "GENERAL_SERVICES", ...chk },
    { id: "p2", account_id: "card", date: "2026-10-05", name: "PAYMENT RECEIVED", amount: -812.5, category: "INCOME", ...card },
    // Payment to a card that isn't linked: recognized by its name.
    { id: "p3", account_id: "chk", date: "2026-10-07", name: "DISCOVER E-PAYMENT", amount: 200, category: "LOAN_PAYMENTS", detailed: "LOAN_PAYMENTS_OTHER_PAYMENT", ...chk },
    { id: "r1", account_id: "card", date: "2026-10-08", name: "Target refund", amount: -40, category: "GENERAL_MERCHANDISE", ...card },
    { id: "s1", account_id: "card", date: "2026-10-08", name: "Target", amount: 90, category: "GENERAL_MERCHANDISE", ...card },
    { id: "w1", account_id: "chk", date: "2026-10-01", name: "PAYROLL", amount: -2000, category: "INCOME", ...chk },
    { id: "l1", account_id: "loan", date: "2026-10-09", name: "Payment received", amount: -300, category: "LOAN_PAYMENTS", account_type: "loan", item_id: "c", counted: null },
    { id: "x1", account_id: "chk", date: "2026-10-09", name: "Venmo", amount: 25, category: "GENERAL_SERVICES", ...chk, counted: 0 },
    { id: "t1", account_id: "fake", date: "2026-10-09", name: "Gusto pay", amount: -5850, category: "INCOME", account_type: "depository", item_id: "test", counted: null },
  ];
  const k = classifyAll(rows, { testItems: new Set(["test"]) });
  assert.deepEqual(Object.fromEntries(k), {
    p1: "card_payment", p2: "card_payment", p3: "card_payment", r1: "refund", s1: "spending",
    w1: "income", l1: "other_account", x1: "ignored", t1: "test",
  });
});

test("a transaction can be marked not counted, then back to automatic", async (t) => {
  const { server, call } = await start(); t.after(() => server.close());
  await call("/api/exchange", { method: "POST", body: JSON.stringify({ publicToken: "public-sandbox", institution: "Chase" }) });
  assert.equal((await call(`/api/summary?month=${month}`)).body.spent, 1482.4);
  assert.equal((await call("/api/transactions/t3", { method: "PUT", body: JSON.stringify({ counted: false }) })).status, 200);
  assert.equal((await call(`/api/summary?month=${month}`)).body.spent, 82.4);
  const rent = (await call(`/api/transactions?month=${month}`)).body.transactions.find((x) => x.id === "t3");
  assert.deepEqual([rent.counted, rent.kind, rent.override], [false, "ignored", 0]);
  await call("/api/transactions/t3", { method: "PUT", body: JSON.stringify({ counted: null }) });
  assert.equal((await call(`/api/summary?month=${month}`)).body.spent, 1482.4);
  assert.equal((await call("/api/transactions/t3", { method: "PUT", body: JSON.stringify({ counted: "no" }) })).status, 400);
});

test("a transfer to another of your accounts isn't spending; what you buy from that account is", async () => {
  const { classifyAll } = await import("../src/summary.js");
  const acct = (id, sub = "checking") => ({ account_id: id, account_type: "depository", account_subtype: sub, item_id: id, counted: null });
  const rows = [
    // Zelle to your own account at another bank, labeled as a payment by both banks.
    { id: "o1", date: "2026-10-02", name: "ZELLE TO BROOKE", amount: 400, category: "GENERAL_SERVICES", ...acct("a") },
    { id: "i1", date: "2026-10-03", name: "ZELLE FROM BROOKE", amount: -400, category: "GENERAL_SERVICES", ...acct("b") },
    { id: "b1", date: "2026-10-06", name: "Kroger", amount: 120, category: "FOOD_AND_DRINK", ...acct("b") },
    // Paycheck the same size as an unrelated bill stays income.
    { id: "pay", date: "2026-10-01", name: "PAYROLL", amount: -900, category: "INCOME", ...acct("a") },
    { id: "bill", date: "2026-10-02", name: "Rent", amount: 900, category: "RENT_AND_UTILITIES", ...acct("b") },
  ];
  assert.deepEqual(Object.fromEntries(classifyAll(rows)), { o1: "transfer", i1: "transfer", b1: "spending", pay: "income", bill: "spending" });
});

test("money from other people is income; Acorns is money out; Fidelity counts toward nothing", async () => {
  const { classifyAll } = await import("../src/summary.js");
  const acct = (id) => ({ account_id: id, account_type: "depository", account_subtype: "checking", item_id: id, counted: null });
  const rows = [
    { id: "z", date: "2026-10-02", name: "ZELLE FROM JORDAN", amount: -60, category: "TRANSFER_IN", detailed: "TRANSFER_IN_ACCOUNT_TRANSFER", ...acct("a") },
    { id: "v", date: "2026-10-03", name: "VENMO CASHOUT", amount: -25, category: "GENERAL_SERVICES", ...acct("a") },
    { id: "ac", date: "2026-10-04", name: "Acorns Invest", amount: 5, category: "TRANSFER_OUT", detailed: "TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS", ...acct("a") },
    { id: "fi", date: "2026-10-05", name: "FID BKG SVC LLC MONEYLINE", merchant: "Fidelity", amount: 200, category: "TRANSFER_OUT", ...acct("a") },
    // Your own money between linked accounts still isn't income.
    { id: "o", date: "2026-10-06", name: "Online transfer to savings", amount: 100, category: "TRANSFER_OUT", ...acct("a") },
    { id: "i", date: "2026-10-06", name: "Online transfer from checking", amount: -100, category: "TRANSFER_IN", detailed: "TRANSFER_IN_ACCOUNT_TRANSFER", ...acct("b") },
  ];
  assert.deepEqual(Object.fromEntries(classifyAll(rows)), { z: "received", v: "received", ac: "investing", fi: "fidelity", o: "transfer", i: "transfer" });
});

test("anything at Axos counts toward total savings automatically", async () => {
  const { isSavingsAccount } = await import("../src/summary.js");
  assert.equal(isSavingsAccount({ type: "depository", subtype: "checking", institution: "Axos Bank", is_savings: null }), true);
  assert.equal(isSavingsAccount({ type: "depository", subtype: "checking", institution: "Chase", is_savings: null }), false);
  assert.equal(isSavingsAccount({ type: "depository", subtype: "checking", institution: "Axos Bank", is_savings: 0 }), false);
});
