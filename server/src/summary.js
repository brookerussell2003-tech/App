// Money moving between your own accounts (card payments, savings transfers) is neither
// spending nor income, so it is left out of both.
// Other loan payments (car, student, mortgage) still count as spending.
const isTransfer = (t) =>
  t.category === "TRANSFER_IN" || t.category === "TRANSFER_OUT" || t.detailed === "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT";

export const CATEGORY_LABELS = {
  INCOME: "Income", TRANSFER_IN: "Transfer in", TRANSFER_OUT: "Transfer out", LOAN_PAYMENTS: "Loan & card payments",
  BANK_FEES: "Bank fees", ENTERTAINMENT: "Fun", FOOD_AND_DRINK: "Food & drink", GENERAL_MERCHANDISE: "Shopping",
  HOME_IMPROVEMENT: "Home", MEDICAL: "Health", PERSONAL_CARE: "Personal care", GENERAL_SERVICES: "Services",
  GOVERNMENT_AND_NON_PROFIT: "Taxes & giving", TRANSPORTATION: "Transport", TRAVEL: "Travel",
  RENT_AND_UTILITIES: "Rent & bills", OTHER: "Other",
};

export async function monthSummary(db, month) {
  const txs = await db.prepare("SELECT * FROM transactions WHERE substr(date, 1, 7) = ?").all(month);
  const savings = new Set((await db.prepare("SELECT id FROM accounts WHERE subtype IN ('savings','money market','cd','hsa') OR type = 'investment'").all()).map((r) => r.id));
  let income = 0, spent = 0, movedToSavings = 0;
  const byCategory = {};
  for (const t of txs) {
    if (isTransfer(t)) {
      if (t.amount < 0 && savings.has(t.account_id)) movedToSavings += -t.amount;
      continue;
    }
    if (t.amount < 0) income += -t.amount;
    else {
      spent += t.amount;
      const c = t.category ?? "OTHER";
      byCategory[c] = (byCategory[c] ?? 0) + t.amount;
    }
  }
  const round = (n) => Math.round(n * 100) / 100;
  const limits = Object.fromEntries((await db.prepare("SELECT category, monthly_limit FROM budgets").all()).map((b) => [b.category, b.monthly_limit]));
  const categories = Object.keys({ ...byCategory, ...limits })
    .map((c) => ({ category: c, label: CATEGORY_LABELS[c] ?? c, spent: round(byCategory[c] ?? 0), limit: limits[c] ?? null }))
    .sort((a, b) => b.spent - a.spent);
  return { month, income: round(income), spent: round(spent), saved: round(income - spent), movedToSavings: round(movedToSavings), categories };
}

export function shiftMonth(month, n) {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

export async function netWorth(db) {
  // Credit cards and loans report what you owe as a positive balance.
  const rows = await db.prepare("SELECT type, current FROM accounts").all();
  return Math.round(rows.reduce((s, a) => s + (["credit", "loan"].includes(a.type) ? -1 : 1) * (a.current ?? 0), 0) * 100) / 100;
}
