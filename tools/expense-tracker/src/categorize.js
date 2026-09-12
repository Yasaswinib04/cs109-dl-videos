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
  'Investments', 'Transfers', 'Cash', 'Fees & Charges', 'Income', 'Other',
];

/** Substring -> category. Ordered: the first match wins, so keep specifics first. */
const SEED_RULES = [
  ['Food & Dining',    ['swiggy','zomato','eatfit','dominos','domino','pizza','mcdonald','kfc','burger','starbucks','chaayos','third wave','blue tokai','cafe','coffee','restaurant','biryani','bakery','dineout','eazydiner','faasos','behrouz','wow momo','haldiram','barbeque','subway','dunkin','baskin','chai point']],
  ['Groceries',        ['blinkit','zepto','instamart','bigbasket','bbdaily','dmart','d-mart','licious','freshtohome','country delight','more retail','reliance fresh','spencer','nature basket','milkbasket','grofers','jiomart','ratnadeep']],
  ['Transport',        ['uber','ola ','olacabs','rapido','namma yatri','yulu','bounce','blusmart','blu smart','metro','bmtc','dmrc','fastag','petrol','fuel','hpcl','iocl','bpcl','indian oil','shell','nayara','park+','parking']],
  ['Travel',           ['irctc','indigo','vistara','air india','akasa','spicejet','makemytrip','goibibo','yatra','cleartrip','ixigo','redbus','abhibus','oyo','airbnb','booking.com','agoda','trivago','easemytrip']],
  ['Shopping',         ['amazon','flipkart','myntra','ajio','nykaa','meesho','tatacliq','tata cliq','snapdeal','decathlon','ikea','lifestyle','shoppers stop','westside','zara','h&m','uniqlo','croma','reliance digital','vijay sales','pepperfry','urban ladder','boat','firstcry']],
  ['Bills & Utilities',['jio','airtel','vodafone','vi ','bsnl','act fibernet','hathway','excitel','tata play','dish tv','bescom','tneb','msedcl','adani electricity','tata power','torrent power','mahadiscom','bses','indraprastha gas','mahanagar gas','gail','hp gas','bharat gas','indane','water bill','broadband','recharge','electricity','postpaid','prepaid']],
  ['Rent & Housing',   ['rent','landlord','nobroker','housing.com','magicbricks','maintenance','society','apartment','flat rent','pg ','hostel']],
  ['Health',           ['apollo','pharmeasy','1mg','tata 1mg','netmeds','medplus','practo','cult','cultfit','gym','fitness','hospital','clinic','diagnostic','thyrocare','dr lal','metropolis','lenskart','titan eye','dental','pharmacy','medical']],
  ['Entertainment',    ['netflix','spotify','hotstar','jiocinema','jiohotstar','prime video','sonyliv','zee5','youtube','bookmyshow','pvr','inox','cinepolis','audible','kindle','playstation','steam','xbox','nintendo','dream11','gaming']],
  ['Education',        ['udemy','coursera','unacademy','byju','vedantu','upgrad','simplilearn','great learning','scaler','newton','physics wallah','tuition','school fee','college','university','exam fee','skillshare','duolingo']],
  ['Investments',      ['zerodha','groww','upstox','angel one','angelone','icici direct','hdfc securities','kuvera','coin','indmoney','smallcase','paytm money','mutual fund','sip ','nps ','ppf','elss','nippon','sbi mf','axis mf','hdfc mf','icici pru','mirae','parag parikh','quant mf','lic ','term plan','insurance','policybazaar','gold bond','sgb']],
  ['Transfers',        ['cred','credit card payment','cc payment','card payment','billdesk','autopay','own account','self transfer','to self','credit card bill']],
  ['Cash',             ['atm','cash withdrawal','cash wdl','withdrawn']],
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

  if (txn.direction === 'credit') {
    if (/\b(refund|revers|cashback)\b/i.test(txn.raw || '')) return { category: 'Shopping', source: 'seed' };
    if (INCOME_HINTS.some(h => hay.includes(h))) return { category: 'Income', source: 'seed' };
    return { category: 'Income', source: 'fallback' };
  }

  for (const [category, needles] of SEED_RULES) {
    if (needles.some(n => hay.includes(n))) return { category, source: 'seed' };
  }
  return { category: 'Other', source: 'fallback' };
}

/** Record a correction so the same merchant is never miscategorized twice. */
export function learnRule(rules, merchant, category) {
  const key = normKey(merchant);
  if (!key) return rules;
  return { ...rules, [key]: category };
}

export { normKey };
