/* ui.js - the tracker interface. Depends on parse/categorize/normalize, which the
   build inlines above this file. */

const INR = (n, frac = 0) => new Intl.NumberFormat('en-IN', {
  style: 'currency', currency: 'INR', maximumFractionDigits: frac, minimumFractionDigits: frac,
}).format(Number(n) || 0);

const el = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const monthLabel = ym => {
  if (!ym) return '';
  const [y, m] = ym.split('-');
  return new Date(Date.UTC(+y, +m - 1, 1)).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
};

const State = {
  txns: [],        // every transaction, all months
  review: [],
  rules: {},
  month: null,
  tab: 'month',
  sample: false,
  store: null,
  pending: null,
  lastImport: null,
};

/* ------------------------------------------------------------------ storage */

/** Capabilities are a per-view fact, and absent entirely outside claude.ai. */
async function useCapability(name) {
  try { return (await window.claude?.use?.(name)) ?? null; }
  catch { return null; }
}

/**
 * Durable storage when the page has it, per-browser storage when it doesn't.
 * A month is one document: the store caps documents at 256 KiB, so raw message
 * text is trimmed before it is written.
 */
const LS_KEY = 'expense-tracker-v1';

function makeStore(db) {
  if (!db) {
    return {
      kind: 'local',
      async load() {
        try { return JSON.parse(localStorage.getItem(LS_KEY) || 'null') || { months: {}, rules: {} }; }
        catch { return { months: {}, rules: {} }; }
      },
      async save(data) {
        try { localStorage.setItem(LS_KEY, JSON.stringify(data)); } catch { /* quota or blocked */ }
      },
    };
  }
  return {
    kind: 'db',
    async load() {
      const [monthsSnap, rulesSnap] = await Promise.all([
        db.collection('months').get(),
        db.doc('meta/rules').get(),
      ]);
      const months = {};
      for (const d of monthsSnap.docs) months[d.id] = (d.data() || {}).txns || [];
      return { months, rules: (rulesSnap.exists && rulesSnap.data().rules) || {} };
    },
    async save(data, changedMonths) {
      const jobs = [db.doc('meta/rules').set({ rules: data.rules })];
      const months = changedMonths || Object.keys(data.months);
      for (const ym of months) {
        jobs.push(db.doc(`months/${ym}`).set({ txns: data.months[ym] || [], updatedAt: new Date().toISOString() }));
      }
      await Promise.all(jobs);
    },
  };
}

/** Keep stored rows small: the full alert text is only needed for review. */
function forStorage(t) {
  return { ...t, raw: t.confidence >= 0.7 ? String(t.raw || '').slice(0, 160) : t.raw };
}

function bucketByMonth(txns) {
  const months = {};
  for (const t of txns) {
    const ym = monthOf(t);
    (months[ym] = months[ym] || []).push(forStorage(t));
  }
  return months;
}

async function persist(changed) {
  if (State.sample) return;  // sample data is never written to storage
  const data = { months: bucketByMonth(State.txns.concat(State.review)), rules: State.rules };
  try { await State.store.save(data, changed); }
  catch (e) { toast('Could not save. Your changes are on screen but not stored.'); }
}

/* ------------------------------------------------------------------ import */

/** SMS Backup & Restore writes one <sms> per message; type="1" means received. */
function readSmsXml(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) return null;
  const out = [];
  for (const node of doc.querySelectorAll('sms')) {
    if (node.getAttribute('type') !== '1') continue;   // skip messages we sent
    const body = node.getAttribute('body');
    if (!body) continue;
    const ms = Number(node.getAttribute('date'));
    out.push({
      body,
      sender: node.getAttribute('address') || '',
      receivedAt: Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null,
    });
  }
  return out;
}

function readCsv(text) {
  const rows = text.split(/\r?\n/).filter(Boolean).map(line => {
    const cells = []; let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
      else if (c === ',' && !q) { cells.push(cur); cur = ''; }
      else cur += c;
    }
    cells.push(cur);
    return cells;
  });
  if (!rows.length) return [];
  const head = rows[0].map(h => h.toLowerCase().trim());
  const bodyCol = head.findIndex(h => /body|message|text|description|narration/.test(h));
  if (bodyCol === -1) return null;
  const dateCol = head.findIndex(h => /date|time/.test(h));
  const fromCol = head.findIndex(h => /address|sender|from/.test(h));
  return rows.slice(1).filter(r => r[bodyCol]).map(r => ({
    body: r[bodyCol],
    sender: fromCol > -1 ? r[fromCol] : '',
    receivedAt: dateCol > -1 && !isNaN(Date.parse(r[dateCol])) ? new Date(r[dateCol]).toISOString() : null,
  }));
}

