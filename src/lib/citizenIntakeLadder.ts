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

/** Civic / local issues where a pinpoint place actually matters. */
const NEEDS_AREA =
  /\b(road|drain|drainage|sewer|sewage|blockage|blocked|clog|garbage|water|power|electric|electricity|outage|current|street|light|pothole|manhole|pipe|flood|leak|overflow|కరెంట్|చెత్త|మురుగు|రోడ్|నీరు|सड़क|नाली|कचरा|पानी|बिजली)\b/i

const PROBLEM_HINT =
  /\b(road|drain|drainage|sewer|sewage|blockage|blocked|clog|clogged|overflow|manhole|pipe|pipeline|garbage|water|power|electric|aadhaar|aadhar|ration|voter|pan|street|light|toilet|pension|police|dog|stray|leak|broken|flood|smell|stink|dirty|problem|issue|complaint|help|రోడ్|మురుగు|చెత్త|నీరు|కరెంట్|ఆధార్|సమస్య|सड़क|नाली|कचरा|पानी|बिजली|आधार|समस्या|शिकायत)\b/i

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

/** True when the reply looks like a real address / colony line. */
export function looksLikeAddress(text: string): boolean {
  const t = text.trim()
  if (t.length < 8) return false
  if (isShortGreeting(t)) return false
  if (/^(my name is|i am|i'm|నా పేరు|मेरा नाम)\b/i.test(t)) return false
  if (/\d{5,6}/.test(t)) return true // pin code
  if (/,/.test(t) && t.length >= 20) return true
  if (/\b(rd|road|colony|nagar|society|ward|gali|street|lane|plot|h\.?\s*no|osman|manchirevula|narsingi)\b/i.test(t)) {
    return true
  }
  // Long free-text with place words, but not a plain name intro
  return false
}

export function extractNamedIntro(text: string): string | null {
  const m = text.match(
    /(?:my name is|i am|i'm|this is|నా పేరు|నేను|मेरा नाम|मैं)\s+([\p{L}][\p{L}']*(?:\s+[\p{L}][\p{L}']*){0,2})/iu,
  )
  if (!m?.[1]) return null
  return cleanName(m[1])
}

export function extractBareName(text: string): string | null {
  const t = text.trim()
  if (!t || isShortGreeting(t)) return null
  if (looksLikeProblem(t) && !/^(my name is|i am|i'm)/i.test(t)) return null
  if (/[0-9@]/.test(t)) return null
  // "my name is anurag i am from hyderabad" → handled by extractNamedIntro
  const intro = extractNamedIntro(t)
  if (intro) return intro
  if (t.split(/\s+/).length > 5) return null
  if (!/^[\p{L}][\p{L} .']{1,50}$/u.test(t)) return null
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
  if (stop > 0) name = name.slice(0, stop)
  name = name.replace(/[,.].*$/, '').trim().slice(0, 40)
  if (name.length < 2) return null
  if (PROBLEM_HINT.test(name)) return null
  return name
    .replace(/\s+/g, ' ')
    .replace(/\p{L}+/gu, (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
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
