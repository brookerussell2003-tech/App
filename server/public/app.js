(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const money = (n, cents = false) => (n < 0 ? "−" : "") + "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 });
  const ym = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  const thisMonth = () => ym(new Date());
  const shift = (m, n) => { const [y, mo] = m.split("-").map(Number); return ym(new Date(y, mo - 1 + n, 1)); };
  const monthName = (m, short) => { const [y, mo] = m.split("-").map(Number); return new Date(y, mo - 1, 1).toLocaleDateString("en-US", short ? { month: "short" } : { month: "long", year: "numeric" }); };

  let token = null;
  try { token = localStorage.getItem("moneybook-token"); } catch {}
  let month = thisMonth(), screen = "month", editing = false, confirmRemove = null, txCache = [];

  function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast.h); toast.h = setTimeout(() => (t.hidden = true), 2600); }
  function notice(msg) { $("#notice").textContent = msg ?? ""; $("#notice").hidden = !msg; }

  async function api(path, { method = "GET", body } = {}) {
    const res = await fetch(path, {
      method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (res.status === 401) { lock("That password didn't match. Try again."); throw new Error("locked"); }
    if (!res.ok) throw new Error(json.error ?? `The server answered ${res.status}`);
    return json;
  }

  /* ---------- unlock ---------- */
  function lock(err) {
    token = null; try { localStorage.removeItem("moneybook-token"); } catch {}
    $("#app").hidden = true; $("#login").hidden = false;
    $("#loginError").textContent = err ?? ""; $("#loginError").hidden = !err;
  }
  $("#loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    token = $("#token").value.trim();
    try { await api("/api/accounts"); } catch { return; }
    try { localStorage.setItem("moneybook-token", token); } catch {}
    $("#token").value = ""; $("#login").hidden = true; $("#app").hidden = false; load();
  });

  /* ---------- screens ---------- */
  const TITLES = { month: "Month", accounts: "Accounts", activity: "Activity" };
  document.querySelectorAll(".tabbar button").forEach((b) => b.addEventListener("click", () => show(b.dataset.tab)));
  function show(name) {
    screen = name;
    document.querySelectorAll(".tabbar button").forEach((b) => (b.dataset.tab === name ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current")));
    document.querySelectorAll("main section").forEach((s) => (s.hidden = s.dataset.screen !== name));
    $("#screenTitle").textContent = TITLES[name];
    $("#monthNav").hidden = name === "accounts";
    notice(null); load();
  }
  $("#prevM").onclick = () => { month = shift(month, -1); load(); };
  $("#nextM").onclick = () => { month = shift(month, 1); load(); };

  async function load() {
    $("#monthLabel").textContent = monthName(month);
    $("#nextM").disabled = month >= thisMonth();
    try {
      if (screen === "month") renderMonth(await api(`/api/summary?month=${month}`));
      if (screen === "accounts") renderAccounts(await api("/api/accounts"));
      if (screen === "activity") { txCache = (await api(`/api/transactions?month=${month}`)).transactions; renderTx(); }
    } catch (e) { if (e.message !== "locked") notice(e.message); }
  }

  /* ---------- month ---------- */
  function renderMonth(s) {
    $("#sIn").textContent = money(s.income);
    $("#sOut").textContent = money(s.spent);
    const prev = s.trend.at(-2)?.spent ?? 0;
    $("#sOutSub").textContent = prev ? (s.spent <= prev ? `${money(prev - s.spent)} less than last month` : `${money(s.spent - prev)} more than last month`) : "spending this month";
    $("#sSaved").textContent = money(s.saved);
    $("#sRate").textContent = s.income ? `${Math.round((s.saved / s.income) * 100)}% of income` : `${money(s.movedToSavings)} to savings`;
    $("#sNet").textContent = money(s.netWorth);
    $("#editLimits").textContent = editing ? "Done" : "Set limits";

    if (!s.categories.length) $("#cats").innerHTML = `<p class="muted">No spending in ${esc(monthName(month))} yet. Link a bank on the Accounts tab.</p>`;
    else {
      const max = Math.max(1, ...s.categories.map((c) => Math.max(c.spent, c.limit ?? 0)));
      $("#cats").innerHTML = s.categories.map((c) => {
        const pct = c.limit ? c.spent / c.limit : 0;
        const cls = c.limit ? (pct > 1 ? "" : pct > 0.85 ? "near" : "ok") : "";
        const w = c.limit ? Math.min(100, pct * 100) : (c.spent / max) * 100;
        const right = editing
          ? `<input inputmode="decimal" data-cat="${esc(c.category)}" value="${c.limit ?? ""}" placeholder="no limit" aria-label="Monthly limit for ${esc(c.label)}">`
          : `<span class="num">${money(c.spent)}${c.limit ? ` <small>/ ${money(c.limit)}</small>` : ""}</span>`;
        const note = c.limit && !editing ? `<small>${pct > 1 ? money(c.spent - c.limit) + " over" : money(c.limit - c.spent) + " left"}</small>` : "";
        return `<div class="cat"><span>${esc(c.label)} ${note}</span>${right}<div class="bar"><i class="${cls}" style="width:${w}%"></i></div></div>`;
      }).join("");
    }
    renderTrend(s.trend);
  }
  $("#editLimits").onclick = async () => {
    if (editing) {
      const inputs = [...document.querySelectorAll("#cats input")];
      for (const i of inputs) await api(`/api/budgets/${encodeURIComponent(i.dataset.cat)}`, { method: "PUT", body: { monthlyLimit: Number(i.value) || 0 } }).catch(() => {});
      toast("Limits saved");
    }
    editing = !editing; load();
  };
  function renderTrend(rows) {
    const max = Math.max(100, ...rows.flatMap((r) => [r.spent, r.saved]));
    const step = 10 ** Math.floor(Math.log10(max)), top = Math.ceil(max / step) * step;
    const W = 360, H = 190, L = 46, B = 24, T = 8, cw = (W - L - 4) / 6, bw = Math.min(16, cw / 2 - 5);
    const y = (v) => T + (H - T - B) * (1 - Math.max(0, v) / top);
    let g = "";
    for (const v of [0, top / 2, top]) g += `<line x1="${L}" x2="${W - 4}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" font-size="10" fill="var(--muted)" font-family="var(--mono)">${money(v)}</text>`;
    rows.forEach((r, i) => {
      const cx = L + cw * i + cw / 2, cur = r.month === month, op = cur ? 1 : 0.55;
      g += `<rect x="${cx - bw - 1}" y="${y(r.spent)}" width="${bw}" height="${y(0) - y(r.spent)}" rx="2" fill="var(--spend)" opacity="${op}"><title>Spent ${money(r.spent)}</title></rect>`;
      g += `<rect x="${cx + 1}" y="${y(r.saved)}" width="${bw}" height="${y(0) - y(r.saved)}" rx="2" fill="var(--save)" opacity="${op}"><title>Saved ${money(r.saved)}</title></rect>`;
      g += `<text x="${cx}" y="${H - 6}" text-anchor="middle" font-size="11" fill="${cur ? "var(--ink)" : "var(--muted)"}" font-weight="${cur ? 600 : 400}">${monthName(r.month, true)}</text>`;
    });
    $("#trend").innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Spent and saved, last six months">${g}</svg>`;
  }

  /* ---------- accounts ---------- */
  function renderAccounts({ banks, accounts }) {
    $("#syncNow").hidden = !banks.length;
    if (!banks.length) {
      $("#banks").innerHTML = `<div class="card"><p class="muted" style="margin:0">No banks linked yet. Tap “Link a bank or card” and sign in through Plaid. In Plaid's test mode, use username <b>user_good</b> and password <b>pass_good</b>.</p></div>`;
      return;
    }
    $("#banks").innerHTML = banks.map((b) => `
      <div class="card">
        <div class="row"><h2>${esc(b.institution ?? "Bank")}</h2><small class="muted">${b.synced_at ? "Synced " + new Date(b.synced_at.replace(" ", "T") + "Z").toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "Not synced"}</small></div>
        ${accounts.filter((a) => a.item_id === b.id).map((a) => {
          const owed = a.type === "credit" || a.type === "loan";
          const bal = a.current == null ? "–" : owed ? `${money(a.current, true)} owed` : money(a.current, true);
          return `<div class="acct"><div>${esc(a.name)}${a.mask ? ` ••${esc(a.mask)}` : ""}<small>${esc(a.subtype ?? a.type)}</small></div><b class="${owed ? "c-spend" : ""}">${bal}</b></div>`;
        }).join("")}
        <button class="danger" data-remove="${esc(b.id)}">${confirmRemove === b.id ? "Tap again to unlink and delete its data" : "Unlink"}</button>
      </div>`).join("");
  }
  $("#banks").addEventListener("click", async (e) => {
    const id = e.target.closest("[data-remove]")?.dataset.remove;
    if (!id) return;
    if (confirmRemove !== id) { confirmRemove = id; load(); return; }
    confirmRemove = null;
    try { await api(`/api/banks/${encodeURIComponent(id)}`, { method: "DELETE" }); toast("Unlinked"); } catch (err) { notice(err.message); }
    load();
  });

  // Plaid's own sign-in screen opens on top of the app. Your bank password goes to Plaid, never to this app.
  $("#linkBank").onclick = async () => {
    const btn = $("#linkBank");
    if (!window.Plaid) { notice("Plaid didn't load. Check your connection and reload the page."); return; }
    btn.disabled = true; btn.textContent = "Opening Plaid…"; notice(null);
    try {
      const { linkToken } = await api("/api/link-token", { method: "POST" });
      const handler = window.Plaid.create({
        token: linkToken,
        onSuccess: async (publicToken, meta) => {
          btn.textContent = "Pulling in your transactions…";
          try {
            const r = await api("/api/exchange", { method: "POST", body: { publicToken, institution: meta.institution?.name } });
            toast(`Linked ${meta.institution?.name ?? "your bank"}: ${r.added} transactions`);
          } catch (err) { notice(err.message); }
          btn.disabled = false; btn.textContent = "Link a bank or card"; load();
        },
        onExit: (err) => {
          btn.disabled = false; btn.textContent = "Link a bank or card";
          if (err) notice(err.display_message || err.error_message || "Plaid closed with an error.");
        },
      });
      handler.open();
    } catch (err) {
      btn.disabled = false; btn.textContent = "Link a bank or card";
      if (err.message !== "locked") notice(err.message);
    }
  };
  $("#syncNow").onclick = async () => {
    const btn = $("#syncNow"); btn.disabled = true; btn.textContent = "Checking your banks…";
    try {
      const { results } = await api("/api/sync", { method: "POST" });
      const failed = results.filter((r) => r.error);
      if (failed.length) notice(`${failed.map((f) => f.institution ?? "A bank").join(", ")} needs attention: ${failed[0].error}`);
      else toast(`Up to date: ${results.reduce((n, r) => n + (r.added ?? 0), 0)} new`);
    } catch (err) { notice(err.message); }
    btn.disabled = false; btn.textContent = "Sync now"; load();
  };

  /* ---------- activity ---------- */
  $("#search").addEventListener("input", renderTx);
  function renderTx() {
    const q = $("#search").value.trim().toLowerCase();
    const rows = txCache.filter((t) => !q || `${t.merchant ?? ""} ${t.name} ${t.label}`.toLowerCase().includes(q));
    $("#txList").innerHTML = rows.length ? rows.map((t) => {
      const moneyIn = t.amount < 0; // Plaid: negative means money came in
      return `<li><span class="d">${t.date.slice(5).replace("-", "/")}</span>
        <span class="n">${esc(t.merchant ?? t.name)}<small>${esc(t.label)} · ${esc(t.account)}${t.pending ? " · pending" : ""}</small></span>
        <span class="a ${moneyIn ? "c-in" : ""}">${moneyIn ? "+" : "−"}${money(Math.abs(t.amount), true)}</span></li>`;
    }).join("") : `<li class="empty">Nothing in ${esc(monthName(month))}${q ? " matches" : ""}.</li>`;
  }

  if (token) { $("#app").hidden = false; load(); } else lock();
})();