/** Accepts everything the import drawer offers and returns parse-ready messages. */
function toMessages(text, filename = '') {
  if (/\.xml$/i.test(filename) || /^\s*<\?xml|<smses/i.test(text)) {
    const sms = readSmsXml(text);
    if (sms) return sms;
  }
  if (/\.csv$/i.test(filename) || /,/.test(text.split('\n')[0] || '')) {
    const csv = readCsv(text);
    if (csv && csv.length) return csv;
  }
  return splitMessages(text).map(body => ({ body, sender: '', receivedAt: null }));
}

/* --------------------------------------------------------------- statements */

const ROLE_LABELS = {
  date: 'Date', narration: 'Description', debit: 'Withdrawal',
  credit: 'Deposit', amount: 'Amount', balance: 'Balance', ref: 'Reference',
};

/** Pull the account and bank out of the rows above the header, so the common
 *  case needs no typing at all. */
function guessAccountMeta(rows, headerRow, filename) {
  // Only the preamble is trustworthy for this: narrations are full of OTHER
  // banks' names (the payee's bank on every transfer), so scanning the rows
  // would confidently label an ICICI statement "HDFC". Blank beats wrong - the
  // field is right there to type into.
  const preamble = rows.slice(0, Math.max(headerRow, 0)).flat().join(' ');
  const iss = detectIssuer(preamble, '') || detectIssuer(filename || '', '');
  const m = /(?:account|a\/c|card)\s*(?:number|no\.?)?\s*[:\-]?\s*([\dxX*]{6,20})/i.exec(preamble)
    || /-\s*(\d{8,20})\s*(?:,|$)/.exec(preamble);
  const digits = m ? m[1].replace(/\D/g, '') : '';

  // The holder's name is what lets us spot transfers you made to yourself -
  // often the largest lines on a statement, and not spending.
  const nameMatch = /account name\s*[:\-]\s*([A-Za-z][A-Za-z .]{3,45}?)\s*(?:,|$)/i.exec(preamble)
    || /list\s*-\s*([A-Za-z][A-Za-z .]{3,45}?)\s*-\s*\d{6,}/i.exec(preamble);
  return {
    issuer: iss ? iss.name : '',
    account: digits.slice(-4) || '',
    holder: nameMatch ? nameMatch[1].trim() : '',
  };
}

async function readSpreadsheet(file) {
  if (/\.csv$/i.test(file.name)) return parseCsv(await file.text());
  if (typeof XLSX === 'undefined') {
    toast('Excel support did not load. Re-download the statement as CSV.');
    return null;
  }
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' });
}

/** Show what was found and let it be corrected before anything is imported. */
function openStatementStep(rows, layout, filename) {
  const meta = guessAccountMeta(rows, layout.headerRow, filename);
  State.pending = { rows, layout, filename, ...meta };
  el('paste-step').hidden = true;
  renderStatementStep();
}

