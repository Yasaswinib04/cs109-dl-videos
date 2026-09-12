/**
 * normalize.js - turn a pile of parsed messages into a trustworthy ledger.
 *
 * The three things that quietly ruin a message-based tracker, all handled here:
 *   1. Re-pasting an overlapping batch double-counts everything  -> dedupe().
 *   2. A failed UPI payment is debited then reversed              -> netReversals().
 *   3. Paying a credit card bill from your bank looks like fresh
 *      spend, on top of the card purchases you already counted    -> Transfers excluded.
 */

import { categorize, normKey } from './categorize.js';

const REVIEW_THRESHOLD = 0.7;

/** Stable identity for a transaction, so the same alert never lands twice. */
export function dedupeKey(t) {
  // A bank reference number is globally unique; prefer it when present.
  if (t.ref) return `ref:${t.ref}:${t.amount}`;
  return `d:${t.date || '?'}|${t.amount}|${t.account || '?'}|${normKey(t.merchant)}`;
}

export function dedupe(txns) {
  const seen = new Map();
  const kept = [];
  let duplicates = 0;
  for (const t of txns) {
    const k = dedupeKey(t);
    if (seen.has(k)) { duplicates++; continue; }
    seen.set(k, true);
    kept.push({ ...t, id: k });
  }
  return { txns: kept, duplicates };
}

/**
 * A failed payment shows up as a debit and, days later, a matching credit.
 * Counting both leaves the month looking like you spent and earned money you
 * never did, so we pair them off and drop both from the totals.
 */
export function netReversals(txns) {
  const out = txns.map(t => ({ ...t }));
  const isReversal = t => /\b(revers(ed|al)|refund(ed)?)\b/i.test(t.raw || '');
  const credits = out.filter(t => t.direction === 'credit' && isReversal(t) && !t.netted);

  for (const c of credits) {
    const match = out.find(d =>
      d.direction === 'debit' && !d.netted &&
      Math.abs(d.amount - c.amount) < 0.01 &&
      d.date && c.date &&
      Math.abs(Date.parse(c.date) - Date.parse(d.date)) <= 7 * 864e5
    );
    if (match) {
      match.netted = true;
      c.netted = true;
      c.nettedAgainst = match.id;
    }
  }
  return out;
}

/**
 * @param {object[]} parsed  output of parseMessage(), any kind
 * @param {object} [opts]    { rules } learned category overrides
 */
export function buildLedger(parsed, opts = {}) {
  const rules = opts.rules || {};
  const noise = parsed.filter(p => p.kind === 'noise');
  const raw = parsed.filter(p => p.kind === 'txn');

  const { txns: unique, duplicates } = dedupe(raw);
  const categorized = unique.map(t => {
    const { category, source } = categorize(t, rules);
    return { ...t, category, categorySource: source };
  });
  const netted = netReversals(categorized);

  return {
    txns: netted.filter(t => t.confidence >= REVIEW_THRESHOLD),
    // Low-confidence rows are surfaced, never dropped: a missed transaction is
    // worse than a wrong one, because you cannot see what is not there.
    review: netted.filter(t => t.confidence < REVIEW_THRESHOLD),
    noise,
    duplicates,
  };
}

export function monthOf(t) {
  return t.date ? t.date.slice(0, 7) : 'unknown';
}

/** Categories that move money without consuming it. */
const NON_SPEND = new Set(['Transfers', 'Investments']);

export function summarizeMonth(txns, month) {
  const inMonth = txns.filter(t => monthOf(t) === month && !t.netted);
  const debits = inMonth.filter(t => t.direction === 'debit');
  const credits = inMonth.filter(t => t.direction === 'credit');

  const sum = arr => Math.round(arr.reduce((a, t) => a + t.amount, 0) * 100) / 100;

  const spendTxns = debits.filter(t => !NON_SPEND.has(t.category));
  const income = sum(credits.filter(t => t.category === 'Income'));
  const spend = sum(spendTxns);
  const invested = sum(debits.filter(t => t.category === 'Investments'));
  const transfers = sum(debits.filter(t => t.category === 'Transfers'));

  const group = (arr, keyFn) => {
    const map = new Map();
    for (const t of arr) {
      const k = keyFn(t) || 'Unknown';
      const e = map.get(k) || { key: k, amount: 0, count: 0 };
      e.amount += t.amount; e.count++;
      map.set(k, e);
    }
    return [...map.values()]
      .map(e => ({ ...e, amount: Math.round(e.amount * 100) / 100 }))
      .sort((a, b) => b.amount - a.amount);
  };

  const byCategory = group(spendTxns, t => t.category);
  for (const c of byCategory) c.pct = spend ? Math.round((c.amount / spend) * 1000) / 10 : 0;

  const daily = group(spendTxns, t => t.date).sort((a, b) => a.key.localeCompare(b.key));

  return {
    month,
    income, spend, invested, transfers,
    net: Math.round((income - spend - invested) * 100) / 100,
    savingsRate: income ? Math.round(((income - spend) / income) * 1000) / 10 : null,
    txnCount: inMonth.length,
    largest: spendTxns.slice().sort((a, b) => b.amount - a.amount)[0] || null,
    byCategory,
    byMerchant: group(spendTxns, t => t.merchant).slice(0, 15),
    byAccount: group(debits, t => (t.issuer ? `${t.issuer} ${t.account ? '••' + t.account : ''}`.trim() : 'Unknown')),
    daily,
  };
}

/**
 * Subscriptions hide in plain sight: the same merchant, roughly the same amount,
 * in three or more different months.
 */
export function detectRecurring(txns) {
  const groups = new Map();
  for (const t of txns) {
    if (t.direction !== 'debit' || t.netted || !t.merchant) continue;
    const k = normKey(t.merchant);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }

  const recurring = [];
  for (const [key, list] of groups) {
    const months = new Set(list.map(monthOf));
    if (months.size < 3) continue;
    const amounts = list.map(t => t.amount);
    const avg = amounts.reduce((a, b) => a + b, 0) / amounts.length;
    const stable = amounts.every(a => Math.abs(a - avg) <= Math.max(avg * 0.15, 5));
    if (!stable) continue;
    recurring.push({
      merchant: list[0].merchant,
      key,
      avgAmount: Math.round(avg * 100) / 100,
      months: months.size,
      category: list[0].category,
      annualized: Math.round(avg * 12 * 100) / 100,
    });
  }
  return recurring.sort((a, b) => b.annualized - a.annualized);
}

export function listMonths(txns) {
  return [...new Set(txns.map(monthOf))].filter(m => m !== 'unknown').sort().reverse();
}
