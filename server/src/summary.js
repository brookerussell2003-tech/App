// How each transaction counts toward the month. Plaid amounts are positive for money out.
//
// - Money moving between your own accounts is neither spending nor income: transfers between them,
//   and paying off a credit card (the card purchases were already counted as spending).
//   Plaid's labels for these vary by bank, so a payment is also recognized by its matching
//   opposite amount in another of your accounts within a few days, and any money coming
//   into a credit card is never income.
// - Income is money in that Plaid labels as income (pay, interest, benefits), plus money other
//   people send you (Zelle, Venmo, a transfer in that doesn't come from one of your linked accounts).
// - Money taken out to Acorns counts as money out, under "Investing".
// - Fidelity (a set monthly contribution) counts toward nothing.
// - Other money in (a refund) lowers spending instead of counting as income.
// - Loan and investment accounts are left out (their balances still count toward net worth).
// - A transaction you mark "count" or "don't count" in the app overrides all of this.
const TRANSFER_CATEGORIES = new Set(["TRANSFER_IN", "TRANSFER_OUT"]);
const CARD_PAYMENT = /payment|autopay|auto pay|thank you|epay|pymt|online pmt|card ?services|credit ?card/i;
const ACORNS = /acorns/i;
const FIDELITY = /fidelity|fid bkg/i;
const PEOPLE = /zelle|venmo|cash ?app|square cash|paypal|apple cash/i;
// Transfers in that are your own money coming back, not someone paying you.
const OWN_MONEY_IN = new Set(["TRANSFER_IN_SAVINGS", "TRANSFER_IN_INVESTMENT_AND_RETIREMENT_FUNDS", "TRANSFER_IN_CASH_ADVANCES_AND_LOANS"]);
const MATCH_DAYS = 5;

export const CATEGORY_LABELS = {
  INCOME: "Income", TRANSFER_IN: "Transfer in", TRANSFER_OUT: "Transfer out", LOAN_PAYMENTS: "Loan & card payments",
  BANK_FEES: "Bank fees", ENTERTAINMENT: "Fun", FOOD_AND_DRINK: "Food & drink", GENERAL_MERCHANDISE: "Shopping",
  HOME_IMPROVEMENT: "Home", MEDICAL: "Health", PERSONAL_CARE: "Personal care", GENERAL_SERVICES: "Services",
  GOVERNMENT_AND_NON_PROFIT: "Taxes & giving", TRANSPORTATION: "Transport", TRAVEL: "Travel",
  RENT_AND_UTILITIES: "Rent & bills", INVESTING: "Investing", OTHER: "Other",
};

export const KIND_LABELS = {
  income: "Counted as income", received: "Money sent to you, counted as income",
  investing: "Investing, counted as money out", fidelity: "Fidelity, not counted", spending: "Counted as spending", refund: "Refund, lowers spending",
  transfer: "Between your accounts, not counted", card_payment: "Card payment, not counted",
  ignored: "You chose not to count this", other_account: "Loan or investment account, not counted",
  test: "Test bank, not counted",
};
export const COUNTED_KINDS = new Set(["income", "received", "spending", "investing", "refund"]);

const dayNum = (date) => Date.parse(date + "T00:00:00Z") / 86400000;

// rows: transactions joined with their account's type, subtype and item_id.
export function classifyAll(rows, { testItems = new Set() } = {}) {
  const kinds = new Map();
  const isCard = (t) => t.account_type === "credit";
  const looksLikeTransfer = (t) =>
    TRANSFER_CATEGORIES.has(t.category) || t.category === "LOAN_PAYMENTS" && (isCard(t) || CARD_PAYMENT.test(t.name ?? "")) ||
    t.detailed === "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT" || (isCard(t) && t.amount < 0 && CARD_PAYMENT.test(t.name ?? ""));
  const text = (t) => `${t.name ?? ""} ${t.merchant ?? ""}`;
  const isFidelity = (t) => FIDELITY.test(text(t));
  const isInvesting = (t) => t.amount > 0 && !isCard(t) && ACORNS.test(text(t));
  const fromSomeoneElse = (t) => t.amount < 0 && !isCard(t) && !ACORNS.test(text(t)) && !isFidelity(t) &&
    (PEOPLE.test(text(t)) || t.category === "TRANSFER_IN" && !OWN_MONEY_IN.has(t.detailed));

  // Pair each money-out with a same-sized money-in on another of your accounts a few days apart,
  // unless the money-in is a paycheck that doesn't look like a transfer. Each transaction pairs once.
  // The transfer itself is never spending; purchases made later from the receiving account are.
  const pairable = rows.filter((t) => t.counted == null && !testItems.has(t.item_id) && !isInvesting(t) && !isFidelity(t));
  const ins = pairable.filter((t) => t.amount < 0);
  const paired = new Map(); // id -> "card_payment" | "transfer"
  for (const out of pairable.filter((t) => t.amount > 0).sort((a, b) => a.date.localeCompare(b.date))) {
    const match = ins.find((i) => !paired.has(i.id) && i.account_id !== out.account_id &&
      Math.abs(i.amount + out.amount) < 0.005 && Math.abs(dayNum(i.date) - dayNum(out.date)) <= MATCH_DAYS &&
      (looksLikeTransfer(out) || looksLikeTransfer(i) || i.category !== "INCOME" || (isCard(i) && !isCard(out))));
    if (match) {
      const kind = isCard(match) || isCard(out) ? "card_payment" : "transfer";
      paired.set(match.id, kind); paired.set(out.id, kind);
    }
  }

  for (const t of rows) {
    let kind;
    if (testItems.has(t.item_id)) kind = "test";
    else if (t.counted === 0) kind = "ignored";
    else if (t.counted === 1) kind = t.amount < 0 ? "income" : "spending";
    else if (t.account_type === "loan" || t.account_type === "investment") kind = "other_account";
    else if (isFidelity(t)) kind = "fidelity";
    else if (isInvesting(t)) kind = "investing";
    else if (paired.has(t.id)) kind = paired.get(t.id);
    else if (fromSomeoneElse(t)) kind = "received";
    else if (looksLikeTransfer(t)) kind = isCard(t) || t.category === "LOAN_PAYMENTS" || t.detailed === "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT" ? "card_payment" : "transfer";
    else if (t.amount >= 0) kind = "spending";
    else kind = t.category === "INCOME" && !isCard(t) ? "income" : "refund";
    kinds.set(t.id, kind);
  }
  return kinds;
}