function renderStatementStep() {
  const { rows, layout, filename, issuer, account, holder } = State.pending;
  const header = layout.header || [];
  const colOptions = role => [`<option value="">— none —</option>`]
    .concat(header.map((h, i) =>
      `<option value="${i}"${layout.map[role] === i ? ' selected' : ''}>${esc(String(h || `Column ${i + 1}`).trim() || `Column ${i + 1}`)}</option>`))
    .join('');

  const { txns } = rowsToTransactions(rows, layout, {
    knownMerchants: SEED_NEEDLES, issuer, account: account || null, accountHolder: holder,
  });
  const check = checkBalanceContinuity(txns);

  el('statement-step').hidden = false;
  el('statement-step').innerHTML = `
    <p class="drawer-sub">Read <strong>${esc(filename)}</strong> — found ${txns.length} transaction${txns.length === 1 ? '' : 's'}.
      Check the columns below, then import.</p>

    <div class="acct-row">
      <label>Bank or card<input id="st-issuer" type="text" value="${esc(issuer)}" placeholder="ICICI Bank"></label>
      <label>Last 4 digits<input id="st-account" type="text" maxlength="4" value="${esc(account)}" placeholder="7890"></label>
      <label>Account holder<input id="st-holder" type="text" value="${esc(holder || '')}" placeholder="Your name, to spot self-transfers"></label>
    </div>

    <div class="map-grid">
      ${Object.keys(ROLE_LABELS).map(role => `
        <label>${ROLE_LABELS[role]}
          <select data-role="${role}">${colOptions(role)}</select>
        </label>`).join('')}
    </div>

    ${balanceCheckHtml(check, txns.length)}

    ${txns.length ? `<div class="preview"><table>
      <thead><tr><th>Date</th><th>Description</th><th class="num">Amount</th><th class="num">Balance</th></tr></thead>
      <tbody>${txns.slice(0, 8).map(t => `<tr>
        <td class="mono">${esc(t.date)}</td>
        <td>${esc(t.merchant || '—')}</td>
        <td class="num mono ${t.direction === 'credit' ? 'is-credit' : ''}">${t.direction === 'credit' ? '+' : '−'}${INR(t.amount, 2)}</td>
        <td class="num mono dim">${t.balance == null ? '—' : INR(t.balance, 2)}</td>
      </tr>`).join('')}</tbody></table></div>` : ''}

    <div class="drawer-actions">
      <button class="btn btn-primary" id="btn-commit-statement"${txns.length ? '' : ' disabled'}>Import ${txns.length} transaction${txns.length === 1 ? '' : 's'}</button>
      <button class="btn btn-ghost" id="btn-back-to-paste">Back</button>
    </div>`;

  for (const sel of el('statement-step').querySelectorAll('select[data-role]')) {
    sel.addEventListener('change', e => {
      const role = e.target.dataset.role;
      const v = e.target.value;
      if (v === '') delete State.pending.layout.map[role];
      else State.pending.layout.map[role] = Number(v);
      renderStatementStep();
    });
  }
  const FIELD = { 'st-issuer': 'issuer', 'st-account': 'account', 'st-holder': 'holder' };
  for (const id of Object.keys(FIELD)) {
    el(id).addEventListener('input', e => { State.pending[FIELD[id]] = e.target.value.trim(); });
    // The holder name changes self-transfer detection, so re-read the sheet.
    if (id === 'st-holder') el(id).addEventListener('change', renderStatementStep);
  }
  el('btn-commit-statement').addEventListener('click', commitStatement);
  el('btn-back-to-paste').addEventListener('click', () => {
    State.pending = null;
    el('statement-step').hidden = true;
    el('paste-step').hidden = false;
  });
}

/**
 * The running balance is what makes a statement import verifiable rather than
 * merely plausible, so the result is shown before anything is committed.
 */
function balanceCheckHtml(check, total) {
  if (!check.available) {
    return `<div class="check check-none"><strong>No balance column to check against</strong>
      The amounts will import as they are, but nothing can confirm the file is complete.
      Re-download with the balance column if your bank offers it.</div>`;
  }

  // Rows listed out of sequence still add up in total. Banks do this with
  // same-day transactions; it is not an error and not worth alarming anyone over.
  const ordering = check.breaks.length
    ? `<p class="note" style="margin-top:8px">${check.breaks.length} row${check.breaks.length === 1 ? ' is' : 's are'} listed out of order within their day. Normal for bank exports \u2014 they still reconcile.</p>`
    : '';

  if (check.netOk) {
    return `<div class="check check-ok"><strong>All ${check.checked} rows add up</strong>
      Opening ${INR(check.opening)} plus every deposit, minus every withdrawal, lands exactly on
      the closing balance of ${INR(check.closing)}. Nothing is missing, duplicated or misread.${ordering}</div>`;
  }

  const missing = check.netGap < 0 ? 'left the account' : 'arrived';
  return `<div class="check check-bad"><strong>${INR(Math.abs(check.netGap), 2)} ${missing} without a row to explain it</strong>
    Across ${check.checked} rows, the balance moves ${INR(Math.abs(check.netGap), 2)} more than the
    transactions account for. Usually a column mapped to the wrong role, or a few rows the export
    left out. The totals will be off by that much:
    <ul>${check.breaks.slice(0, 5).map(b =>
      `<li>${esc(b.date)} ${esc((b.merchant || '').slice(0, 24))} \u2014 off by ${INR(b.gap, 2)}</li>`).join('')}</ul></div>`;
}

