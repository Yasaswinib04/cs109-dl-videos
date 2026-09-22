/**
 * normalize.js - turn a pile of parsed messages into a trustworthy ledger.
 *
 * The three things that quietly ruin a message-based tracker, all handled here:
 *   1. Re-pasting an overlapping batch double-counts everything  -> dedupe().
 *   2. A failed UPI payment is debited then reversed              -> netReversals().
 *   3. Paying a credit card bill from your bank looks like fresh
 *      spend, on top of the card purchases you already counted    -> Transfers excluded.
 */

import { categorize, canonicalMerchant, normKey } from './categorize.js';

const REVIEW_THRESHOLD = 0.7;

/** Stable identity for a transaction, so the same alert never lands twice. */
export function dedupeKey(t) {
  // A bank reference number is globally unique; prefer it when present.
  if (t.ref) return `ref:${t.ref}:${t.amount}`;
  return `d:${t.date || '?'}|${t.amount}|${t.account || '?'}|${normKey(t.merchant)}`;
}

/**
 * Every identity a transaction answers to. One record can be known by its
 * reference in one source and only by date+amount in another, so matching on a
 * single key would let the same payment through twice.
 */
export function dedupeKeys(t) {
  const keys = [];
  if (t.ref) keys.push(`ref:${t.ref}:${t.amount}`);
  keys.push(`d:${t.date || '?'}|${t.amount}|${t.account || '?'}|${normKey(t.merchant)}`);
  return keys;
}

/** Same money, same day, same account - used only to match ACROSS sources. */
const crossKey = t => `x:${t.date || '?'}|${t.amount}|${t.account || '?'}`;

/** Guard the cross-source match: two different payees are two transactions. */
function merchantsCompatible(a, b) {
  const x = normKey(a), y = normKey(b);
  if (!x || !y) return true;
  return x === y || x.includes(y) || y.includes(x);
}

/** Statements are complete and authoritative; an alert message is a notification
 *  about the same event. When both describe one transaction, the statement wins. */
const SOURCE_RANK = { statement: 3, manual: 2, sms: 1, undefined: 1 };
const rankOf = t => SOURCE_RANK[t.source] ?? 1;

export function dedupe(txns) {
  const rows = new Map();        // id -> transaction
  const claims = new Map();      // any key -> id
  const cross = new Map();       // cross key -> { id, source }
  const order = [];
  let duplicates = 0;

  for (const t of txns) {
    const keys = dedupeKeys(t);
    const xk = crossKey(t);

    let id = keys.map(k => claims.get(k)).find(Boolean);
    if (!id) {
      const c = cross.get(xk);
      // Only across sources: within one source, two like-sized payments on one
      // day are two payments, not a duplicate.
      if (c && c.source !== t.source && merchantsCompatible(t.merchant, rows.get(c.id)?.merchant)) id = c.id;
    }

    if (!id) {
      id = keys[0];
      rows.set(id, { ...t, id });
      order.push(id);
      for (const k of keys) claims.set(k, id);
      cross.set(xk, { id, source: t.source });
      continue;
    }

    duplicates++;
    const existing = rows.get(id);
    if (rankOf(t) > rankOf(existing)) {
      // Keep any category the user already corrected on the row being replaced,
      // and keep the id so earlier claims still resolve.
      rows.set(id, {
        ...t, id,
        category: existing.categorySource === 'user' ? existing.category : t.category,
        categorySource: existing.categorySource === 'user' ? 'user' : t.categorySource,
      });
    }
    for (const k of keys) if (!claims.has(k)) claims.set(k, id);
  }
  return { txns: order.map(k => rows.get(k)), duplicates };
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

  // Collapse brand spellings BEFORE dedupe, so the same payment described two
  // ways by two sources still matches.
  const named = raw.map(t => ({ ...t, merchant: canonicalMerchant(t.merchant, t.raw) }));
  const { txns: unique, duplicates } = dedupe(named);
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
const NON_SPEND = new Set(['Transfers', 'Investment']);

export function summarizeMonth(txns, month) {
  const inMonth = txns.filter(t => monthOf(t) === month && !t.netted);
  const debits = inMonth.filter(t => t.direction === 'debit');
  const credits = inMonth.filter(t => t.direction === 'credit');

  const sum = arr => Math.round(arr.reduce((a, t) => a + t.amount, 0) * 100) / 100;

  const spendTxns = debits.filter(t => !NON_SPEND.has(t.category));
  const income = sum(credits.filter(t => t.category === 'Income'));
  const spend = sum(spendTxns);
  const invested = sum(debits.filter(t => t.category === 'Investment'));
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

/**
 * Propose categories for the long tail the rule table cannot reach.
 *
 * Most unlabelled rows are payments to a person's own UPI handle with no note -
 * a ride paid straight to the driver, or the shop on the corner. No rule table
 * can name those, and a learned rule is useless for rides because the payee is
 * a different driver every time. What IS learnable is the shape:
 *
 *   - A payee seen ONCE, for a small amount in the range your known rides
 *     actually fall in, is very likely a ride.
 *   - A payee seen SEVERAL times for small amounts is somewhere you go back to -
 *     a regular shop - so one decision should settle all of its rows.
 *
 * These are suggestions with their evidence attached, never silent assignments:
 * a wrong category that nobody saw being applied is worse than an honest
 * "Miscellaneous", because it corrupts the totals invisibly.
 *
 * The ride band is derived from the user's OWN labelled rides where there are
 * enough of them, rather than a number picked in advance.
 */
export function suggestCategories(txns) {
  const spendable = txns.filter(t => t.direction === 'debit' && !t.netted);
  const unknown = spendable.filter(t => t.category === 'Miscellaneous');
  if (!unknown.length) return { rides: [], groups: [], band: null };

  const rideAmounts = spendable
    .filter(t => /^(uber|rapido|ola)$/i.test(t.merchant || ''))
    .map(t => t.amount).sort((a, b) => a - b);

  const at = q => rideAmounts[Math.floor(rideAmounts.length * q)];
  const band = rideAmounts.length >= 10
    ? { low: Math.max(20, Math.round(at(0.1) * 0.6)), high: Math.round(at(0.9) * 1.6), learned: true }
    : { low: 30, high: 400, learned: false };

  const seen = new Map();
  for (const t of spendable) {
    const k = normKey(t.merchant);
    if (!k) continue;
    seen.set(k, (seen.get(k) || 0) + 1);
  }

  const rides = [];
  const groupMap = new Map();
  for (const t of unknown) {
    const k = normKey(t.merchant);
    const count = seen.get(k) || 1;
    if (count === 1 && t.amount >= band.low && t.amount <= band.high) {
      rides.push(t);
    } else if (count >= 2) {
      if (!groupMap.has(k)) groupMap.set(k, { key: k, merchant: t.merchant, txns: [] });
      groupMap.get(k).txns.push(t);
    }
  }

  const groups = [...groupMap.values()].map(g => ({
    ...g,
    count: g.txns.length,
    total: Math.round(g.txns.reduce((a, t) => a + t.amount, 0) * 100) / 100,
    avg: Math.round((g.txns.reduce((a, t) => a + t.amount, 0) / g.txns.length) * 100) / 100,
  })).sort((a, b) => b.total - a.total);

  return {
    band,
    rides: rides.sort((a, b) => (a.date || '').localeCompare(b.date || '')),
    ridesTotal: Math.round(rides.reduce((a, t) => a + t.amount, 0) * 100) / 100,
    groups,
  };
}

export function listMonths(txns) {
  return [...new Set(txns.map(monthOf))].filter(m => m !== 'unknown').sort().reverse();
}
