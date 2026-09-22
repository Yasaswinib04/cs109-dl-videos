/**
 * categorize.js - merchant string -> spending category.
 *
 * Seeded with Indian merchants, then sharpened by the user: every manual
 * correction becomes a rule, so the tracker gets more accurate each month
 * instead of needing the same fix over and over.
 */

export const CATEGORIES = [
  'Food & Dining', 'Groceries', 'Transport', 'Shopping', 'Bills & Utilities',
  'Rent & Housing', 'Health', 'Entertainment', 'Travel', 'Education',
  'Investments', 'Transfers', 'Cash', 'Fees & Charges', 'Taxes', 'Income', 'Other',
];

/** Substring -> category. Ordered: the first match wins, so keep specifics first. */
const SEED_RULES = [
  ['Groceries',        ['instamart','swiggy instamart','swiggystores','swiggy stores','blinkit','zepto','instamart','bigbasket','bbdaily','dmart','d-mart','licious','freshtohome','country delight','more retail','reliance fresh','spencer','nature basket','milkbasket','grofers','jiomart','ratnadeep']],
  ['Food & Dining',    ['swiggy','sweet','bakers','biriyani','dhaba','hotel ','foods','tiffin','canteen','juice','icecream','ice cream','zomato','eatfit','dominos','domino','pizza','mcdonald','kfc','burger','starbucks','chaayos','third wave','blue tokai','cafe','coffee','restaurant','biryani','bakery','dineout','eazydiner','faasos','behrouz','wow momo','haldiram','barbeque','subway','dunkin','baskin','chai point']],
  ['Transport',        ['uber','rapido','rapidi','namma','auto ','ola ','olacabs','rapido','namma yatri','yulu','bounce','blusmart','blu smart','metro','bmtc','dmrc','fastag','petrol','fuel','hpcl','iocl','bpcl','indian oil','shell','nayara','park+','parking']],
  ['Travel',           ['irctc','indigo','vistara','air india','akasa','spicejet','makemytrip','goibibo','yatra','cleartrip','ixigo','redbus','abhibus','oyo','airbnb','booking.com','agoda','trivago','easemytrip']],
  ['Shopping',         ['amazon','flipkart','myntra','ajio','nykaa','meesho','tatacliq','tata cliq','snapdeal','decathlon','ikea','lifestyle','shoppers stop','westside','zara','h&m','uniqlo','croma','reliance digital','vijay sales','pepperfry','urban ladder','boat','firstcry']],
  ['Bills & Utilities',['jio','googlecloud','google cloud','aws','digitalocean','airtel','vodafone','vi ','bsnl','act fibernet','hathway','excitel','tata play','dish tv','bescom','tneb','msedcl','adani electricity','tata power','torrent power','mahadiscom','bses','indraprastha gas','mahanagar gas','gail','hp gas','bharat gas','indane','water bill','broadband','recharge','electricity','postpaid','prepaid']],
  ['Rent & Housing',   ['rent','landlord','nobroker','housing.com','magicbricks','maintenance','society','apartment','flat rent','pg ','hostel']],
  ['Health',           ['meds','pharma','health','amaha','manipal','diagnost','apollo','pharmeasy','1mg','tata 1mg','netmeds','medplus','practo','cult','cultfit','gym','fitness','hospital','clinic','diagnostic','thyrocare','dr lal','metropolis','lenskart','titan eye','dental','pharmacy','medical']],
  ['Entertainment',    ['netflix','google pla','googleplay','play store','spotify','hotstar','jiocinema','jiohotstar','prime video','sonyliv','zee5','youtube','bookmyshow','pvr','inox','cinepolis','audible','kindle','playstation','steam','xbox','nintendo','dream11','gaming']],
  ['Education',        ['udemy','coursera','unacademy','byju','vedantu','upgrad','simplilearn','great learning','scaler','newton','physics wallah','tuition','school fee','college','university','exam fee','skillshare','duolingo']],
  ['Investments',      ['investment','zerodha','groww','upstox','angel one','angelone','icici direct','hdfc securities','kuvera','coin','indmoney','smallcase','paytm money','mutual fund','sip ','nps ','ppf','elss','nippon','sbi mf','axis mf','hdfc mf','icici pru','mirae','parag parikh','quant mf','lic ','term plan','insurance','policybazaar','gold bond','sgb']],
  ['Transfers',        ['transfer to own account','self transfer','cred','credit card payment','cc payment','card payment','billdesk','autopay','own account','self transfer','to self','credit card bill']],
  ['Cash',             ['atm','cash withdrawal','cash wdl','withdrawn']],
  ['Taxes',            ['directtax','direct tax','income tax','incometax','itns','advance tax','self assessment','tds ','gst pay','property tax']],
  ['Fees & Charges',   ['charges','gst','annual fee','late fee','penalty','interest','service charge','processing fee','convenience fee','surcharge','amc ','renewal fee']],
];

/** Credits that are genuinely income rather than a refund or a transfer back. */
const INCOME_HINTS = ['salary','sal cr','payroll','stipend','bonus','dividend','interest credit','reimbursement','freelance','consulting','payout'];

