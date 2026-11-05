/**
 * Light intake helpers for Guide / WhatsApp.
 * Keep collection minimal: name → problem → (area only if needed) → help.
 * Phone / email only when filing or emailing a department.
 */

export type IntakePhase = 'ask_name' | 'ask_problem' | 'ask_area' | 'help'

const GREETING_ONLY =
  /^(hi+|hii+|hello+|hey+|yo+|namaste|namaskar|vanakkam|నమస్కారం|నమస్తే|హాయ్|नमस्ते|नमस्कार|हेलो|हाय)\s*[!.।]?$/iu

const CONTINUE_INTENT =
  /\b(continue|resume|same|previous|old one|pick up|from there|కొనసాగించు|మునుపటి|जारी|पिछला|वहीं से)\b/i

const NEW_ISSUE_INTENT =
  /\b(new (one|issue|problem|complaint|case)|start (over|fresh|new)|different|another|కొత్త|కొత్తది|नया|नई समस्या)\b/i

const SKIP_CONTACT =
  /^(skip|later|no|nahi|ledu|pass|none|వద్దు|తర్వాత|नहीं|बाद में|छोड़)\s*[!.]?$/iu

/** Word-ish boundary that works for Latin AND Telugu/Hindi (JS \\b does not). */
const WB = String.raw`(?<![\p{L}\p{N}_])`
const WE = String.raw`(?![\p{L}\p{N}_])`

/** Civic / local issues where a pinpoint place actually matters. */
const NEEDS_AREA = new RegExp(
  `${WB}(road|drain|drainage|sewer|sewage|blockage|blocked|clog|garbage|water|power|electric|electricity|outage|current|street|light|pothole|manhole|pipe|flood|leak|overflow|traffic|jam|congestion|parking|కరెంట్|చెత్త|మురుగు|రోడ్|నీరు|నీళ్లు|ట్రాఫిక్|सड़क|नाली|कचरा|पानी|बिजली|ट्रैफिक)${WE}`,
  'iu',
)

const PROBLEM_HINT = new RegExp(
  `${WB}(road|drain|drainage|sewer|sewage|blockage|blocked|clog|clogged|overflow|manhole|pipe|pipeline|garbage|water|power|electric|aadhaar|aadhar|ration|voter|pan|street|light|toilet|pension|police|dog|stray|leak|broken|flood|smell|stink|dirty|problem|issue|complaint|help|traffic|jam|congestion|parking|salon|saloon|spa|restaurant|clinic|hospital|gym|pharmacy|రోడ్|మురుగు|చెత్త|నీరు|నీళ్లు|కరెంట్|ఆధార్|సమస్య|ట్రాఫిక్|सड़क|नाली|कचरा|पानी|बिजली|आधार|समस्या|शिकायत|पता|ट्रैफिक)${WE}`,
  'iu',
)

const VAGUE_PLACE =
  /^(telangana|hyderabad|hydrabad|warangal|india|tg|ts|హైదరాబాద్|తెలంగాణ|हैदराबाद|तेलंगाना)\s*$/i

