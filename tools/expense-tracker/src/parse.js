/**
 * parse.js - turn one raw bank / card / UPI alert message into a structured record.
 *
 * Design note: Indian banks change their SMS templates constantly, and the same
 * bank uses different wording for UPI vs card vs NEFT. So instead of one full-line
 * regex per bank per channel (dozens of brittle rules), this extracts each FIELD
 * independently and scores the result. A template tweak costs us one field, not
 * the whole transaction.
 */

// ---------------------------------------------------------------- issuers

// Matched against message body AND against the SMS sender ID (e.g. "AD-HDFCBK").
export const ISSUERS = [
  { id: 'hdfc',    name: 'HDFC Bank',        body: /\bhdfc\b/i,                          sender: /HDFCBK|HDFCBN/i },
  { id: 'icici',   name: 'ICICI Bank',       body: /\bicici\b/i,                         sender: /ICICIB|ICICIT|ICICIP/i },
  { id: 'sbi',     name: 'SBI',              body: /\bsbi\b|\bstate bank\b/i,            sender: /SBIINB|SBICRD|SBIUPI|ATMSBI|SBIPSG/i },
  { id: 'axis',    name: 'Axis Bank',        body: /\baxis\b/i,                          sender: /AXISBK|AXISBN/i },
  { id: 'kotak',   name: 'Kotak',            body: /\bkotak\b/i,                         sender: /KOTAKB|KOTAKM/i },
  { id: 'au',      name: 'AU Small Finance', body: /\bau (bank|small finance)\b/i,       sender: /AUBANK|AUSFBL/i },
  { id: 'jupiter', name: 'Jupiter',          body: /\bjupiter\b/i,                       sender: /JUPITR|JUPITE/i },
  { id: 'csb',     name: 'CSB Bank',         body: /\bcsb\b/i,                           sender: /CSBBNK|CSBANK/i },
  { id: 'federal', name: 'Federal Bank',     body: /\bfederal\b/i,                       sender: /FEDBNK|FEDERL/i },
  { id: 'paytm',   name: 'Paytm',            body: /\bpaytm\b/i,                         sender: /PAYTMB|PYTMPB/i },
  { id: 'phonepe', name: 'PhonePe',          body: /\bphonepe\b/i,                       sender: /PHONPE|PHNPE/i },
  { id: 'gpay',    name: 'Google Pay',       body: /\bgoogle pay\b|\bg-?pay\b/i,         sender: /GOOGPY|GPAYIN/i },
  { id: 'amazonpay', name: 'Amazon Pay ICICI', body: /amazon pay icici/i,                sender: /AMZNPY/i },
];

export function detectIssuer(text, sender) {
  // Co-branded cards must win over the underlying bank, so check those first.
  const ordered = [...ISSUERS].sort((a, b) => (a.id === 'amazonpay' ? -1 : b.id === 'amazonpay' ? 1 : 0));
  for (const iss of ordered) {
    if (sender && iss.sender.test(sender)) return iss;
  }
  for (const iss of ordered) {
    if (iss.body.test(text)) return iss;
  }
  return null;
}

// ---------------------------------------------------------------- noise

/**
 * A bank SMS inbox is mostly not transactions. These are checked in order and the
 * first hit wins, because a promo about a loan also contains the word "debited".
 */
const NOISE_RULES = [
  { reason: 'otp',       re: /\b(otp|one[- ]time password|verification code)\b|do not share .{0,20}(otp|pin|cvv)/i },
  { reason: 'upcoming',  re: /\bwill be (debited|deducted|charged|auto[- ]?debited)\b|\bis due\b|\bdue on\b|\bdue date\b|\bpre[- ]?debit notification\b/i },
  { reason: 'failed',    re: /\b(has failed|was declined|is declined|unsuccessful|could not be processed|transaction failed)\b/i },
  { reason: 'request',   re: /\b(has requested|collect request|payment request|requesting money)\b/i },
  { reason: 'mandate',   re: /\b(e-?mandate|upi mandate|autopay (has been )?(set ?up|created|enabled))\b/i },
  { reason: 'statement', re: /\b(statement|min(imum)? amt due|total amt due|min(imum)? amount due|total amount due|bill generated)\b/i },
  { reason: 'promo',     re: /\b(pre[- ]?approved|apply now|click here|t&c apply|offer|cashback up ?to|% ?off|download the app|congratulations|eligible for)\b/i },
];

