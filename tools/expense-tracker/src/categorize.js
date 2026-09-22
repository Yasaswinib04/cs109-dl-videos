/**
 * categorize.js - merchant string -> spending category.
 *
 * Seeded with Indian merchants, then sharpened by the user: every manual
 * correction becomes a rule, so the tracker gets more accurate each month
 * instead of needing the same fix over and over.
 */

export const CATEGORIES = [
  // Spending, in roughly the order a month gets eaten.
  'Rent', 'Order in', 'Eat out', 'Groceries', 'Transport', 'Travel',
  'Shopping', 'Entertainment', 'Gifts', 'Health', 'Bills & Utilities',
  'Education', 'Taxes', 'Cash', 'Fees & Charges',
  // Money that moves without being spent, and money coming in.
  'Investment', 'Transfers', 'Income',
  // The honest bucket. Never guessed into - see suggestions in normalize.js.
  'Miscellaneous',
];

/** Substring -> category. Ordered: the first match wins, so keep specifics first. */
const SEED_RULES = [
  // Money moving between your own pockets has to win over everything else,
  // or a card-bill payment gets counted as a second purchase.
  ['Transfers',        ['transfer to own account','self transfer','cred ','cred.club','cred club','dreamplug','credit card payment','cc payment','card payment','credit card bill','billdesk','own account']],
  ['Taxes',            ['directtax','direct tax','income tax','incometax','itns','advance tax','self assessment','tds ','gst pay','property tax']],
  ['Investment',       ['investment','zerodha','groww','upstox','angel one','angelone','icici direct','hdfc securities','kuvera','smallcase','indmoney','paytm money','mutual fund','sip ','nps ','ppf','elss','nippon','mirae','parag parikh','quant mf','gold bond','sgb','coin dcx','coindcx']],
  ['Rent',             ['rent','landlord','nobroker','maintenance','society','pg ','hostel']],

  // Groceries before eating out: "Swiggy Instamart" is a grocery run, and the
  // plain "swiggy" rule below must not claim it first.
  ['Groceries',        ['instamart','swiggystores','swiggy stores','blinkit','grofers','zepto','zptmktp','bigbasket','bbdaily','dmart','d-mart','jiomart','licious','freshtohome','country delight','milkbasket','reliance fresh','more retail','ratnadeep','kirana','provision','supermarket','super market','stores','store']],
  ['Order in',         ['swiggy','zomato','eatsure','faasos','box8','behrouz','ovenstory','dunzo','magicpin']],
  ['Eat out',          ['restaurant','cafe','coffee','starbucks','chaayos','third wave','blue tokai','bakery','sweet','biryani','biriyani','dhaba','hotel ','tiffin','canteen','juice','ice cream','icecream','darshini','udupi','barbeque','bbq','pizza','domino','mcdonald','kfc','burger','subway','wow momo','haldiram','chai','dineout','eazydiner','bar ','brewery','kitchen','foods','snack']],

  // Out-of-town travel before in-city transport: redBus and IRCTC are journeys,
  // not commutes.
  ['Travel',           ['irctc','indigo','vistara','air india','akasa','spicejet','makemytrip','goibibo','yatra','cleartrip','ixigo','easemytrip','redbus','abhibus','oyo','airbnb','booking.com','agoda','treebo','fabhotel','resort','homestay','airlines','airline','railway']],
  ['Transport',        ['uber','rapido','rapidi','olacabs','ola ','namma','yulu','bounce','blusmart','blu smart','metro','bmtc','dmrc','fastag','parking','park+','petrol','fuel','hpcl','iocl','bpcl','indian oil','shell','nayara']],

  ['Health',           ['apollo','pharmeasy','1mg','netmeds','medplus','practo','manipal','amaha','fortis','narayana','aster','meds','pharma','health','hospital','clinic','diagnost','thyrocare','dr lal','metropolis','lenskart','dental','medical','cult','gym','fitness']],
  ['Bills & Utilities',['jio','airtel','vodafone','vi ','bsnl','act fibernet','hathway','excitel','tata play','bescom','tneb','msedcl','adani electricity','tata power','torrent power','bses','indraprastha gas','mahanagar gas','hp gas','bharat gas','indane','electricity','broadband','postpaid','prepaid','recharge','googlecloud','google cloud','aws ','digitalocean','cred.telecom']],
  ['Entertainment',    ['astrotalk','netflix','spotify','hotstar','jiocinema','jiohotstar','prime video','sonyliv','zee5','youtube','bookmyshow','pvr','inox','cinepolis','audible','kindle','playstation','steam','xbox','google pla','googleplay','play store','gaming']],
  ['Education',        ['udemy','coursera','unacademy','byju','vedantu','upgrad','simplilearn','great learning','scaler','physics wallah','tuition','school fee','college','university','exam fee','skillshare','duolingo']],
  ['Shopping',         ['amazon','amzn','flipkart','myntra','ajio','nykaa','meesho','tatacliq','tata cliq','snapdeal','decathlon','ikea','lifestyle','shoppers stop','westside','zara','uniqlo','croma','reliance digital','vijay sales','pepperfry','urban ladder','firstcry','boat lifestyle']],
  ['Gifts',            ['gift','giftcard','gift card','ferns','igp.com','archies']],
  ['Cash',             ['atm','cash withdrawal','cash wdl','withdrawn']],
  ['Fees & Charges',   ['charges','annual fee','late fee','penalty','service charge','processing fee','convenience fee','surcharge','amc ','renewal fee','gst ']],
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
  return { category: 'Miscellaneous', source: 'fallback' };
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
  const raw = needle.trim();
  const core = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!core) return false;

  // Long needles are safe as plain substrings, and they have to be: UPI handles
  // run words together, so "health" must still be found inside
  // "shashilahealth". Short ones need a boundary or "vi" matches "via" and
  // "aws" matches "laws".
  const needsStartBound = raw.length < 5;
  const start = needsStartBound ? '(^|[^a-z0-9])' : '';
  const end = endBound ? '($|[^a-z0-9])' : '';
  return new RegExp(`${start}${core}${end}`, 'i').test(hay);
}

export { normKey };
