import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMessage, extractMoney, extractDate, splitMessages } from '../src/parse.js';

/** All messages here are synthetic, written to match real template shapes. */

test('HDFC UPI debit', () => {
  const r = parseMessage('Sent Rs.150.00 From HDFC Bank A/C x1234 To SWIGGY On 04/09/25 Ref 524712345678 Not You? Call 18002586161');
  assert.equal(r.kind, 'txn');
  assert.equal(r.amount, 150);
  assert.equal(r.direction, 'debit');
  assert.equal(r.date, '2025-09-04');
  assert.equal(r.merchant, 'SWIGGY');
  assert.equal(r.ref, '524712345678');
  assert.equal(r.issuerId, 'hdfc');
  assert.equal(r.account, '1234');
});

test('HDFC card spend keeps limit out of the amount', () => {
  const r = parseMessage('Spent Rs.1250.00 On HDFC Bank Card 4521 At AMAZON On 2025-09-11. Avl Lmt INR 1,45,000');
  assert.equal(r.amount, 1250);
  assert.equal(r.creditLimit, 145000);
  assert.equal(r.accountType, 'card');
  assert.equal(r.date, '2025-09-11');
  assert.equal(r.merchant, 'AMAZON');
});

test('HDFC debit keeps available balance out of the amount', () => {
  const r = parseMessage('Update! INR 2,500.00 debited from HDFC Bank XX1234 on 05-SEP-25. Info: UPI-SWIGGY. Avl bal:INR 45,231.10');
  assert.equal(r.amount, 2500);
  assert.equal(r.balance, 45231.10);
  assert.equal(r.date, '2025-09-05');
  assert.equal(r.merchant, 'SWIGGY');
});

test('ICICI debit: beneficiary credited must not flip the direction', () => {
  const r = parseMessage('ICICI Bank Acct XX123 debited for Rs 500.00 on 04-Sep-25; SWIGGY credited. UPI:524712345678.');
  assert.equal(r.direction, 'debit', 'the a/c was debited even though the payee was credited');
  assert.equal(r.amount, 500);
  assert.equal(r.issuerId, 'icici');
});

test('Amazon Pay ICICI card wins over plain ICICI', () => {
  const r = parseMessage('INR 1,299.00 spent using Amazon Pay ICICI Bank Card XX4521 on 11-Sep-25 on AMAZON. Avl Lmt: INR 1,45,000');
  assert.equal(r.issuerId, 'amazonpay');
  assert.equal(r.amount, 1299);
  assert.equal(r.accountType, 'card');
});

test('SBI ATM withdrawal', () => {
  const r = parseMessage('Dear Customer, Rs.2000.00 withdrawn at SBI ATM S1AB1234 from A/c X1234 on 04Sep25 Txn# 1234567. Avl Bal Rs 45231.10');
  assert.equal(r.amount, 2000);
  assert.equal(r.direction, 'debit');
  assert.equal(r.channel, 'atm');
  assert.equal(r.balance, 45231.10);
  assert.equal(r.date, '2025-09-04');
});

test('SBI one-decimal amount', () => {
  const r = parseMessage('Dear SBI User, your A/c X1234-debited by Rs.500.0 on 04Sep25 transfer to SWIGGY Ref No 524712345678 -SBI');
  assert.equal(r.amount, 500);
  assert.equal(r.merchant, 'SWIGGY');
});

test('Axis structured UPI info block', () => {
  const r = parseMessage('INR 500.00 debited A/c no. XX1234 04-09-25, 12:30:45 IST UPI/P2M/524712345678/SWIGGY. Not you? SMS BLOCK 1234 to 918691000002 -Axis Bank');
  assert.equal(r.amount, 500);
  assert.equal(r.merchant, 'SWIGGY');
  assert.equal(r.issuerId, 'axis');
});

test('Kotak UPI handle becomes the merchant', () => {
  const r = parseMessage('Sent Rs.500.00 from Kotak Bank AC X1234 to swiggy@ybl on 04-09-25. UPI Ref 524712345678.');
  assert.equal(r.merchant, 'swiggy');
  assert.equal(r.channel, 'upi');
  assert.equal(r.issuerId, 'kotak');
});

test('AU Small Finance credit card', () => {
  const r = parseMessage('Your AU Bank Credit Card xx4521 is used for INR 1,299.00 at AMAZON on 11-09-2025. Avl Limit INR 1,45,000');
  assert.equal(r.issuerId, 'au');
  assert.equal(r.amount, 1299);
  assert.equal(r.creditLimit, 145000);
  assert.equal(r.direction, 'debit');
});

test('CSB debit', () => {
  const r = parseMessage('Your CSB Bank A/c XX1234 debited INR 500.00 on 04-09-25. Avl Bal INR 45231.10');
  assert.equal(r.issuerId, 'csb');
  assert.equal(r.amount, 500);
});

