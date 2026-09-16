import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCsv, detectLayout, rowsToTransactions, checkBalanceContinuity,
  parseNarration, cellToAmount, cellToDate,
} from '../src/statement.js';
import { SEED_NEEDLES, categorize } from '../src/categorize.js';
import { buildLedger, summarizeMonth } from '../src/normalize.js';
import { parseMessage } from '../src/parse.js';

/** A synthetic statement shaped like an ICICI export: preamble rows above the
 *  header, a Sr No column, two date columns, split withdrawal/deposit, balance. */
const ICICI_CSV = `
DETAILED STATEMENT

Account Number : 001234567890
Account Name : ACCOUNT HOLDER
Statement Period : 01/09/2025 to 30/09/2025

Sr No,Value Date,Transaction Date,Cheque Number,Transaction Remarks,Withdrawal Amount (INR ),Deposit Amount (INR ),Balance (INR )
1,01/09/2025,01/09/2025,,SAL/SEP2025/ACME TECHNOLOGIES PVT,,"92,000.00","146,120.55"
2,02/09/2025,02/09/2025,,MMT/IMPS/525112345678/Rent Sep/RAMESH KUMAR/HDFC,"24,000.00",,"122,120.55"
3,03/09/2025,03/09/2025,,UPI/307012345678/Payment from Ph/SWIGGY/YESB0YESBNK,318.00,,"121,802.55"
4,05/09/2025,05/09/2025,,VIN/AMAZON PAY IND/05092025/1234,"2,499.00",,"119,303.55"
5,08/09/2025,08/09/2025,,NFS/CASH WDL/08092025/ICICI ATM ANDHERI,"4,000.00",,"115,303.55"
6,10/09/2025,10/09/2025,,ACH/ZERODHA BROKING LTD/525112345678,"15,000.00",,"100,303.55"
,,,,This is a computer generated statement and needs no signature,,,
`.trim();

const layoutOf = csv => { const rows = parseCsv(csv); return { rows, layout: detectLayout(rows) }; };

test('finds the header under the preamble rows', () => {
  const { layout } = layoutOf(ICICI_CSV);
  assert.equal(layout.headerRow, 6);
  assert.equal(layout.confident, true);
});

test('maps every column to its role', () => {
  const { layout } = layoutOf(ICICI_CSV);
  assert.equal(layout.map.date, 2, 'transaction date is preferred over value date');
  assert.equal(layout.map.narration, 4);
  assert.equal(layout.map.debit, 5);
  assert.equal(layout.map.credit, 6);
  assert.equal(layout.map.balance, 7);
  assert.equal(layout.map.ref, 3);
  assert.equal(layout.map.amount, undefined, 'split debit/credit means no single amount column');
});

test('reads the rows and skips the footer', () => {
  const { rows, layout } = layoutOf(ICICI_CSV);
  const { txns, skipped } = rowsToTransactions(rows, layout, { knownMerchants: SEED_NEEDLES });
  assert.equal(txns.length, 6);
  assert.equal(skipped, 1, 'the computer-generated footer is not a transaction');
  assert.equal(txns[0].direction, 'credit');
  assert.equal(txns[0].amount, 92000);
  assert.equal(txns[1].direction, 'debit');
  assert.equal(txns[1].amount, 24000);
});

test('pulls the counterparty out of each narration style', () => {
  const { rows, layout } = layoutOf(ICICI_CSV);
  const { txns } = rowsToTransactions(rows, layout, { knownMerchants: SEED_NEEDLES });
  const names = txns.map(t => t.merchant);
  assert.match(names[0], /ACME TECHNOLOGIES/);
  assert.match(names[1], /Rent/i);
  assert.equal(names[2], 'SWIGGY');
  assert.match(names[3], /AMAZON/);
  assert.match(names[5], /ZERODHA/);
  assert.equal(txns[4].channel, 'atm');
});

test('a clean statement proves itself against its own running balance', () => {
  const { rows, layout } = layoutOf(ICICI_CSV);
  const { txns } = rowsToTransactions(rows, layout, { knownMerchants: SEED_NEEDLES });
  const check = checkBalanceContinuity(txns);
  assert.equal(check.available, true);
  assert.equal(check.ok, true, 'every row should reconcile');
  assert.equal(check.checked, 6);
});

test('a dropped row is caught by the balance check', () => {
  const { rows, layout } = layoutOf(ICICI_CSV);
  const { txns } = rowsToTransactions(rows, layout, { knownMerchants: SEED_NEEDLES });
  const missing = txns.filter((_, i) => i !== 3);        // lose the Amazon row
  const check = checkBalanceContinuity(missing);
  assert.equal(check.ok, false);
  assert.equal(check.breaks.length, 1);
  assert.equal(check.breaks[0].gap, -2499, 'the gap names exactly what went missing');
});

