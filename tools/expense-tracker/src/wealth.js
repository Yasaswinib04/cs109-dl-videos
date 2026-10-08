/**
 * wealth.js - net worth from what is actually knowable.
 *
 * The hard truth this module is shaped around: no statement anyone can export
 * says what an investment is WORTH. A broker's fund ledger records cash crossing
 * the account, a bank statement records the bank, a card statement records the
 * card. Current value lives only in an app screen or a consolidated account
 * statement. So the design splits holdings into two kinds:
 *
 *   DERIVED  - taken from imported statements, never typed, always current.
 *              A bank balance is the closing balance of its latest row.
 *   ENTERED  - a number the owner reads off a screen once a month.
 *
 * Marking which is which matters: a derived figure can be trusted to the paisa,
 * an entered one is as fresh as the day it was typed, and a net worth that mixes
 * them silently invites more confidence than it has earned.
 */

export const ASSET_KINDS = ['Bank', 'Investment', 'Cash', 'Property', 'Other asset'];
export const DEBT_KINDS = ['Credit card', 'Loan', 'Other debt'];
export const ALL_KINDS = [...ASSET_KINDS, ...DEBT_KINDS];

const isDebt = kind => DEBT_KINDS.includes(kind);

/**
 * Closing balance per account, read from the most recent statement row that
 * carried one. Statements list same-day rows out of order, so the latest row is
 * the one with the newest date, breaking ties by position in the file.
 */
export function deriveBankBalances(txns) {
  const latest = new Map();
  txns.forEach((t, i) => {
    if (typeof t.balance !== 'number' || !Number.isFinite(t.balance)) return;
    if (t.accountType === 'card') return;          // a card's "balance" is debt, not an asset
    const key = `${t.issuer || 'Account'}${t.account ? ' ••' + t.account : ''}`;
    const prev = latest.get(key);
    const stamp = `${t.date || ''}|${String(i).padStart(6, '0')}`;
    if (!prev || stamp > prev.stamp) latest.set(key, { stamp, balance: t.balance, date: t.date });
  });
  return [...latest.entries()].map(([name, v]) => ({
    id: `auto:${name}`,
    name,
    kind: 'Bank',
    value: Math.round(v.balance * 100) / 100,
    asOf: v.date,
    derived: true,
  })).sort((a, b) => b.value - a.value);
}

/** Investment cost basis from transactions already categorised as Investment. */
export function investedFromLedger(txns) {
  const out = txns.filter(t => t.direction === 'debit' && t.category === 'Investment' && !t.netted);
  const back = txns.filter(t => t.direction === 'credit' && t.category === 'Investment' && !t.netted);
  const sum = a => Math.round(a.reduce((x, t) => x + t.amount, 0) * 100) / 100;
  return { paidIn: sum(out), takenOut: sum(back), net: Math.round((sum(out) - sum(back)) * 100) / 100 };
}

/**
 * @param {object[]} derived  rows from deriveBankBalances
 * @param {object[]} entered  rows the owner typed
 */
export function summarizeWealth(derived, entered) {
  const rows = [...derived, ...entered].filter(r => Number.isFinite(Number(r.value)));
  const assets = rows.filter(r => !isDebt(r.kind));
  const debts = rows.filter(r => isDebt(r.kind));
  const sum = a => Math.round(a.reduce((x, r) => x + Math.abs(Number(r.value) || 0), 0) * 100) / 100;

  const invested = rows.filter(r => r.kind === 'Investment');
  const withCost = invested.filter(r => Number.isFinite(Number(r.cost)) && Number(r.cost) > 0);
  const costTotal = sum(withCost.map(r => ({ value: r.cost })));
  const valueTotal = sum(withCost);

  return {
    assets: sum(assets),
    debts: sum(debts),
    netWorth: Math.round((sum(assets) - sum(debts)) * 100) / 100,
    rows,
    // How much of the figure is a typed number rather than a read one.
    enteredShare: rows.length ? Math.round((sum(entered) / Math.max(sum(rows), 1)) * 100) : 0,
    gain: withCost.length ? Math.round((valueTotal - costTotal) * 100) / 100 : null,
    gainPct: withCost.length && costTotal ? Math.round(((valueTotal - costTotal) / costTotal) * 1000) / 10 : null,
    costTotal, valueTotal,
    staleRows: entered.filter(r => r.asOf && monthsOld(r.asOf) >= 2),
  };
}

function monthsOld(iso) {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return 0;
  return Math.floor((Date.now() - then) / (30 * 864e5));
}

/** Freeze this month's figure so a trend exists later. */
export function takeSnapshot(snapshots, summary, month) {
  return {
    ...snapshots,
    [month]: {
      netWorth: summary.netWorth,
      assets: summary.assets,
      debts: summary.debts,
      takenAt: new Date().toISOString(),
    },
  };
}

export function snapshotSeries(snapshots) {
  return Object.entries(snapshots || {})
    .map(([month, s]) => ({ month, ...s }))
    .sort((a, b) => a.month.localeCompare(b.month));
}