async function commitStatement() {
  const { rows, layout, issuer, account, holder } = State.pending;
  const { txns } = rowsToTransactions(rows, layout, {
    knownMerchants: SEED_NEEDLES, issuer: issuer || null, account: account || null, accountHolder: holder,
  });
  if (!txns.length) { toast('Nothing to import.'); return; }

  // Sample rows are a demonstration, not data: a real import replaces them
  // outright rather than merging with them.
  const existing = State.sample ? [] : State.txns.concat(State.review);
  const combined = buildLedger(
    existing.map(t => ({ ...t, kind: 'txn' })).concat(txns),
    { rules: State.rules },
  );
  const added = combined.txns.length + combined.review.length - existing.length;
  State.sample = false;
  State.txns = combined.txns;
  State.review = combined.review;
  State.pending = null;

  const months = listMonths(State.txns);
  if (!months.includes(State.month)) State.month = months[0] || State.month;
  await persist();
  render();
  closeDrawer();
  toast(`Imported ${added} new transaction${added === 1 ? '' : 's'}${combined.duplicates ? `, skipped ${combined.duplicates} already tracked` : ''}.`);
}

async function importText(text, filename) {
  const messages = toMessages(text, filename);
  if (!messages.length) { toast('No messages found in that text.'); return; }

  const parsed = messages.map(m => parseMessage(m.body, { sender: m.sender, receivedAt: m.receivedAt }));
  const existing = State.sample ? [] : State.txns.concat(State.review);   // see commitStatement
  const combined = buildLedger(
    existing.map(t => ({ ...t, kind: 'txn' })).concat(parsed),
    { rules: State.rules },
  );

  const added = combined.txns.length + combined.review.length - existing.length;
  State.sample = false;
  State.txns = combined.txns;
  State.review = combined.review;
  State.lastImport = {
    scanned: messages.length,
    added,
    duplicates: combined.duplicates,
    ignored: combined.noise.length,
    review: combined.review.length,
  };

  const months = listMonths(State.txns);
  if (!months.includes(State.month)) State.month = months[0] || State.month;
  await persist();
  render();
  closeDrawer();
  toast(added > 0
    ? `Added ${added} transaction${added === 1 ? '' : 's'}.`
    : 'Nothing new - those messages were already tracked.');
}

/* ------------------------------------------------------------------ actions */

async function setCategory(txnId, category) {
  const t = State.txns.find(x => x.id === txnId);
  if (!t) return;
  State.rules = learnRule(State.rules, t.merchant, category);
  // Apply the correction everywhere that merchant appears, past and future.
  const key = normKey(t.merchant);
  let touched = 0;
  for (const x of State.txns) {
    if (normKey(x.merchant) === key && x.direction === 'debit') { x.category = category; x.categorySource = 'user'; touched++; }
  }
  await persist();
  render();
  if (touched > 1) toast(`${t.merchant} is now ${category} - updated ${touched} transactions.`);
}

async function confirmReview(idx) {
  const row = State.review[idx];
  const amount = Number(el(`rv-amt-${idx}`).value);
  const date = el(`rv-date-${idx}`).value;
  const merchant = el(`rv-mer-${idx}`).value.trim();
  if (!Number.isFinite(amount) || amount <= 0 || !date) { toast('Enter a valid amount and date.'); return; }
  const fixed = { ...row, amount, date, merchant, confidence: 1 };
  fixed.category = categorize(fixed, State.rules).category;
  fixed.id = dedupeKey(fixed);
  State.review.splice(idx, 1);
  State.txns.push(fixed);
  if (!listMonths(State.txns).includes(State.month)) State.month = monthOf(fixed);
  await persist();
  render();
}

async function dropReview(idx) {
  State.review.splice(idx, 1);
  await persist();
  render();
}

async function clearAll() {
  if (!confirm('Delete every transaction stored here? This cannot be undone.')) return;
  const months = Object.keys(bucketByMonth(State.txns.concat(State.review)));
  State.txns = []; State.review = []; State.lastImport = null; State.sample = false;
  try { await State.store.save({ months: Object.fromEntries(months.map(m => [m, []])), rules: State.rules }, months); }
  catch { /* surfaced below */ }
  render();
  toast('All transactions deleted.');
}

