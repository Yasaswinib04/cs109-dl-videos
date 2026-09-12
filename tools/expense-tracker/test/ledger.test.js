import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMessage, splitMessages } from '../src/parse.js';
import { buildLedger, summarizeMonth, detectRecurring, dedupeKey } from '../src/normalize.js';

const parseAll = msgs => msgs.map(m => parseMessage(m));

test('re-pasting an overlapping batch does not double-count', () => {
  const msg = 'Sent Rs.150.00 From HDFC Bank A/C x1234 To SWIGGY On 04/09/25 Ref 524712345678';
  const led = buildLedger(parseAll([msg, msg, msg]));
  assert.equal(led.txns.length, 1);
  assert.equal(led.duplicates, 2);
});

test('same amount to same merchant on different days are separate transactions', () => {
  const led = buildLedger(parseAll([
    'Sent Rs.150.00 From HDFC Bank A/C x1234 To SWIGGY On 04/09/25',
    'Sent Rs.150.00 From HDFC Bank A/C x1234 To SWIGGY On 05/09/25',
  ]));
  assert.equal(led.txns.length, 2, 'coffee twice is two transactions, not a duplicate');
});

test('a failed-and-reversed payment nets out of the month', () => {
  const led = buildLedger(parseAll([
    'Rs.2500.00 debited from HDFC Bank A/C x1234 to AMAZON on 04-09-25 Ref 111111111111',
    'The amount of Rs.2500.00 has been reversed and credited to your A/c XX1234 on 06-09-25 Ref 222222222222',
  ]));
  const s = summarizeMonth(led.txns, '2025-09');
  assert.equal(s.spend, 0, 'reversed spend must not appear as spend');
  assert.equal(s.income, 0, 'a reversal is not income');
});

test('paying the credit card bill is a transfer, not new spend', () => {
  const led = buildLedger(parseAll([
    'Spent Rs.1250.00 On HDFC Bank Card 4521 At AMAZON On 2025-09-11. Avl Lmt INR 1,45,000',
    'Rs.1250.00 debited from HDFC Bank A/C x1234 to CRED on 20-09-25 Ref 333333333333',
  ]));
  const s = summarizeMonth(led.txns, '2025-09');
  assert.equal(s.spend, 1250, 'the purchase counts once; settling the bill is not a second purchase');
  assert.equal(s.transfers, 1250);
});

test('investments are outflow but not spend', () => {
  const led = buildLedger(parseAll([
    'Rs.50,000.00 credited to A/c XX1234 on 01-09-25 from SALARY',
    'Rs.10,000.00 debited from A/c XX1234 to ZERODHA on 05-09-25 Ref 444444444444',
    'Sent Rs.150.00 From HDFC Bank A/C x1234 To SWIGGY On 04/09/25 Ref 555555555555',
  ]));
  const s = summarizeMonth(led.txns, '2025-09');
  assert.equal(s.income, 50000);
  assert.equal(s.spend, 150, 'buying mutual funds is saving, not spending');
  assert.equal(s.invested, 10000);
  assert.equal(s.net, 39850);
  assert.equal(s.savingsRate, 99.7);
});

test('category breakdown sums to total spend', () => {
  const led = buildLedger(parseAll([
    'Sent Rs.150.00 From HDFC Bank A/C x1234 To SWIGGY On 04/09/25 Ref 1111111111',
    'Sent Rs.850.00 From HDFC Bank A/C x1234 To BLINKIT On 05/09/25 Ref 2222222222',
    'Spent Rs.1250.00 On HDFC Bank Card 4521 At AMAZON On 2025-09-11. Avl Lmt INR 1,45,000',
  ]));
  const s = summarizeMonth(led.txns, '2025-09');
  const total = s.byCategory.reduce((a, c) => a + c.amount, 0);
  assert.equal(total, s.spend);
  assert.equal(s.spend, 2250);
  assert.equal(s.byCategory[0].key, 'Shopping');
});

test('low-confidence rows go to review instead of being dropped', () => {
  const led = buildLedger([parseMessage('Rs.32000.00 debited')]);
  assert.equal(led.txns.length, 0);
  assert.equal(led.review.length, 1, 'a large unparsed debit must surface, never vanish');
  assert.equal(led.review[0].amount, 32000);
});

test('subscriptions surface across months', () => {
  const msgs = ['07', '08', '09'].map(mm =>
    `Rs.649.00 debited from HDFC Bank A/C x1234 to NETFLIX on 15-${mm}-25 Ref 9${mm}9999999`);
  const led = buildLedger(parseAll(msgs));
  const rec = detectRecurring(led.txns);
  assert.equal(rec.length, 1);
  assert.equal(rec[0].merchant, 'NETFLIX');
  assert.equal(rec[0].annualized, 7788);
});

test('one-off purchases are not reported as subscriptions', () => {
  const led = buildLedger(parseAll([
    'Rs.649.00 debited from A/C x1234 to NETFLIX on 15-07-25 Ref 111111111',
    'Rs.1299.00 debited from A/C x1234 to AMAZON on 16-08-25 Ref 222222222',
  ]));
  assert.equal(detectRecurring(led.txns).length, 0);
});

test('user category corrections override the seed rules', () => {
  const rules = { 'qwertyshop': 'Groceries' };
  const led = buildLedger(parseAll(['Rs.500.00 debited from A/C x1234 to QWERTYSHOP on 04-09-25 Ref 777777777']), { rules });
  assert.equal(led.txns[0].category, 'Groceries');
  assert.equal(led.txns[0].categorySource, 'user');
});

test('noise is counted but kept out of the ledger', () => {
  const led = buildLedger(parseAll([
    '123456 is your OTP. Do not share this OTP with anyone.',
    'Sent Rs.150.00 From HDFC Bank A/C x1234 To SWIGGY On 04/09/25 Ref 888888888',
  ]));
  assert.equal(led.txns.length, 1);
  assert.equal(led.noise.length, 1);
});

test('a reference number identifies a transaction across differing templates', () => {
  const a = parseMessage('Sent Rs.150.00 From HDFC Bank A/C x1234 To SWIGGY On 04/09/25 Ref 524712345678');
  const b = parseMessage('INR 150.00 debited from HDFC Bank XX1234 on 04-09-25. Info: UPI-SWIGGY. UPI Ref 524712345678');
  assert.equal(dedupeKey(a), dedupeKey(b), 'same payment alerted twice must collapse to one row');
});

test('end-to-end: a pasted blob becomes a month summary', () => {
  const blob = `
Rs.50,000.00 credited to A/c XX1234 on 01-09-25 from SALARY

Sent Rs.150.00 From HDFC Bank A/C x1234 To SWIGGY On 04/09/25 Ref 524712345678

123456 is your OTP for a transaction. Do not share this OTP.

Spent Rs.1250.00 On HDFC Bank Card 4521 At AMAZON On 2025-09-11. Avl Lmt INR 1,45,000
`;
  const led = buildLedger(splitMessages(blob).map(m => parseMessage(m)));
  const s = summarizeMonth(led.txns, '2025-09');
  assert.equal(s.income, 50000);
  assert.equal(s.spend, 1400);
  assert.equal(s.txnCount, 3);
  assert.equal(led.noise.length, 1);
});
