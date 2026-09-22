# Passbook

A monthly expense tracker built from bank, card and UPI alert messages. Paste the
messages (or drop in an SMS backup file), and it produces a categorized ledger,
a month view, and month-over-month trends.

Statement narrations are parsed positionally where the bank uses a fixed shape.
ICICI writes every UPI line as `UPI / payee / vpa / note / payee's bank / RRN /
ref`, with each field truncated — so the fifth field must never be read as a
merchant (or a third of the ledger becomes "YES BANK L"), and the best name may
be in any of the first four.

Tuned for Indian alert formats: HDFC, ICICI (including Amazon Pay ICICI), SBI,
Axis, Kotak, AU Small Finance, Federal/Jupiter, CSB, and UPI apps — with a
generic fallback for templates not listed here.

## Two sources, one ledger

**Statements are the spine.** A bank or card statement (CSV/Excel) is complete,
authoritative, and carries a running balance — which lets the import *prove*
itself. `checkBalanceContinuity()` asks two different questions of it:

- **Net** — does the opening balance, plus every credit, minus every debit, land
  exactly on the closing balance? Order-independent, so it is the real test of
  completeness; it fails only if a row is missing, duplicated or misread.
- **Per row** — does each row follow from the one above? Good for locating a
  problem, but banks list same-day transactions in an order that does not always
  match the balance sequence, so a per-row failure with a clean net result means
  the rows are merely out of order — normal, and reported as such.

Separating the two is the difference between "your export dropped something" and
"your bank sorted two rows differently". No message-based import can offer either.

Statement layouts differ per bank and bury the real header under preamble rows,
so nothing is hard-coded: `detectLayout()` scores candidate header rows, maps
columns by name, and reports when it is not confident, so the mapping can be
corrected before anything is imported.

**Alert messages fill the gaps** for accounts you have not pulled a statement
for. When both sources describe the same payment, the statement wins — see
`dedupe()`, which matches across sources on the bank reference OR on
date + amount + account, because one source may know a reference the other does
not. A category you corrected by hand survives the replacement.

## The long tail nothing can name

Roughly half the rows in a real statement are payments to a person's own UPI
handle with no note — a ride paid straight to the driver, the shop on the
corner. No rule table reaches those, and a learned rule is useless for rides
because the payee is a different driver every time. (By value it is far less
alarming than by count: in the statement this was built against, 51% of rows but
15% of value.)

What *is* learnable is the shape, so `suggestCategories()` surfaces two patterns
with their evidence attached:

- **Paid once, small amount** → likely a ride. The amount band is derived from
  the user's own labelled Rapido/Uber transactions rather than a number picked in
  advance, so it fits how they actually travel.
- **Paid several times** → somewhere they go back to, so one decision settles
  every row for that payee, and the rule sticks.

These are proposals, never silent assignments. A wrong category nobody watched
being applied is worse than an honest "Miscellaneous", because it corrupts the
totals invisibly.

## One brand, one name

A single statement spells one merchant many ways — Zepto alone appears as
`ZEPTO MARK`, `zeptomarketpla`, `zeptonow.bdpg1`, `zptmktp1` and `cf.zepto12`.
`canonicalMerchant()` collapses them before dedupe, which is what makes a
merchant total, a detected subscription, or a "you spent X on Y" figure mean
anything.

Matching needles is boundary-aware for the same reason it has to be: `vi` (the
telecom operator) would otherwise match "paid **vi**a card", and `aws` would
match "l**aws**uit". A needle authored with a trailing space (`'vi '`, `'sip '`)
must end at a word boundary too.

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
src/statement.js   statement layout detection, narration parsing, balance proof
src/parse.js       field extractors + issuer/noise rules  -> one message to one record
src/categorize.js  merchant -> category, plus learned user overrides
src/normalize.js   dedupe, reversals, month aggregation, recurring detection
src/ui.js          the interface
src/page.html      markup, design tokens, and the bundle placeholder
build.mjs          inlines the modules into dist/tracker.html (artifacts are one file)
test/              67 tests over the parsers, the ledger and the balance check
```

The modules are the single source of truth: node runs them directly for tests,
and `build.mjs` flattens them into the published page.

## Use

```sh
npm test     # 67 tests, no dependencies
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