async function exportCsv() {
  const rows = [['date', 'amount', 'direction', 'merchant', 'category', 'issuer', 'account', 'channel', 'reference']];
  for (const t of State.txns.slice().sort((a, b) => (a.date || '').localeCompare(b.date || ''))) {
    rows.push([t.date || '', t.amount, t.direction, t.merchant || '', t.category, t.issuer || '', t.account || '', t.channel, t.ref || '']);
  }
  const csv = rows.map(r => r.map(c => /[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : String(c)).join(',')).join('\n');
  const dl = await useCapability('downloads');
  if (!dl) { toast('Downloads are not available in this view.'); return; }
  try { await dl.save({ filename: `transactions-${new Date().toISOString().slice(0, 10)}.csv`, data: csv }); }
  catch { /* viewer declined */ }
}

/* ------------------------------------------------------------------ charts */

/** Horizontal bars: length carries magnitude, so colour is not asked to. */
function categoryBars(rows, total) {
  if (!rows.length) return `<p class="empty">No spending recorded this month.</p>`;
  const max = rows[0].amount || 1;
  return `<div class="bars">` + rows.map(r => `
    <div class="bar-row">
      <div class="bar-label" title="${esc(r.key)}">${esc(r.key)}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${Math.max((r.amount / max) * 100, 1.5)}%"></div></div>
      <div class="bar-value">${INR(r.amount)}<span class="bar-pct">${r.pct}%</span></div>
    </div>`).join('') + `</div>`;
}

/** Thin columns for a time series. HTML rather than SVG so labels cannot overflow. */
function columnChart(points, { format = INR, labelEvery = 1 } = {}) {
  if (!points.length) return `<p class="empty">Nothing to plot yet.</p>`;
  const max = Math.max(...points.map(p => p.value), 1);
  return `<div class="cols" role="img" aria-label="${esc(points.map(p => `${p.label}: ${format(p.value)}`).join(', '))}">` +
    points.map((p, i) => `
      <div class="col" data-tip="${esc(p.label)} &middot; ${esc(format(p.value))}">
        <div class="col-bar" style="height:${Math.max((p.value / max) * 100, 2)}%"></div>
        <div class="col-label">${i % labelEvery === 0 ? esc(p.short ?? p.label) : ''}</div>
      </div>`).join('') + `</div>`;
}

/* ------------------------------------------------------------------ render */

function render() {
  const months = listMonths(State.txns);
  if (!State.month || (!months.includes(State.month) && months.length)) State.month = months[0];
  renderHeader(months);
  el('view').innerHTML = State.tab === 'month' ? monthView() : trendsView();
  el('review-panel').innerHTML = reviewPanel();
  wireView();
}

function renderHeader(months) {
  const opts = months.length
    ? months.map(m => `<option value="${m}"${m === State.month ? ' selected' : ''}>${esc(monthLabel(m))}</option>`).join('')
    : `<option>No data yet</option>`;
  el('month-select').innerHTML = opts;
  el('month-select').disabled = !months.length;
  for (const t of ['month', 'trends']) el(`tab-${t}`).setAttribute('aria-selected', String(State.tab === t));
  el('sample-banner').hidden = !State.sample;
  el('storage-note').textContent = State.store.kind === 'db'
    ? 'Saved to this page'
    : 'Saved in this browser only';
}

function monthView() {
  const s = summarizeMonth(State.txns, State.month);
  const prevMonths = listMonths(State.txns).filter(m => m < State.month);
  const prev = prevMonths.length ? summarizeMonth(State.txns, prevMonths[0]) : null;
  const delta = prev && prev.spend ? Math.round(((s.spend - prev.spend) / prev.spend) * 1000) / 10 : null;

  const daily = s.daily.map(d => ({ label: d.key, short: String(+d.key.slice(8)), value: d.amount }));

  return `
  <section class="summary">
    <div class="tile tile-lead">
      <span class="tile-label">Spent</span>
      <span class="figure">${INR(s.spend)}</span>
      ${delta === null ? `<span class="tile-sub">${s.txnCount} transactions</span>`
        : `<span class="tile-sub ${delta > 0 ? 'is-up' : 'is-down'}">${delta > 0 ? '▲' : '▼'} ${Math.abs(delta)}% vs ${esc(monthLabel(prevMonths[0]).split(' ')[0])}</span>`}
    </div>
    <div class="tile">
      <span class="tile-label">Money in</span>
      <span class="figure-sm">${INR(s.income)}</span>
      <span class="tile-sub">${s.income ? 'recorded as income' : 'no income alerts yet'}</span>
    </div>
    <div class="tile">
      <span class="tile-label">Left over</span>
      <span class="figure-sm ${s.net < 0 ? 'is-negative' : ''}">${INR(s.net)}</span>
      <span class="tile-sub">${s.savingsRate === null ? 'needs an income alert' : `${s.savingsRate}% of money in`}</span>
    </div>
    <div class="tile">
      <span class="tile-label">Invested</span>
      <span class="figure-sm">${INR(s.invested)}</span>
      <span class="tile-sub">not counted as spending</span>
    </div>
  </section>

  <div class="grid-2">
    <section class="panel">
      <h2>Where it went</h2>
      ${categoryBars(s.byCategory, s.spend)}
    </section>
    <section class="panel">
      <h2>Day by day</h2>
      ${columnChart(daily, { labelEvery: daily.length > 16 ? 5 : 2 })}
      ${s.largest ? `<p class="note">Biggest single spend: <strong>${INR(s.largest.amount)}</strong> at ${esc(s.largest.merchant || 'unknown')} on ${esc(s.largest.date)}.</p>` : ''}
    </section>
  </div>

  <section class="panel">
    <h2>Transactions <span class="count">${s.txnCount}</span></h2>
    ${txnTable()}
  </section>`;
}

function txnTable() {
  const rows = State.txns
    .filter(t => monthOf(t) === State.month)
    .sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.amount - a.amount);
  if (!rows.length) return `<p class="empty">No transactions for ${esc(monthLabel(State.month))} yet.</p>`;

  const opts = c => CATEGORIES.map(x => `<option${x === c ? ' selected' : ''}>${x}</option>`).join('');
  return `<div class="table-wrap"><table>
    <thead><tr><th>Date</th><th>Merchant</th><th>Category</th><th>Account</th><th class="num">Amount</th></tr></thead>
    <tbody>${rows.map(t => `
      <tr${t.netted ? ' class="is-netted"' : ''}>
        <td class="mono">${esc((t.date || '').slice(5))}</td>
        <td>
          <span class="merchant">${esc(t.merchant || 'Unknown')}</span>
          ${t.netted ? '<span class="chip chip-muted">reversed</span>' : ''}
          ${t.channel === 'atm' ? '<span class="chip">cash</span>' : ''}
        </td>
        <td><select class="cat-select" data-id="${esc(t.id)}" aria-label="Category for ${esc(t.merchant || 'transaction')}">${opts(t.category)}</select></td>
        <td class="mono dim">${esc(t.issuer || '—')}${t.account ? ` ••${esc(t.account)}` : ''}</td>
        <td class="num mono ${t.direction === 'credit' ? 'is-credit' : ''}">${t.direction === 'credit' ? '+' : ''}${INR(t.amount, 2)}</td>
      </tr>`).join('')}
    </tbody></table></div>`;
}