// ---------------------------------------------------------------- amounts

// Matches "Rs.1,299.00", "INR 1299", "₹1,45,000", and the trailing "1299 INR" form.
const MONEY_RE = /(?:(?:rs|inr|₹)\s*\.?\s*)([0-9][0-9,]*(?:\.[0-9]{1,2})?)|([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*(?:rs\b|inr\b|₹)/gi;

/** What is this particular money figure? The txn amount, or the balance/limit trailer? */
function classifyMoney(before) {
  if (/\b(avl|available|closing|a\/c|acct)?\s*(bal|balance)\s*[:\-.]?\s*$/i.test(before)) return 'balance';
  if (/\b(avl|available|credit|total)?\s*(lmt|limit)\s*[:\-.]?\s*$/i.test(before)) return 'limit';
  if (/\bdue\s*[:\-.]?\s*$/i.test(before)) return 'due';
  return 'amount';
}

export function extractMoney(text) {
  const found = { amount: null, balance: null, limit: null, due: null };
  MONEY_RE.lastIndex = 0;
  let m;
  while ((m = MONEY_RE.exec(text)) !== null) {
    const value = Number((m[1] || m[2]).replace(/,/g, ''));
    if (!Number.isFinite(value)) continue;
    const kind = classifyMoney(text.slice(Math.max(0, m.index - 32), m.index));
    // First figure of each kind wins; later mentions are usually restatements.
    if (found[kind] === null) found[kind] = value;
  }
  return found;
}

// ---------------------------------------------------------------- dates

const MONTHS = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, sept:9, oct:10, nov:11, dec:12 };

function buildDate(y, mo, d) {
  if (!(mo >= 1 && mo <= 12) || !(d >= 1 && d <= 31)) return null;
  if (y < 100) y += 2000;
  if (y < 2000 || y > 2100) return null;
  const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  // Reject impossible days (31 Feb) by round-tripping through Date.
  const dt = new Date(iso + 'T00:00:00Z');
  if (dt.getUTCDate() !== d || dt.getUTCMonth() + 1 !== mo) return null;
  return iso;
}

/**
 * Indian alerts are day-first. "04-09-25" is 4 September, never 9 April, so we
 * never guess month-first - guessing would silently scatter spend across months.
 */
export function extractDate(text) {
  let m;
  // ISO: 2025-09-11 (HDFC card alerts use this, sometimes with :HH:MM:SS appended)
  if ((m = /\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/.exec(text))) {
    const d = buildDate(+m[1], +m[2], +m[3]);
    if (d) return d;
  }
  // Alpha month: 04-Sep-25, 04 Sep 2025, 04Sep25
  const alphaRe = /\b(\d{1,2})[-\/ ]?([A-Za-z]{3,4})[-\/ ]?(\d{2,4})\b/g;
  while ((m = alphaRe.exec(text)) !== null) {
    const mo = MONTHS[m[2].toLowerCase()];
    if (!mo) continue;
    const d = buildDate(+m[3], mo, +m[1]);
    if (d) return d;
  }
  // Numeric day-first: 04-09-25, 04/09/2025, 04.09.25
  const numRe = /\b(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})\b/g;
  while ((m = numRe.exec(text)) !== null) {
    const d = buildDate(+m[3], +m[2], +m[1]);
    if (d) return d;
  }
  return null;
}

// ---------------------------------------------------------------- direction

const DEBIT_WORDS  = /\b(debited|debit|spent|sent|paid|withdrawn|withdrawal|purchase[d]?|deducted|transferred to|used for|used at|charged)\b/i;
// Note: bare "credit" is deliberately absent - "Credit Card" appears in every
// card spend alert and would flip every card purchase into income.
const CREDIT_WORDS = /\b(credited|credit of|received|deposited|refund(ed)?|revers(ed|al)|cashback)\b/i;
// Money coming back is unambiguous no matter what else the sentence says.
const CREDIT_OVERRIDE = /\b(refund(ed)?|revers(ed|al)|cashback)\b/i;

