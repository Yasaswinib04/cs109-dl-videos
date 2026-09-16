/**
 * statement.js - read a bank or card statement into transactions.
 *
 * Statements beat alert messages on every axis that matters: they are complete
 * (nothing depends on an SMS arriving), authoritative, and they carry a running
 * balance, which lets us PROVE an import is correct rather than hope it is.
 * See checkBalanceContinuity below - that check is the whole reason to prefer
 * this path.
 *
 * The hard part is that no two banks agree on a layout, and most put several
 * rows of preamble above the real header. So nothing here is hard-coded to one
 * bank: we score candidate header rows, map columns by name, and hand the user
 * the mapping to correct when scoring is not confident.
 */

import { extractDate } from './parse.js';
import { normKey } from './categorize.js';

/* ------------------------------------------------------------------ csv */

/** Split CSV text into rows of cells. Handles quoted cells and embedded commas. */
export function parseCsv(text) {
  const rows = [];
  let row = [], cur = '', quoted = false;
  const src = String(text).replace(/\r\n?/g, '\n');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') { if (src[i + 1] === '"') { cur += '"'; i++; } else quoted = false; }
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows.map(r => r.map(c => c.trim()));
}

/* ------------------------------------------------------------------ layout */

/** Header names seen across Indian bank and card statements, by role. */
const COLUMN_PATTERNS = {
  date:      /^(transaction|txn|value|posting|tran\.?)?\s*date$|^date\b|^date of transaction/i,
  narration: /narration|remarks|description|particulars|details|transaction remark|merchant|nature of transaction/i,
  debit:     /withdrawal|^debit|debit amount|^dr\b|withdrawal amt|amount \(dr\)/i,
  credit:    /deposit|^credit|credit amount|^cr\b|deposit amt|amount \(cr\)/i,
  amount:    /^(transaction )?amount( \(inr\))?$|^amt$|^amount in inr$/i,
  balance:   /balance|closing bal|available bal/i,
  ref:       /cheque|ref(erence)?\s*(no|number)?|transaction id|txn id/i,
};

// "Withdrawal Amount (INR)" matches both `debit` and `amount`; the specific role wins.
const ROLE_PRIORITY = ['date', 'balance', 'debit', 'credit', 'narration', 'ref', 'amount'];

function scoreHeaderRow(cells) {
  const roles = new Set();
  for (const cell of cells) {
    const v = String(cell || '').trim();
    if (!v) continue;
    for (const role of ROLE_PRIORITY) {
      if (COLUMN_PATTERNS[role].test(v)) { roles.add(role); break; }
    }
  }
  // A real header names a date and at least one money column.
  if (!roles.has('date')) return { score: 0, roles };
  if (!roles.has('debit') && !roles.has('credit') && !roles.has('amount')) return { score: 0, roles };
  return { score: roles.size, roles };
}

/**
 * Find the header row and map each role to a column index.
 * Statements bury the header under account-holder and period rows, so we scan.
 */
export function detectLayout(rows) {
  let best = { score: 0, headerRow: -1 };
  const limit = Math.min(rows.length, 30);
  for (let i = 0; i < limit; i++) {
    const { score } = scoreHeaderRow(rows[i]);
    if (score > best.score) best = { score, headerRow: i };
  }
  if (best.headerRow === -1) return { headerRow: -1, map: {}, confident: false };

  const header = rows[best.headerRow];
  const map = {};
  const taken = new Set();
  // Where a statement carries several date columns, the transaction date is the
  // one a person means; value date can differ by days.
  const PREFERRED = { date: /transaction\s*date|txn\s*date/i };
  for (const [role, pref] of Object.entries(PREFERRED)) {
    for (let c = 0; c < header.length; c++) {
      if (pref.test(String(header[c] || ''))) { map[role] = c; taken.add(c); break; }
    }
  }
  for (const role of ROLE_PRIORITY) {
    if (map[role] !== undefined) continue;
    for (let c = 0; c < header.length; c++) {
      if (taken.has(c)) continue;
      const v = String(header[c] || '').trim();
      if (v && COLUMN_PATTERNS[role].test(v)) { map[role] = c; taken.add(c); break; }
    }
  }
  // Two money columns (withdrawal/deposit) or one signed column - never both.
  if (map.debit !== undefined || map.credit !== undefined) delete map.amount;

  return {
    headerRow: best.headerRow,
    header,
    map,
    confident: best.score >= 3 && map.date !== undefined &&
      (map.amount !== undefined || map.debit !== undefined || map.credit !== undefined),
  };
}

/* ------------------------------------------------------------------ cells */

const EXCEL_EPOCH = Date.UTC(1899, 11, 30);