test('a wrong amount is caught by the balance check', () => {
  const { rows, layout } = layoutOf(ICICI_CSV);
  const { txns } = rowsToTransactions(rows, layout, { knownMerchants: SEED_NEEDLES });
  txns[2].amount = 3180;                                  // misread 318.00
  const check = checkBalanceContinuity(txns);
  assert.equal(check.ok, false);
  assert.equal(check.breaks[0].date, '2025-09-03');
});

test('statement rows categorize correctly end to end', () => {
  const { rows, layout } = layoutOf(ICICI_CSV);
  const { txns } = rowsToTransactions(rows, layout, { knownMerchants: SEED_NEEDLES });
  const led = buildLedger(txns);
  const s = summarizeMonth(led.txns, '2025-09');
  assert.equal(s.income, 92000);
  assert.equal(s.invested, 15000, 'the Zerodha mandate is investing, not spending');
  assert.equal(s.spend, 30817, 'rent + swiggy + amazon + atm');
  const cats = Object.fromEntries(s.byCategory.map(c => [c.key, c.amount]));
  assert.equal(cats['Rent & Housing'], 24000);
  assert.equal(cats['Food & Dining'], 318);
  assert.equal(cats['Cash'], 4000);
});

test('a statement row replaces the alert message for the same transaction', () => {
  const sms = parseMessage('ICICI Bank Acct XX7890 debited for Rs 318.00 on 03-Sep-25; SWIGGY credited. UPI:307012345678.');
  const { rows, layout } = layoutOf(ICICI_CSV);
  const { txns } = rowsToTransactions(rows, layout, { knownMerchants: SEED_NEEDLES });
  const led = buildLedger([{ ...sms, source: 'sms' }, ...txns]);
  const swiggy = led.txns.filter(t => /swiggy/i.test(t.merchant || ''));
  assert.equal(swiggy.length, 1, 'one payment, one row');
  assert.equal(swiggy[0].source, 'statement', 'the authoritative record wins');
  assert.equal(led.duplicates, 1);
});

test('a category the user fixed survives being replaced by a statement row', () => {
  const sms = { ...parseMessage('Rs.500.00 debited from A/c XX7890 to QWERTYSHOP on 04-09-25 Ref 999888777666'), source: 'sms' };
  const first = buildLedger([sms], { rules: { qwertyshop: 'Groceries' } });
  assert.equal(first.txns[0].categorySource, 'user');
  const stmt = { ...first.txns[0], source: 'statement', category: 'Other', categorySource: 'seed' };
  const merged = buildLedger([{ ...first.txns[0], kind: 'txn' }, { ...stmt, kind: 'txn' }], { rules: { qwertyshop: 'Groceries' } });
  assert.equal(merged.txns[0].category, 'Groceries');
});

// ---- cells ----

test('amount cells parse across the shapes statements use', () => {
  assert.equal(cellToAmount('"1,299.00"'.replace(/"/g, '')), 1299);
  assert.equal(cellToAmount('(1,299.00)'), 1299);
  assert.equal(cellToAmount('1299.00 Dr'), 1299);
  assert.equal(cellToAmount('₹ 1,45,000'), 145000);
  assert.equal(cellToAmount(''), null);
  assert.equal(cellToAmount('-'), null);
});

test('date cells parse from strings, Date objects and Excel serials', () => {
  assert.equal(cellToDate('04/09/2025'), '2025-09-04');
  assert.equal(cellToDate('04-Sep-2025'), '2025-09-04');
  assert.equal(cellToDate(new Date(Date.UTC(2025, 8, 4))), '2025-09-04');
  assert.equal(cellToDate(45904), '2025-09-04', 'Excel serial for 4 Sep 2025');
});

test('a UPI handle in the narration becomes the merchant', () => {
  const r = parseNarration('UPI/525112345678/Payment/zomato.payu@hdfcbank/HDFC BANK', SEED_NEEDLES);
  assert.equal(r.merchant, 'zomato.payu');
  assert.equal(r.channel, 'upi');
});

test('bank routing codes are never mistaken for the merchant', () => {
  const r = parseNarration('UPI/307012345678/Payment from Ph/SWIGGY/YESB0YESBNK', SEED_NEEDLES);
  assert.equal(r.merchant, 'SWIGGY');
});

test('a single signed amount column is read correctly', () => {
  const csv = 'Date,Description,Amount,Balance\n04/09/2025,AMAZON,-1299.00,50000.00\n05/09/2025,REFUND,499.00,50499.00';
  const rows = parseCsv(csv);
  const layout = detectLayout(rows);
  assert.equal(layout.map.amount, 2);
  const { txns } = rowsToTransactions(rows, layout, { knownMerchants: SEED_NEEDLES });
  assert.equal(txns[0].direction, 'debit');
  assert.equal(txns[0].amount, 1299);
  assert.equal(txns[1].direction, 'credit');
});

test('an unrecognisable sheet reports itself as not confident', () => {
  const rows = parseCsv('foo,bar,baz\n1,2,3');
  assert.equal(detectLayout(rows).confident, false);
});