const NAME_STOP =
  /\b(i am|i'm|im|from|in|near|and|here|this side|speaking|live|staying|my|the|a|an)\b/i

export function isShortGreeting(text: string): boolean {
  return GREETING_ONLY.test(text.trim())
}

export function wantsContinue(text: string): boolean {
  return CONTINUE_INTENT.test(text.trim()) || /^(1|continue|yes|ha|हाँ|అవును|ok|sare|సరే)\s*$/i.test(text.trim())
}

export function wantsNewIssue(text: string): boolean {
  return NEW_ISSUE_INTENT.test(text.trim()) || /^(2|new|naya|కొత్త)\s*$/i.test(text.trim())
}

export function wantsSkipContact(text: string): boolean {
  return SKIP_CONTACT.test(text.trim())
}

export function looksLikeProblem(text: string): boolean {
  const t = text.trim()
  if (t.length < 6) return false
  if (isShortGreeting(t)) return false
  if (/\b(this side|speaking)\b/i.test(t) && !PROBLEM_HINT.test(t)) return false
  if (/^(my name is|i am|i'm|నా పేరు|मेरा नाम)\b/i.test(t) && !PROBLEM_HINT.test(t)) return false
  if (PROBLEM_HINT.test(t)) return true
  return t.length >= 28
}

/** True when this civic problem needs a local address before we can help well. */
export function problemNeedsArea(
  problem: string | null | undefined,
  forced?: boolean | null,
): boolean {
  if (forced === true) return true
  if (forced === false) return false
  if (!problem?.trim()) return false
  return NEEDS_AREA.test(problem)
}

export function isVaguePlace(text: string): boolean {
  const t = text.trim()
  if (!t) return true
  if (t.length < 3) return true
  if (VAGUE_PLACE.test(t)) return true
  return false
}

const TELANGANA_PLACE =
  /\b(telangana|hyderabad|hydrabad|secunderabad|gachibowli|gachbowli|gachiboli|narsingi|manchirevula|kukatpally|kphb|madhapur|hitec|hitech|warangal|karimnagar|nizamabad|khammam|mahbubnagar|rangareddy|medchal|sanga\s*reddy|uppal|lb\s*nagar|amberpet|shaikpet|bachupally|miyapur|హైదరాబాద్|తెలంగాణ|हैदराबाद|तेलंगाना)\b/i

/** Clear other-state / other-city signals (Priya is Telangana-only). */
const OUTSIDE_TELANGANA =
  /\b(punjab|mohali|chandigarh|ludhiana|amritsar|delhi|noida|gurgaon|gurugram|mumbai|pune|bangalore|bengaluru|chennai|kolkata|jaipur|lucknow|ahmedabad|kerala|karnataka|tamil\s*nadu|maharashtra|gujarat|rajasthan|bihar|odisha|assam|goa|haryana|uttar\s*pradesh|west\s*bengal|shimla|indore|bhopal|nagpur|surat|patna|ranchi|dehradun|sector\s*\d+)\b/i

/** True when the text points at a place outside Telangana (and not also naming a TG place). */
export function looksOutsideTelangana(text: string | null | undefined): boolean {
  const t = (text || '').trim()
  if (!t) return false
  if (TELANGANA_PLACE.test(t)) return false
  return OUTSIDE_TELANGANA.test(t)
}

/** True when the reply looks like a real address / colony line. */
export function looksLikeAddress(text: string): boolean {
  const t = text.trim()
  if (t.length < 8) return false
  if (isShortGreeting(t)) return false
  if (/^(my name is|i am|i'm|నా పేరు|मेरा नाम)\b/i.test(t)) return false
  // Second issue in same breath is not a place reply
  if (/\b(also|another|plus|and also|one more).{0,40}\b(garbage|drain|sewer|aadhaar|pan|pension|light|power|water|road|manhole)\b/i.test(t)) {
    return false
  }
  // "manhole on my street" / "parking near the market" = problem, not an address
  const strongProblem =
    /\b(manhole|pothole|garbage|sewer|drain|street\s*light|no\s+(water|electricity|power|current)|power\s+cut|water\s+leak|pipe\s+burst|pension|aadhaar|aadhar|\bpan\b|encroach|illegal\s+park)\b/i
  const hasSpecificPlace =
    /\d{5,6}/.test(t) ||
    (/,/.test(t) && t.length >= 20) ||
    /\b(colony|nagar|society|phase|plot|h\.?\s*no|landmark|kphb|gachibowli|narsingi|manchirevula|bachupally|kukatpally|uppal|amberpet|shaikpet|jubilee|osman|lb\s*nagar|saroornagar)\b/i.test(
      t,
    )
  if (strongProblem.test(t) && !hasSpecificPlace) return false

  if (/\d{5,6}/.test(t)) return true // pin code
  if (/,/.test(t) && t.length >= 20) return true
  if (
    /\b(rd|road\s*no|road number|colony|nagar|society|ward|gali|lane|plot|phase|h\.?\s*no|osman|manchirevula|narsingi|bachupally|kukatpally|kphb|gachibowli|uppal|amberpet|jubilee|landmark)\b/i.test(
      t,
    )
  ) {
    return true
  }
  // Bare "street" / "road" only count with another place signal
  if (/\b(street|road)\b/i.test(t) && hasSpecificPlace) return true
  // Telugu / Hindi place-ish lines (colony + city)
  if (/[\u0C00-\u0C7F]{3,}/.test(t) && /(హైదరాబాద్|నర్సింగి|కాలనీ|కాలని)/.test(t)) return true
  if (/[\u0900-\u097F]{3,}/.test(t) && /(हैदराबाद|कॉलोनी|नगर)/.test(t)) return true
  return false
}

/**
 * True when this user turn is almost certainly supplying a place for the
 * current issue — not naming a new civic/self-serve topic.
 * Prevents "Road No. 4, KPHB" from rematching the roads playbook.
 */
export function isPlaceReplyForCurrentIssue(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  if (!looksLikeAddress(t)) return false
  // Strip place boilerplate; leftover should not look like a fresh problem
  const stripped = t
    .replace(
      /\b(rd|road\s*no\.?|road number|road|street|lane|colony|nagar|society|ward|gali|plot|phase|h\.?\s*no\.?|near|beside|at|in|hyderabad|warangal|secunderabad|kukatpally|kphb|gachibowli|narsingi|manchirevula|bachupally|uppal|amberpet|shaikpet|lb\s*nagar|saroornagar|landmark|bus\s*depot|apartment|gate)\b/gi,
      ' ',
    )
    .replace(/\d+/g, ' ')
    .replace(/[.,/\\\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (stripped.length <= 3) return true
  // Remaining tokens are mostly proper nouns (area names) — still a place reply
  if (stripped.split(/\s+/).length <= 4 && !PROBLEM_HINT.test(stripped)) return true
  return false
}

/**
 * A name word. Includes combining marks (\p{M}): Telugu / Hindi vowel signs such as
 * the "ి" in "రవి" are marks, not letters, so a letters-only class cut "రవి" to "రవ".
 */
const NAME_WORD = String.raw`[\p{L}][\p{L}\p{M}']*`

/** Explicit name intros. */
const STRONG_INTRO = new RegExp(
  String.raw`(?:my name is|this is|నా పేరు|मेरा नाम)\s+(${NAME_WORD}(?:\s+${NAME_WORD}){0,2})`,
  'iu',
)
/** "I am ..." style intros are ambiguous ("I am facing...", "I'm from..."), so they are filtered harder. */
const WEAK_INTRO = new RegExp(
  String.raw`(?:^|[\s,.;!?])(?:i am|i'm|నేను|मैं)\s+(${NAME_WORD}(?:\s+${NAME_WORD}){0,1})`,
  'iu',
)
const NOT_A_NAME_START =
  /^(not|from|in|at|on|near|here|there|a|an|the|very|so|also|just|still|really|trying|looking|facing|having|getting|unable|worried|angry|upset|tired|sorry|sure|new|calling|writing|asking|waiting|living|staying|stuck|confused|fine|good|ok|okay|happy|sad|late|going|coming)(?![\p{L}\p{M}])/iu

export function extractNamedIntro(text: string): string | null {
  const strong = text.match(STRONG_INTRO)
  if (strong?.[1]) return cleanName(strong[1])
  const weak = text.match(WEAK_INTRO)
  if (weak?.[1]) {
    if (NOT_A_NAME_START.test(weak[1])) return null
    return cleanName(weak[1])
  }
  return null
}

const DECLINES_NAME = new RegExp(
  [
    String.raw`(?:rather not|prefer not|do not want to|don'?t want to|not comfortable|no need|not going to|won'?t|do not|don'?t|skip)[^.?!\n]{0,30}\b(?:name)\b`,
    String.raw`\bname\b[^.?!\n]{0,25}\b(?:not|no need|skip|don'?t|private|secret)\b`,
    String.raw`పేరు[^.?!\n]{0,20}(?:చెప్పను|చెప్పడం ఇష్టం లేదు|వద్దు|అవసరం లేదు|చెప్పక్కర్లేదు)`,
    String.raw`नाम[^.?!\n]{0,20}(?:नहीं बताना|नहीं बताऊँ|नहीं बताऊंगा|नहीं बताऊंगी|ज़रूरी नहीं|जरूरी नहीं)`,
  ].join('|'),
  'iu',
)

/** True when the citizen says they do not want to give a name ("I'd rather not share my name"). */
export function declinesName(text: string): boolean {
  return DECLINES_NAME.test(text)
}

export function extractBareName(text: string): string | null {
  const t = text.trim()
  if (!t || isShortGreeting(t)) return null
  if (looksLikeProblem(t) && !/^(my name is|i am|i'm|నా పేరు|मेरा नाम)/i.test(t)) return null
  if (/[0-9@]/.test(t)) return null
  // "my name is anurag i am from hyderabad" → handled by extractNamedIntro
  const intro = extractNamedIntro(t)
  if (intro) return intro
  // Real names are short — never swallow a whole Telugu/Hindi sentence as a name
  const words = t.split(/\s+/).filter(Boolean)
  if (words.length > 3) return null
  if (t.length > 40) return null
  // Allow combining marks (Telugu virama ్, Hindi matras already in letters, etc.)
  if (!/^[\p{L}][\p{L}\p{M} .']{0,50}$/u.test(t)) return null
  return cleanName(t)
}

export function extractPlace(text: string): string | null {
  if (looksLikeAddress(text)) return text.trim().slice(0, 160)

  const fromMatch = text.match(
    /\b(?:from|live in|staying in|area is|place is|location is|address is|ప్రాంతం|ఊరు|इलाका)\s+([\p{L}][\p{L}\d .,\-\/]{2,80})/iu,
  )
  if (fromMatch?.[1]) {
    const place = fromMatch[1].trim().replace(/[.,]$/, '').slice(0, 120)
    // Soft city like "hyderabad" — store only if specific enough; otherwise ignore
    if (!isVaguePlace(place)) return place
  }
  return null
}

export function extractPhone(text: string): string | null {
  const phone = text.match(/(?:\+?91[\s-]?)?[6-9]\d{9}/)
  if (!phone) return null
  return phone[0].replace(/\D/g, '').slice(-10)
}

export function extractEmail(text: string): string | null {
  const email = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)
  return email ? email[0].toLowerCase() : null
}

function cleanName(raw: string): string | null {
  let name = raw.trim()
  // Cut at the first stop-word so "anurag i am from …" → "anurag"
  const stop = name.search(NAME_STOP)
  if (stop === 0) return null // starts with "from / in / my ..." — not a name
  if (stop > 0) name = name.slice(0, stop)
  // Trailing Hindi / Telugu verbs and particles ("अनीता है", "రవి అండి") are not part of the name.
  name = name.replace(/\s+(?:है|हूँ|हूं|जी|hai|అండి|ఉన్నాను)\s*$/iu, '')
  name = name.replace(/[,.].*$/, '').trim().slice(0, 40)
  if (name.length < 2) return null
  if (PROBLEM_HINT.test(name)) return null
  name = name.replace(/\s+/g, ' ')
  // Title-case Latin only — leave Telugu / Hindi / mixed scripts unchanged
  if (/^[\p{Script=Latin}\s'.]+$/u.test(name)) {
    name = name.replace(/\p{L}+/gu, (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
  }
  return name
}

/**
 * Minimal phase: name → problem → (optional area) → help.
 * Phone/email are NOT phases — ask only when filing.
 */
export function nextPhase(args: {
  name?: string | null
  problem?: string | null
  place?: string | null
  /** Dify / classifier override for whether area is required. */
  needsArea?: boolean | null
}): IntakePhase {
  if (!args.name?.trim()) return 'ask_name'
  if (!args.problem?.trim()) return 'ask_problem'
  if (
    problemNeedsArea(args.problem, args.needsArea) &&
    (!args.place?.trim() || isVaguePlace(args.place))
  ) {
    return 'ask_area'
  }
  return 'help'
}

export function absorbIntakeSlots(text: string): {
  name?: string
  place?: string
  problem?: string
  phone?: string
  email?: string
} {
  const out: { name?: string; place?: string; problem?: string; phone?: string; email?: string } = {}
  const named = extractNamedIntro(text) || extractBareName(text)
  if (named) out.name = named
  const place = extractPlace(text)
  if (place) out.place = place
  const phone = extractPhone(text)
  if (phone) out.phone = phone
  const email = extractEmail(text)
  if (email) out.email = email

  // Don't treat a name+city intro as the problem
  const isIntroOnly =
    /^(hi+|hello+|hey+)?\s*(my name is|i am|i'm|నా పేరు|मेरा नाम)/i.test(text.trim()) &&
    !PROBLEM_HINT.test(text)

  if (looksLikeProblem(text) && !isIntroOnly) {
    let problem = text.trim()
    problem = problem.replace(/^(hi+|hello+|hey+|namaste|namaskar)[!.]?\s*/i, '')
    problem = problem.replace(
      /^(?:my name is|i am|i'm|నా పేరు|मेरा नाम)\s+[\p{L}][\p{L}']*(?:\s+[\p{L}][\p{L}']*){0,2}[,.]?\s*/iu,
      '',
    )
    if (problem.trim().length >= 6) out.problem = problem.trim().slice(0, 500)
  }
  return out
}