/** Statement date cells arrive as strings, Date objects, or Excel serials. */
export function cellToDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 10);
  if (typeof v === 'number' && v > 20000 && v < 60000) {
    return new Date(EXCEL_EPOCH + v * 864e5).toISOString().slice(0, 10);
  }
  return extractDate(String(v));
}

/** "1,299.00", "(1,299.00)" and "1299.00 Dr" all mean the same magnitude. */
export function cellToAmount(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.abs(v) : null;
  const s = String(v).trim();
  if (!s || /^[-–—]$/.test(s)) return null;
  const m = /-?[\d,]*\d(?:\.\d+)?/.exec(s.replace(/[₹]|rs\.?|inr/gi, ''));
  if (!m) return null;
  const n = Number(m[0].replace(/,/g, ''));
  return Number.isFinite(n) ? Math.abs(n) : null;
}

function signOf(cell) {
  const s = String(cell || '');
  if (/\bcr\b|\bcredit\b/i.test(s)) return 'credit';
  if (/\bdr\b|\bdebit\b/i.test(s)) return 'debit';
  if (/^\s*\(.*\)\s*$/.test(s) || /^\s*-/.test(s)) return 'debit';
  return null;
}

/* ------------------------------------------------------------------ narration */

/** Scheme codes, routing noise and filler that are never the counterparty. */
const NARRATION_NOISE = new Set([
  'upi','mmt','imps','neft','rtgs','ach','nfs','vin','iin','top','si','inf','bil','pos','atw','atd',
  'vps','ecs','nach','cms','int','chg','gst','dtax','gib','mat','eba','onl','idm','ttr','set','rev',
  'vsi','npci','p2m','p2a','payment','from','to','ph','na','null','self','collect','pay','txn','ref',
  'bpay','inft','tpt','ib','mb','and','the','for','via','by','dr','cr','inb','ecom','purchase',
]);

// An IFSC is four letters, a literal zero, then the branch code. The zero is
// what distinguishes it from an ordinary long word like AMAZONIND.
const LOOKS_LIKE_BANK_CODE = /^[A-Z]{4}0[A-Z0-9]{4,6}$/;
const CHANNEL_HINTS = [
  ['atm',      /\b(nfs|atw|atd|cash ?wdl|cash withdrawal|atm)\b/i],
  ['upi',      /\bupi\b|@[a-z]{2,}/i],
  ['card',     /\b(vin|pos|ecom|vps|purchase)\b/i],
  ['mandate',  /\b(ach|ecs|nach|si)\b/i],
  ['transfer', /\b(neft|imps|rtgs|mmt|inft|inft|tpt)\b/i],
];

/**
 * Pull the counterparty out of a statement narration such as
 * "UPI/307012345678/Payment from Ph/SWIGGY/YESB0YESBNK".
 *
 * @param {string} text
 * @param {string[]} [knownMerchants] lowercase needles; a segment matching one
 *        is almost certainly the merchant, which settles otherwise-tied segments.
 */