export function extractDirection(text) {
  if (CREDIT_OVERRIDE.test(text)) return 'credit';
  const d = DEBIT_WORDS.exec(text);
  const c = CREDIT_WORDS.exec(text);
  if (d && c) return d.index <= c.index ? 'debit' : 'credit';
  if (d) return 'debit';
  if (c) return 'credit';
  return null;
}

// ---------------------------------------------------------------- account

/**
 * Last 3-6 digits of the account or card. This is how we group spend per card,
 * and it is also the only account detail the tracker ever needs.
 */
export function extractAccount(text) {
  const isCard = /\bcard\b|\bavl\s*(lmt|limit)\b|\bcredit card\b/i.test(text);
  const m = /\b(a\/c|ac|acct|account|card)\s*(?:no\.?|number)?\s*[:#-]?\s*[xX*]*\s*(\d{3,6})\b/i.exec(text);
  return {
    tail: m ? m[2] : null,
    type: isCard ? 'card' : 'bank',
  };
}

// ---------------------------------------------------------------- counterparty

const MERCHANT_PATTERNS = [
  // UPI handle: swiggy@ybl -> "swiggy"
  { re: /\b([a-zA-Z0-9][a-zA-Z0-9._-]{1,})@([a-z]{2,})\b/, pick: m => m[1] },
  // Axis / SBI style structured info blocks: UPI/P2M/524712345678/SWIGGY
  { re: /\bUPI[\/-](?:P2M|P2A)?[\/-]?\d*[\/-]([^\/.\s][^\/.]{1,40})/i, pick: m => m[1] },
  // "Info: UPI-SWIGGY" / "Info:NEFT-RENT"
  { re: /\bInfo\s*[:\-]\s*(?:UPI|NEFT|IMPS|ACH|POS)?[-: ]*([^.;]{2,40})/i, pick: m => m[1] },
  // "-NEFT-LANDLORD" trailing tag
  { re: /-(?:NEFT|IMPS|RTGS|ACH|POS|UPI)-([A-Za-z0-9 &._-]{2,40})/i, pick: m => m[1] },
  // "at AMAZON on ..." / "to SWIGGY On ..." / "towards RENT" - the payee.
  { re: /\b(?:at|to|towards)\s+([A-Za-z0-9][A-Za-z0-9&.,'\/ _-]{1,40}?)(?=\s+(?:on|dated|ref|upi|avl|txn|not|info)\b|[.;,]|$)/i, pick: m => m[1] },
  // ICICI and Amazon Pay ICICI end with the payee: "... on 11-Sep-25 on AMAZON."
  // Requiring a letter first is what separates the payee from the date "on".
  { re: /\bon\s+([A-Za-z][A-Za-z0-9&.,'\/ _-]{1,40}?)(?=[.;,]|$)/i, pick: m => m[1] },
  // "from SALARY" - only useful on credits; on a debit "from" names OUR account,
  // so this runs last and the junk filter below drops account-shaped captures.
  { re: /\bfrom\s+([A-Za-z0-9][A-Za-z0-9&.,'\/ _-]{1,40}?)(?=\s+(?:on|dated|ref|upi|avl|txn|not|info)\b|[.;,]|$)/i, pick: m => m[1] },
  // "transfer to SWIGGY Ref No"
  { re: /\btransfer(?:red)? to\s+([A-Za-z0-9][A-Za-z0-9&.,' _-]{1,40})/i, pick: m => m[1] },
];

const MERCHANT_JUNK = /^(your|the|a|an|account|a\/c|bank|card|us|you|customer|dispute|call)$/i;

export function extractMerchant(text) {
  for (const { re, pick } of MERCHANT_PATTERNS) {
    const m = re.exec(text);
    if (!m) continue;
    let name = pick(m)
      .replace(/\s+/g, ' ')
      .replace(/[.,;:\-\/]+$/, '')
      .trim();
    // Bank names leaking in from "from HDFC Bank A/C" are not merchants.
    if (!name || name.length < 2 || MERCHANT_JUNK.test(name)) continue;
    if (/\b(a\/c|acct|account|bank|card)\b/i.test(name) || /\d{4,}/.test(name)) continue;
    if (/^(hdfc|icici|sbi|axis|kotak|au|csb|federal|jupiter)\s*(bank)?$/i.test(name)) continue;
    return name;
  }
  return null;
}

// ---------------------------------------------------------------- reference

export function extractRef(text) {
  const m = /\b(?:upi\s*)?(?:ref(?:erence)?|rrn|txn|transaction)\s*(?:no\.?|id|#)?\s*[:\-]?\s*([0-9]{6,20})\b/i.exec(text)
    // Some templates carry the reference bare: "UPI:307012345678".
    || /\bupi\s*[:\-]\s*([0-9]{9,20})\b/i.exec(text);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------- main

/**
 * @param {string} raw        message body
 * @param {object} [meta]     { sender, receivedAt } - from an SMS export, when available
 * @returns {object} record with kind 'txn' | 'noise'
 */
export function parseMessage(raw, meta = {}) {
  const text = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!text) return { kind: 'noise', reason: 'empty', raw };

  for (const rule of NOISE_RULES) {
    if (rule.re.test(text)) return { kind: 'noise', reason: rule.reason, raw: text };
  }

  const money = extractMoney(text);
  const direction = extractDirection(text);

  // No amount, or no sense of which way the money moved => not a transaction.
  if (money.amount === null) return { kind: 'noise', reason: 'no-amount', raw: text };
  if (!direction) return { kind: 'noise', reason: 'no-direction', raw: text };

  const issuer = detectIssuer(text, meta.sender);
  const account = extractAccount(text);
  const date = extractDate(text) || (meta.receivedAt ? meta.receivedAt.slice(0, 10) : null);
  const channel = detectChannel(text);
  let merchant = extractMerchant(text);
  if (!merchant && channel === 'atm') merchant = 'Cash withdrawal';
  const ref = extractRef(text);

  // Confidence drives the "needs review" queue - we never silently drop money.
  let confidence = 0.5;
  if (date) confidence += 0.2;
  if (merchant) confidence += 0.15;
  if (account.tail) confidence += 0.1;
  if (ref) confidence += 0.05;
  if (!extractDate(text) && meta.receivedAt) confidence -= 0.1; // date inferred, not stated

  return {
    kind: 'txn',
    amount: money.amount,
    direction,
    date,
    merchant,
    ref,
    balance: money.balance,
    creditLimit: money.limit,
    issuer: issuer ? issuer.name : null,
    issuerId: issuer ? issuer.id : null,
    account: account.tail,
    accountType: account.type,
    channel,
    confidence: Math.round(Math.min(confidence, 1) * 100) / 100,
    raw: text,
  };
}

function detectChannel(text) {
  if (/\bupi\b|@[a-z]{2,}\b/i.test(text)) return 'upi';
  if (/\batm\b|withdraw/i.test(text)) return 'atm';
  if (/\bcard\b|\bpos\b/i.test(text)) return 'card';
  if (/\bneft\b|\bimps\b|\brtgs\b/i.test(text)) return 'transfer';
  if (/\bach\b|\becs\b|\bnach\b/i.test(text)) return 'mandate';
  return 'other';
}

/** Split a pasted blob into individual messages. Blank line, or one per line. */
export function splitMessages(blob) {
  const text = String(blob || '').trim();
  if (!text) return [];
  const byBlank = text.split(/\n\s*\n+/).map(s => s.trim()).filter(Boolean);
  // If the user pasted one message per line, blank-line splitting returns one
  // giant chunk - fall back to line splitting when a chunk holds many messages.
  if (byBlank.length === 1 && /\n/.test(text)) {
    return text.split(/\n/).map(s => s.trim()).filter(Boolean);
  }
  return byBlank;
}
