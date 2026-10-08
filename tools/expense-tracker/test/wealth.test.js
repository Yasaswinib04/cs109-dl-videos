import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveBankBalances, investedFromLedger, summarizeWealth, takeSnapshot, snapshotSeries } from '../src/wealth.js';

const row = (o) => ({ direction: 'debit', accountType: 'bank', ...o });

test('a bank balance is read from the latest statement row, never typed', () => {
  const b = deriveBankBalances([
    row({ issuer: 'ICICI Bank', account: '9919', date: '2026-09-19', balance: 50000 }),
    row({ issuer: 'ICICI Bank', account: '9919', date: '2026-09-21', balance: 10186.69 }),
    row({ issuer: 'ICICI Bank', account: '9919', date: '2026-09-20', balance: 30000 }),
  ]);
  assert.equal(b.length, 1);
  assert.equal(b[0].value, 10186.69, 'the newest date wins');
  assert.equal(b[0].derived, true);
  assert.equal(b[0].name, 'ICICI Bank ••9919');
});

test('same-day rows out of order still resolve to the last one listed', () => {
  // Banks do not always list same-day rows in balance order; file position breaks the tie.
  const b = deriveBankBalances([
    row({ issuer: 'ICICI Bank', account: '9919', date: '2026-09-21', balance: 99999 }),
    row({ issuer: 'ICICI Bank', account: '9919', date: '2026-09-21', balance: 10186.69 }),
  ]);
  assert.equal(b[0].value, 10186.69);
});

test('a credit card balance is not counted as a bank asset', () => {
  const b = deriveBankBalances([
    row({ issuer: 'Amazon Pay ICICI', account: '9003', date: '2026-09-12', balance: 26368.8, accountType: 'card' }),
  ]);
  assert.equal(b.length, 0, 'a card balance is money owed, not money held');
});

test('several accounts each get their own row', () => {
  const b = deriveBankBalances([
    row({ issuer: 'ICICI Bank', account: '9919', date: '2026-09-21', balance: 10186.69 }),
    row({ issuer: 'Federal Bank', account: '6591', date: '2026-09-20', balance: 42000 }),
  ]);
  assert.equal(b.length, 2);
  assert.equal(b[0].name, 'Federal Bank ••6591', 'sorted by size');
});

test('net worth is assets minus debts', () => {
  const s = summarizeWealth(
    [{ name: 'ICICI', kind: 'Bank', value: 10186.69, derived: true }],
    [
      { name: 'Groww', kind: 'Investment', value: 1100000, cost: 921072 },
      { name: 'Amazon Pay ICICI', kind: 'Credit card', value: 26368.8 },
      { name: 'Jupiter', kind: 'Credit card', value: 15000 },
    ],
  );
  assert.equal(s.assets, 1110186.69);
  assert.equal(s.debts, 41368.8);
  assert.equal(s.netWorth, 1068817.89);
});

test('a debt entered as a negative number still counts as a debt', () => {
  const s = summarizeWealth([], [{ name: 'Card', kind: 'Credit card', value: -5000 }]);
  assert.equal(s.debts, 5000);
  assert.equal(s.netWorth, -5000);
});

test('gain is only computed where a cost basis exists', () => {
  const withCost = summarizeWealth([], [{ name: 'Groww', kind: 'Investment', value: 1100000, cost: 921072 }]);
  assert.equal(withCost.gain, 178928);
  assert.equal(withCost.gainPct, 19.4);

  const noCost = summarizeWealth([], [{ name: 'Groww', kind: 'Investment', value: 1100000 }]);
  assert.equal(noCost.gain, null, 'no cost basis means no honest gain figure');
});

test('cost basis comes from transactions already categorized as Investment', () => {
  const r = investedFromLedger([
    { direction: 'debit', category: 'Investment', amount: 15000 },
    { direction: 'debit', category: 'Investment', amount: 6499 },
    { direction: 'credit', category: 'Investment', amount: 2000 },
    { direction: 'debit', category: 'Groceries', amount: 500 },
    { direction: 'debit', category: 'Investment', amount: 9999, netted: true },
  ]);
  assert.equal(r.paidIn, 21499);
  assert.equal(r.takenOut, 2000);
  assert.equal(r.net, 19499, 'a reversed investment does not count');
});

test('typed figures that have gone stale are flagged', () => {
  const old = new Date(Date.now() - 120 * 864e5).toISOString().slice(0, 10);
  const s = summarizeWealth([], [
    { name: 'Groww', kind: 'Investment', value: 100, asOf: old },
    { name: 'Fresh', kind: 'Investment', value: 100, asOf: new Date().toISOString().slice(0, 10) },
  ]);
  assert.deepEqual(s.staleRows.map(r => r.name), ['Groww']);
});

test('snapshots build a trend in date order', () => {
  let snaps = {};
  snaps = takeSnapshot(snaps, { netWorth: 100, assets: 120, debts: 20 }, '2026-08');
  snaps = takeSnapshot(snaps, { netWorth: 150, assets: 170, debts: 20 }, '2026-09');
  snaps = takeSnapshot(snaps, { netWorth: 160, assets: 180, debts: 20 }, '2026-09');  // re-taken
  const series = snapshotSeries(snaps);
  assert.deepEqual(series.map(s => s.month), ['2026-08', '2026-09']);
  assert.equal(series[1].netWorth, 160, 're-taking a month replaces it');
});