function normKey(merchant) {
  return String(merchant || '').toLowerCase().replace(/[^a-z0-9@. ]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * @param {object} txn        parsed transaction
 * @param {object} [rules]    learned overrides: { "<merchant key>": "<category>" }
 * @returns {{category: string, source: 'user'|'seed'|'fallback'}}
 */
export function categorize(txn, rules = {}) {
  const key = normKey(txn.merchant);
  const hay = `${key} ${String(txn.raw || '').toLowerCase()}`;

  // A correction the user made always wins over our guesses.
  if (key && rules[key]) return { category: rules[key], source: 'user' };

  // Moving money between your own accounts is never spending or income.
  if (txn.selfTransfer) return { category: 'Transfers', source: 'seed' };

  if (txn.direction === 'credit') {
    // A refund carries the category of the purchase it reverses - a Zepto
    // refund is groceries, not shopping - so fall through to the merchant
    // rules and only use a generic bucket when nothing matches.
    if (/\b(refund|revers|cashback)\b/i.test(txn.raw || '')) {
      for (const [category, needles] of SEED_RULES) {
        if (needles.some(n => needleMatches(hay, n))) return { category, source: 'seed' };
      }
      return { category: 'Shopping', source: 'fallback' };
    }
    if (INCOME_HINTS.some(h => needleMatches(hay, h))) return { category: 'Income', source: 'seed' };
    return { category: 'Income', source: 'fallback' };
  }

  for (const [category, needles] of SEED_RULES) {
    if (needles.some(n => needleMatches(hay, n))) return { category, source: 'seed' };
  }
  return { category: 'Other', source: 'fallback' };
}

/**
 * The same brand appears under many spellings in one statement - Zepto alone
 * shows up as "ZEPTO MARK", "zeptomarketpla", "zeptonow.bdpg1", "zptmktp1" and
 * "cf.zepto12". Collapsing them to one name is what makes a merchant total,
 * a subscription, or a "you spent X on Y" figure mean anything.
 *
 * Order matters: the more specific brand is listed first.
 */
const BRANDS = [
  ['Swiggy Instamart', ['instamart', 'swiggystores', 'swiggy stores']],
  ['Swiggy',           ['swiggy']],
  ['Zomato',           ['zomato']],
  ['Zepto',            ['zepto', 'zptmktp']],
  ['Blinkit',          ['blinkit', 'grofers']],
  ['BigBasket',        ['bigbasket', 'bbdaily']],
  ['CRED Telecom',     ['cred.telecom', 'cred telecom']],
  ['CRED',             ['cred.club', 'cred club', 'dreamplug']],
  ['Uber',             ['uber']],
  ['Rapido',           ['rapido']],
  ['Ola',              ['olacabs', 'ola ']],
  ['Amazon',           ['amazon', 'amzn']],
  ['Flipkart',         ['flipkart']],
  ['Myntra',           ['myntra']],
  ['Netflix',          ['netflix']],
  ['Spotify',          ['spotify']],
  ['Google Play',      ['google pla', 'googleplay']],
  ['Google Cloud',     ['googlecloud', 'google cloud']],
  ['Zerodha',          ['zerodha']],
  ['Groww',            ['groww']],
  ['Airtel',           ['airtel']],
  ['Jio',              ['jio']],
  ['redBus',           ['redbus']],
  ['Meesho',           ['meesho']],
  ['Income Tax',       ['directtax', 'direct tax', 'incometax']],
];

/**
 * Canonical brand name for a merchant, or the original when no brand matches.
 * @param {string} merchant  the name pulled from the narration
 * @param {string} [raw]     the full narration, which often names the brand
 *                           when the merchant field does not
 */
export function canonicalMerchant(merchant, raw = '') {
  const hay = `${normKey(merchant)} ${String(raw).toLowerCase()}`;
  for (const [name, needles] of BRANDS) {
    if (needles.some(n => needleMatches(hay, n))) return name;
  }
  return merchant;
}

/** Record a correction so the same merchant is never miscategorized twice. */
export function learnRule(rules, merchant, category) {
  const key = normKey(merchant);
  if (!key) return rules;
  return { ...rules, [key]: category };
}

/** Flat list of every seed needle, AS AUTHORED - used to recognise a merchant
 *  inside a statement narration. Never trim these: a trailing space is
 *  meaningful (see needleMatches). */
export const SEED_NEEDLES = SEED_RULES.flatMap(([, needles]) => needles);

/**
 * Match a needle against text with word boundaries.
 *
 * Plain substring matching is not safe at these lengths: "vi" (the telecom
 * operator) otherwise matches "paid via card", and "aws" matches "laws". So a
 * needle must start at a word boundary, and a needle authored WITH A TRAILING
 * SPACE ("vi ", "sip ", "auto ") must end at one too - that trailing space is
 * how the rule table says "this is a whole word".
 */
export function needleMatches(hay, needle) {
  const endBound = /\s$/.test(needle);
  const core = needle.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!core) return false;
  return new RegExp(`(^|[^a-z0-9])${core}${endBound ? '($|[^a-z0-9])' : ''}`, 'i').test(hay);
}

export { normKey };
