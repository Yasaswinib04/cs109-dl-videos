# Passbook

A monthly expense tracker built from bank, card and UPI alert messages. Paste the
messages (or drop in an SMS backup file), and it produces a categorized ledger,
a month view, and month-over-month trends.

Tuned for Indian alert formats: HDFC, ICICI (including Amazon Pay ICICI), SBI,
Axis, Kotak, AU Small Finance, Federal/Jupiter, CSB, and UPI apps — with a
generic fallback for templates not listed here.

## Why it parses the way it does

Banks change their SMS templates constantly, and the same bank words UPI, card
and NEFT alerts differently. Rather than one full-line regex per bank per
channel, `src/parse.js` extracts each **field** independently — amount, date,
direction, counterparty, account tail, reference — and scores the result. A
template tweak costs one field, not the whole transaction.

Three things quietly ruin a message-based tracker. Each is handled explicitly and
has tests:

| Problem | Handling |
|---|---|
| Re-pasting an overlapping batch double-counts everything | `dedupe()` keys on the bank reference number, falling back to date + amount + account + merchant |
| A failed UPI payment is debited, then reversed days later | `netReversals()` pairs them and drops both from totals |
| Paying a credit card bill looks like fresh spend on top of the card purchases already counted | `Transfers` and `Investments` are outflow but never `spend` |

A bank inbox is also mostly *not* transactions. OTPs, promos, autopay pre-debit
notices, failed payments, collect requests and statement reminders are classified
as noise and excluded — but counted, so you can see what was skipped.

Anything parsed with low confidence goes to a **review queue** rather than being
dropped. A missed transaction is worse than a wrong one, because you cannot see
what is not there.

## Layout

```
src/parse.js       field extractors + issuer/noise rules  -> one message to one record
src/categorize.js  merchant -> category, plus learned user overrides
src/normalize.js   dedupe, reversals, month aggregation, recurring detection
src/ui.js          the interface
src/page.html      markup, design tokens, and the bundle placeholder
build.mjs          inlines the modules into dist/tracker.html (artifacts are one file)
test/              42 tests over the parser and the ledger
```

The modules are the single source of truth: node runs them directly for tests,
and `build.mjs` flattens them into the published page.

## Use

```sh
npm test     # 42 tests, no dependencies
npm run build # -> dist/tracker.html, a self-contained page
```

`dist/tracker.html` opens standalone in any browser (storing data in that
browser). Published as an Artifact it stores data with the page instead, so it
persists across devices.

## Getting messages off an Android phone

1. Install **SMS Backup & Restore** from the Play Store.
2. *Set up a backup* → Messages on, Call logs off.
3. Back up locally, then share the `sms-….xml` file to yourself.
4. Load that file in the tracker. Only received messages are read, and only ones
   that look like transactions are kept.

Google Takeout does not include SMS, and `adb backup` no longer works on current
Android — the backup app is the practical route.

## Adding a bank

Add an entry to `ISSUERS` in `src/parse.js` (body pattern + SMS sender-ID
pattern). If the template phrases the counterparty unusually, add one entry to
`MERCHANT_PATTERNS`. Write the failing test first — every format in the suite is
a synthetic message shaped like the real thing, and no real transaction data is
committed to this repo.
