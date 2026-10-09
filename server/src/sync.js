// Pulls new, changed and removed transactions plus fresh balances for every linked bank.
export async function syncItem({ db, plaid, sealer }, item) {
  const accessToken = sealer.open(item.access_token);

  const { data: acct } = await plaid.accountsGet({ access_token: accessToken });
  const upsertAccount = db.prepare(`
    INSERT INTO accounts (id, item_id, name, mask, type, subtype, current, available, currency)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, mask=excluded.mask, type=excluded.type,
      subtype=excluded.subtype, current=excluded.current, available=excluded.available, currency=excluded.currency`);
  for (const a of acct.accounts) {
    upsertAccount.run(a.account_id, item.id, a.official_name || a.name, a.mask ?? null, a.type, a.subtype ?? null,
      a.balances.current ?? null, a.balances.available ?? null, a.balances.iso_currency_code ?? "USD");
  }

  const upsertTx = db.prepare(`
    INSERT INTO transactions (id, account_id, date, name, merchant, amount, category, detailed, pending)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET date=excluded.date, name=excluded.name, merchant=excluded.merchant,
      amount=excluded.amount, category=excluded.category, detailed=excluded.detailed, pending=excluded.pending`);
  const removeTx = db.prepare("DELETE FROM transactions WHERE id = ?");

  let cursor = item.cursor ?? undefined;
  let added = 0, modified = 0, removed = 0;
  // Plaid pages through changes; keep going until has_more is false.
  for (;;) {
    const { data } = await plaid.transactionsSync({ access_token: accessToken, cursor, count: 500 });
    for (const t of [...data.added, ...data.modified]) {
      upsertTx.run(t.transaction_id, t.account_id, t.date, t.name, t.merchant_name ?? null, t.amount,
        t.personal_finance_category?.primary ?? null, t.personal_finance_category?.detailed ?? null, t.pending ? 1 : 0);
    }
    for (const r of data.removed) removeTx.run(r.transaction_id);
    added += data.added.length; modified += data.modified.length; removed += data.removed.length;
    cursor = data.next_cursor;
    if (!data.has_more) break;
  }
  db.prepare("UPDATE items SET cursor = ?, synced_at = datetime('now') WHERE id = ?").run(cursor ?? null, item.id);
  return { added, modified, removed };
}

export async function syncAll(deps) {
  const items = deps.db.prepare("SELECT * FROM items").all();
  const results = [];
  for (const item of items) {
    try {
      results.push({ item: item.id, institution: item.institution, ...(await syncItem(deps, item)) });
    } catch (err) {
      // A bank that needs the user to log in again (ITEM_LOGIN_REQUIRED) should not block the others.
      results.push({ item: item.id, institution: item.institution, error: err.response?.data?.error_code ?? err.message });
    }
  }
  return results;
}