function trendsView() {
  const months = listMonths(State.txns).slice().reverse();
  const series = months.map(m => {
    const s = summarizeMonth(State.txns, m);
    return { label: monthLabel(m), short: monthLabel(m).slice(0, 3), value: s.spend, s };
  });
  const recurring = detectRecurring(State.txns);
  const avg = series.length ? Math.round(series.reduce((a, p) => a + p.value, 0) / series.length) : 0;

  return `
  <section class="panel">
    <h2>Spending by month</h2>
    ${series.length < 2
      ? `<p class="empty">Import a few months of messages to see a trend.</p>`
      : `${columnChart(series)}<p class="note">Average across ${series.length} months: <strong>${INR(avg)}</strong>.</p>`}
  </section>

  <section class="panel">
    <h2>Recurring payments</h2>
    ${!recurring.length
      ? `<p class="empty">Nothing repeating yet — this needs three months of messages to spot a pattern.</p>`
      : `<div class="table-wrap"><table>
          <thead><tr><th>Merchant</th><th>Category</th><th class="num">Typical</th><th class="num">Per year</th></tr></thead>
          <tbody>${recurring.map(r => `
            <tr><td class="merchant">${esc(r.merchant)}</td><td class="dim">${esc(r.category)}</td>
            <td class="num mono">${INR(r.avgAmount)}</td><td class="num mono">${INR(r.annualized)}</td></tr>`).join('')}
          </tbody></table></div>
         <p class="note">Seen in ${recurring[0].months}+ separate months at a steady amount. Cancelling the top one saves ${INR(recurring[0].annualized)} a year.</p>`}
  </section>

  <section class="panel">
    <h2>Category by month</h2>
    ${series.length < 2 ? `<p class="empty">Needs at least two months.</p>` : catTrendTable(months)}
  </section>`;
}