export function parseNarration(text, knownMerchants = []) {
  const raw = String(text || '').trim();
  const out = { merchant: null, channel: 'other', ref: null, vpa: null };
  if (!raw) return out;

  for (const [channel, re] of CHANNEL_HINTS) {
    if (re.test(raw)) { out.channel = channel; break; }
  }

  const refMatch = /\b(\d{9,18})\b/.exec(raw);
  if (refMatch) out.ref = refMatch[1];

  const vpa = /\b([a-zA-Z0-9][a-zA-Z0-9._-]{1,})@([a-z]{2,})\b/.exec(raw);
  if (vpa) { out.vpa = `${vpa[1]}@${vpa[2]}`; out.merchant = cleanName(vpa[1]); return out; }

  const segments = raw.split(/[\/|]+/).map(s => s.trim()).filter(Boolean);
  const candidates = [];
  for (const seg of segments) {
    const words = seg.split(/\s+/).filter(w => !NARRATION_NOISE.has(w.toLowerCase()));
    const cleaned = words.join(' ').replace(/[^A-Za-z0-9&.' -]/g, ' ').replace(/\s+/g, ' ').trim();
    if (cleaned.length < 3) continue;
    if (!/[A-Za-z]{3}/.test(cleaned)) continue;                 // needs real letters
    if (/^\d+$/.test(cleaned.replace(/\s/g, ''))) continue;
    // Only a single token can be a routing code; a multi-word segment is a name.
    if (!/\s/.test(cleaned) && LOOKS_LIKE_BANK_CODE.test(cleaned)) continue;
    if (NARRATION_NOISE.has(cleaned.toLowerCase())) continue;

    const key = normKey(cleaned);
    const known = knownMerchants.some(n => key.includes(n));
    candidates.push({ text: cleaned, known, digits: (cleaned.match(/\d/g) || []).length });
  }
  if (!candidates.length) return out;

  // A recognised merchant wins outright; then the least numeric segment; then the
  // longest, since a counterparty name outruns a leftover scheme code like "SAL".
  candidates.sort((a, b) =>
    (b.known - a.known) || (a.digits - b.digits) || (b.text.length - a.text.length));
  out.merchant = cleanName(candidates[0].text);
  return out;
}

function cleanName(s) {
  return String(s).replace(/\s+/g, ' ').replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '').slice(0, 48).trim();
}

/* ------------------------------------------------------------------ rows */

/**
 * Convert statement rows into transactions using a column mapping.
 * @returns {{txns: object[], skipped: number}}
 */
export function rowsToTransactions(rows, layout, opts = {}) {
  const { map, headerRow } = layout;
  const known = opts.knownMerchants || [];
  const account = opts.account || null;
  const issuer = opts.issuer || null;
  const accountType = opts.accountType || 'bank';
  const txns = [];
  let skipped = 0;

  // A lone amount column means one of two conventions: signed (negatives are
  // debits, so a bare positive is a credit), or all-positive (every row a debit,
  // as card statements list spends). One negative anywhere settles which.
  let signedColumn = false;
  if (map.amount !== undefined && map.debit === undefined && map.credit === undefined) {
    for (let i = headerRow + 1; i < rows.length; i++) {
      if (signOf(rows[i]?.[map.amount]) === 'debit') { signedColumn = true; break; }
    }
  }

  for (let i = headerRow + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || !row.length) continue;
    const date = cellToDate(row[map.date]);
    if (!date) { skipped++; continue; }

    let amount = null, direction = null;
    if (map.debit !== undefined || map.credit !== undefined) {
      const dr = cellToAmount(row[map.debit]);
      const cr = cellToAmount(row[map.credit]);
      if (dr) { amount = dr; direction = 'debit'; }
      else if (cr) { amount = cr; direction = 'credit'; }
    } else if (map.amount !== undefined) {
      amount = cellToAmount(row[map.amount]);
      // A single amount column carries its sign in the cell, or in a Dr/Cr marker
      // somewhere on the row.
      direction = signOf(row[map.amount]) || signOf(row.join(' ')) ||
        (signedColumn ? 'credit' : (opts.defaultDirection || 'debit'));
    }
    if (!amount) { skipped++; continue; }

    const narration = map.narration !== undefined ? String(row[map.narration] || '') : '';
    const parsed = parseNarration(narration, known);
    const balance = map.balance !== undefined ? cellToAmount(row[map.balance]) : null;

    txns.push({
      kind: 'txn',
      source: 'statement',
      date,
      amount,
      direction,
      merchant: parsed.merchant || (parsed.channel === 'atm' ? 'Cash withdrawal' : null),
      channel: parsed.channel,
      ref: (map.ref !== undefined && String(row[map.ref] || '').trim()) || parsed.ref || null,
      balance,
      issuer,
      account,
      accountType,
      confidence: parsed.merchant ? 0.95 : 0.8,   // the amount and date are certain
      raw: narration || `${date} ${amount}`,
    });
  }
  return { txns, skipped };
}

/* ------------------------------------------------------------------ proof */

/**
 * A statement's running balance makes the import verifiable: for every
 * consecutive pair, previous balance minus debit plus credit must equal the next
 * balance. If that holds throughout, no row was dropped, duplicated or
 * misparsed - a guarantee no message-based import can offer. Where it breaks, we
 * name the row so it can be fixed rather than silently trusted.
 */
export function checkBalanceContinuity(txns) {
  const withBal = txns.filter(t => typeof t.balance === 'number' && Number.isFinite(t.balance));
  if (withBal.length < 2) return { checked: 0, ok: true, breaks: [], available: false };

  const breaks = [];
  for (let i = 1; i < withBal.length; i++) {
    const prev = withBal[i - 1], cur = withBal[i];
    const delta = cur.direction === 'credit' ? cur.amount : -cur.amount;
    const expected = prev.balance + delta;
    if (Math.abs(expected - cur.balance) > 0.05) {
      breaks.push({
        index: i,
        date: cur.date,
        merchant: cur.merchant,
        amount: cur.amount,
        expected: Math.round(expected * 100) / 100,
        actual: cur.balance,
        gap: Math.round((cur.balance - expected) * 100) / 100,
      });
    }
  }
  return { checked: withBal.length, ok: breaks.length === 0, breaks, available: true };
}