// Transactions in a month plus a few days either side, so payments that cross a month boundary still pair up.
export async function classifiedMonth(db, month, opts) {
  const [y, m] = month.split("-").map(Number);
  const from = new Date(Date.UTC(y, m - 1, 1 - MATCH_DAYS)).toISOString().slice(0, 10);
  const to = new Date(Date.UTC(y, m, MATCH_DAYS)).toISOString().slice(0, 10);
  const rows = await db.prepare(`
    SELECT t.*, a.type AS account_type, a.subtype AS account_subtype, a.item_id, a.name AS account
    FROM transactions t JOIN accounts a ON a.id = t.account_id
    WHERE t.date BETWEEN ? AND ? ORDER BY t.date DESC, t.rowid DESC`).all(from, to);
  const kinds = classifyAll(rows, opts);
  return rows.filter((t) => t.date.startsWith(month)).map((t) => ({ ...t, kind: kinds.get(t.id) }));
}

export async function monthSummary(db, month, opts) {
  const txs = await classifiedMonth(db, month, opts);
  let income = 0, spent = 0, movedToSavings = 0, paidFromBanks = 0, paidOnCards = 0;
  const byCategory = {};
  const savingsLike = (t) => ["savings", "money market", "cd", "hsa"].includes(t.account_subtype);
  for (const t of txs) {
    if (t.kind === "income" || t.kind === "received") income += -t.amount;
    else if (t.kind === "spending" || t.kind === "refund" || t.kind === "investing") {
      spent += t.amount; // a refund is negative, so it lowers spending
      const c = t.kind === "investing" ? "INVESTING" : t.category ?? "OTHER";
      byCategory[c] = (byCategory[c] ?? 0) + t.amount;
    } else if (t.kind === "transfer" && t.amount < 0 && savingsLike(t)) movedToSavings += -t.amount;
    else if (t.kind === "card_payment") {
      if (t.account_type === "credit") paidOnCards += -t.amount; else paidFromBanks += t.amount;
    }
  }
  // Each payment shows up on the bank side, the card side, or both; take the fuller side so it's counted once.
  const cardPayments = Math.max(paidFromBanks, paidOnCards);
  const round = (n) => Math.round(n * 100) / 100;
  const limits = Object.fromEntries((await db.prepare("SELECT category, monthly_limit FROM budgets").all()).map((b) => [b.category, b.monthly_limit]));
  const categories = Object.keys({ ...byCategory, ...limits })
    .map((c) => ({ category: c, label: CATEGORY_LABELS[c] ?? c, spent: round(Math.max(0, byCategory[c] ?? 0)), limit: limits[c] ?? null }))
    .filter((c) => c.spent > 0 || c.limit)
    .sort((a, b) => b.spent - a.spent);
  return { month, income: round(income), spent: round(Math.max(0, spent)), saved: round(income - Math.max(0, spent)), movedToSavings: round(movedToSavings), cardPayments: round(cardPayments), categories };
}

export function shiftMonth(month, n) {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

export async function cardsOwed(db, { testItems = new Set() } = {}) {
  const rows = (await db.prepare("SELECT item_id, current FROM accounts WHERE type = 'credit'").all()).filter((a) => !testItems.has(a.item_id));
  return Math.round(rows.reduce((s, a) => s + (a.current ?? 0), 0) * 100) / 100;
}

export async function netWorth(db, { testItems = new Set() } = {}) {
  // Credit cards and loans report what you owe as a positive balance.
  const rows = (await db.prepare("SELECT item_id, type, current FROM accounts").all()).filter((a) => !testItems.has(a.item_id));
  return Math.round(rows.reduce((s, a) => s + (["credit", "loan"].includes(a.type) ? -1 : 1) * (a.current ?? 0), 0) * 100) / 100;
}