function catTrendTable(months) {
  const recent = months.slice(-6);
  const sums = recent.map(m => summarizeMonth(State.txns, m));
  const cats = [...new Set(sums.flatMap(s => s.byCategory.map(c => c.key)))];
  const totalFor = (s, c) => (s.byCategory.find(x => x.key === c) || { amount: 0 }).amount;
  cats.sort((a, b) => sums.reduce((n, s) => n + totalFor(s, b), 0) - sums.reduce((n, s) => n + totalFor(s, a), 0));

  return `<div class="table-wrap"><table>
    <thead><tr><th>Category</th>${recent.map(m => `<th class="num">${esc(monthLabel(m).slice(0, 3))}</th>`).join('')}</tr></thead>
    <tbody>${cats.map(c => `<tr><td>${esc(c)}</td>${sums.map(s => {
      const v = totalFor(s, c);
      return `<td class="num mono ${v ? '' : 'dim'}">${v ? INR(v) : '—'}</td>`;
    }).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function reviewPanel() {
  if (!State.review.length) return '';
  return `<section class="panel panel-review">
    <h2>Needs a look <span class="count count-warn">${State.review.length}</span></h2>
    <p class="note">These messages carried an amount we could not fully read. Nothing here counts towards your totals until you confirm it.</p>
    ${State.review.map((r, i) => `
      <div class="review-row">
        <p class="review-raw">${esc(r.raw)}</p>
        <div class="review-fields">
          <label>Amount<input id="rv-amt-${i}" type="number" step="0.01" value="${r.amount ?? ''}"></label>
          <label>Date<input id="rv-date-${i}" type="date" value="${esc(r.date || '')}"></label>
          <label>Merchant<input id="rv-mer-${i}" type="text" value="${esc(r.merchant || '')}" placeholder="Who was paid"></label>
          <button class="btn btn-sm" data-review-add="${i}">Add it</button>
          <button class="btn btn-sm btn-ghost" data-review-drop="${i}">Not a transaction</button>
        </div>
      </div>`).join('')}
  </section>`;
}

/* ------------------------------------------------------------------ wiring */

function wireView() {
  for (const sel of document.querySelectorAll('.cat-select')) {
    sel.addEventListener('change', e => setCategory(e.target.dataset.id, e.target.value));
  }
  for (const b of document.querySelectorAll('[data-review-add]')) {
    b.addEventListener('click', () => confirmReview(+b.dataset.reviewAdd));
  }
  for (const b of document.querySelectorAll('[data-review-drop]')) {
    b.addEventListener('click', () => dropReview(+b.dataset.reviewDrop));
  }
  const tip = el('tip');
  for (const c of document.querySelectorAll('.col')) {
    c.addEventListener('pointerenter', e => {
      tip.innerHTML = c.dataset.tip; tip.hidden = false;
      const r = c.getBoundingClientRect();
      tip.style.left = `${r.left + r.width / 2}px`;
      tip.style.top = `${r.top - 10}px`;
    });
    c.addEventListener('pointerleave', () => { tip.hidden = true; });
  }
}

let toastTimer;
function toast(msg) {
  const t = el('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4000);
}

function openDrawer() { el('drawer').hidden = false; el('paste-box').focus(); }
function closeDrawer() {
  el('drawer').hidden = true;
  el('paste-box').value = '';
  State.pending = null;
  el('statement-step').hidden = true;
  el('statement-step').innerHTML = '';
  el('paste-step').hidden = false;
}

/* ------------------------------------------------------------------ sample */

const SAMPLE_MESSAGES = (() => {
  const now = new Date();
  const ym = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getFullYear()).slice(2)}`;
  const d = n => `${String(n).padStart(2, '0')}-${ym}`;
  return [
    `Dear Customer, Acct XX4417 is credited with Rs 92,000.00 on ${d(1)} from SALARY.`,
    `Rs.24,000.00 debited from HDFC Bank A/C x4417 on ${d(2)}. Info: NEFT-RENT. Avl bal:INR 74,120.55`,
    `Sent Rs.318.00 From HDFC Bank A/C x4417 To swiggy@ybl On ${d(3)} Ref 561203914477`,
    `Sent Rs.1,240.00 From HDFC Bank A/C x4417 To blinkit@ybl On ${d(4)} Ref 561203914501`,
    `INR 2,499.00 spent using Amazon Pay ICICI Bank Card XX8802 on ${d(5)} on AMAZON. Avl Lmt: INR 1,42,501`,
    `Rs.649.00 debited from HDFC Bank A/C x4417 to NETFLIX on ${d(6)} Ref 561203915002`,
    `Sent Rs.214.00 From HDFC Bank A/C x4417 To uber@axisbank On ${d(7)} Ref 561203915120`,
    `Dear Customer, Rs.4000.00 withdrawn at SBI ATM S1AB4417 from A/c X4417 on ${d(8)} Txn# 884120. Avl Bal Rs 45231.10`,
    `INR 1,180.00 spent using Amazon Pay ICICI Bank Card XX8802 on ${d(9)} on ZOMATO. Avl Lmt: INR 1,41,321`,
    `Rs.15,000.00 debited from HDFC Bank A/C x4417 to ZERODHA on ${d(10)} Ref 561203915880`,
    `Your AU Bank Credit Card xx6310 is used for INR 3,499.00 at DECATHLON on ${d(11)}. Avl Limit INR 96,501`,
    `Sent Rs.899.00 From HDFC Bank A/C x4417 To airtel@hdfcbank On ${d(12)} Ref 561203916240`,
    `123456 is your OTP for a transaction of Rs.2,499.00. Do not share this OTP with anyone.`,
    `Rs.499.00 will be debited from your A/c XX4417 on ${d(25)} towards SPOTIFY autopay.`,
  ];
})();