test('salary credit', () => {
  const r = parseMessage('Dear Customer, Acct XX1234 is credited with Rs 50,000.00 on 01-Sep-25 from SALARY.');
  assert.equal(r.direction, 'credit');
  assert.equal(r.amount, 50000);
  assert.equal(r.merchant, 'SALARY');
});

test('refund is a credit even though "debited" appears first', () => {
  const r = parseMessage('The amount of Rs.499.00 debited on 04-09-25 has been reversed and credited to your A/c XX1234');
  assert.equal(r.direction, 'credit');
});

test('sender ID identifies the bank when the body does not', () => {
  const r = parseMessage('Rs.500.00 debited from A/c XX1234 on 04-09-25 to SWIGGY', { sender: 'AD-HDFCBK' });
  assert.equal(r.issuerId, 'hdfc');
});

test('missing date falls back to the SMS receipt timestamp', () => {
  const r = parseMessage('Rs.500.00 debited from A/c XX1234 to SWIGGY', { receivedAt: '2025-09-04T10:30:00Z' });
  assert.equal(r.date, '2025-09-04');
});

// ---- noise: the inbox is mostly not transactions ----

test('OTP is not a transaction', () => {
  const r = parseMessage('123456 is your OTP for a transaction of Rs.5000.00 on your HDFC Bank Card. Do not share this OTP.');
  assert.equal(r.kind, 'noise');
  assert.equal(r.reason, 'otp');
});

test('autopay pre-debit notice is not a transaction yet', () => {
  const r = parseMessage('Rs.499.00 will be debited from your A/c XX1234 on 15-09-25 towards NETFLIX autopay.');
  assert.equal(r.kind, 'noise');
  assert.equal(r.reason, 'upcoming');
});

test('failed transaction is not spend', () => {
  const r = parseMessage('Your transaction of Rs.2500.00 on Card XX4521 at AMAZON has failed.');
  assert.equal(r.kind, 'noise');
  assert.equal(r.reason, 'failed');
});

test('credit card statement is not a transaction', () => {
  const r = parseMessage('Your AU Bank Credit Card statement is generated. Total Amt Due Rs 12,500.00, Min Amt Due Rs 625.00, due on 20-09-25.');
  assert.equal(r.kind, 'noise');
});

test('promo is not a transaction', () => {
  const r = parseMessage('Congratulations! You are eligible for a pre-approved loan of Rs.5,00,000. Apply now. T&C apply.');
  assert.equal(r.kind, 'noise');
  assert.equal(r.reason, 'promo');
});

test('collect request is not a transaction', () => {
  const r = parseMessage('rahul@okaxis has requested Rs.500.00 from you. Pay via PhonePe.');
  assert.equal(r.kind, 'noise');
  assert.equal(r.reason, 'request');
});

test('balance enquiry has no direction so it is not a transaction', () => {
  const r = parseMessage('Avl Bal in your A/c XX1234 is Rs.45,231.10 as on 04-09-25.');
  assert.equal(r.kind, 'noise');
});

// ---- units ----

test('lakh-grouped amounts parse correctly', () => {
  assert.equal(extractMoney('Rs.1,45,000.50 debited').amount, 145000.50);
});

test('day-first dates are never read month-first', () => {
  assert.equal(extractDate('on 04-09-25'), '2025-09-04');
  assert.equal(extractDate('on 11/09/2025'), '2025-09-11');
});

test('impossible dates are rejected', () => {
  assert.equal(extractDate('on 31-02-25'), null);
});

test('splits pasted blocks on blank lines and on single lines', () => {
  assert.equal(splitMessages('msg one\n\nmsg two\n\nmsg three').length, 3);
  assert.equal(splitMessages('msg one\nmsg two\nmsg three').length, 3);
});

test('ICICI card names the payee after the date, not the date', () => {
  const r = parseMessage('INR 1,299.00 spent using ICICI Bank Card XX4521 on 11-Sep-25 on AMAZON. Avl Lmt: INR 1,45,000');
  assert.equal(r.merchant, 'AMAZON');
  assert.equal(r.date, '2025-09-11');
});

test('Amazon Pay ICICI card names the payee', () => {
  const r = parseMessage('INR 1,180.00 spent using Amazon Pay ICICI Bank Card XX8802 on 09-09-25 on ZOMATO.');
  assert.equal(r.merchant, 'ZOMATO');
  assert.equal(r.issuerId, 'amazonpay');
});

test('an ATM withdrawal is labelled, not left unknown', () => {
  const r = parseMessage('Dear Customer, Rs.2000.00 withdrawn at SBI ATM S1AB1234 from A/c X1234 on 04Sep25. Avl Bal Rs 45231.10');
  assert.equal(r.merchant, 'Cash withdrawal');
  assert.equal(r.channel, 'atm');
});