function loadSample() {
  const led = buildLedger(SAMPLE_MESSAGES.map(m => parseMessage(m)), { rules: {} });
  State.txns = led.txns;
  State.review = led.review;
  State.sample = true;
  State.month = listMonths(State.txns)[0];
}

/* ------------------------------------------------------------------ boot */

async function boot() {
  const db = await useCapability('db');
  State.store = makeStore(db);

  let data = { months: {}, rules: {} };
  try { data = await State.store.load(); } catch { toast('Could not load saved data.'); }

  State.rules = data.rules || {};
  const stored = Object.values(data.months || {}).flat();
  if (stored.length) {
    State.txns = stored.filter(t => (t.confidence ?? 1) >= 0.7);
    State.review = stored.filter(t => (t.confidence ?? 1) < 0.7);
    State.month = listMonths(State.txns)[0];
  } else {
    loadSample();
  }
  render();
}

el('btn-import').addEventListener('click', openDrawer);
el('btn-close-drawer').addEventListener('click', closeDrawer);
el('drawer').addEventListener('click', e => { if (e.target.id === 'drawer') closeDrawer(); });
el('btn-parse').addEventListener('click', () => importText(el('paste-box').value, ''));
el('btn-export').addEventListener('click', exportCsv);
el('btn-clear').addEventListener('click', clearAll);
el('month-select').addEventListener('change', e => { State.month = e.target.value; render(); });
for (const t of ['month', 'trends']) {
  el(`tab-${t}`).addEventListener('click', () => { State.tab = t; render(); });
}
el('file-input').addEventListener('change', async e => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    if (/\.(xlsx?|csv)$/i.test(f.name)) {
      const rows = await readSpreadsheet(f);
      if (rows) {
        const layout = detectLayout(rows);
        if (layout.headerRow !== -1) { openStatementStep(rows, layout, f.name); e.target.value = ''; return; }
      }
      // A CSV with no statement header is probably an export of messages.
    }
    await importText(await f.text(), f.name);
  } catch (err) {
    toast('Could not read that file. CSV or Excel statements work best.');
  }
  e.target.value = '';
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !el('drawer').hidden) closeDrawer(); });

boot().catch(() => {
  loadSample();
  State.store = State.store || makeStore(null);
  render();
  toast('Started with sample data - saved data could not be loaded.');
});
