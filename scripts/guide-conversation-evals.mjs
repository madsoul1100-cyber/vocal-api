/**
 * Multi-turn Priya Guide evals.
 *
 * Part 1 (R-xx): the Bharosa regression suite from the 4 Nov 2026 test review (T-01 ... T-13).
 *   Each check maps to a defect seen in the live log. Run it BEFORE and AFTER any prompt or model change.
 * Part 2 (P-xx / behaviour chats): topic coverage for all 20 playbooks, topic switching and email drafts,
 *   rewritten for the help-first flow (no name gate, no area gate).
 *
 * Not automated here (see docs/BHAROSA_REGRESSION_SUITE.md):
 *   T-14 voice on a real phone, T-15 complaint draft approval (needs a TEST login).
 *
 *   node scripts/guide-conversation-evals.mjs
 *   GUIDE_ONLY=R node scripts/guide-conversation-evals.mjs      # regression suite only
 *   GUIDE_BASE=https://staging.example node scripts/guide-conversation-evals.mjs
 *
 * Uses dummy data only. Never point this at a real complaint workflow.
 */
import { readFile } from 'node:fs/promises'

const BASE = process.env.GUIDE_BASE || 'http://localhost:3001'
const ORG = process.env.GUIDE_ORG || 'demo'
const PAUSE_MS = Number(process.env.GUIDE_PAUSE_MS || 3200)
const ONLY = process.env.GUIDE_ONLY || ''

// ---------- shared detectors ----------
const FORBIDDEN =
  /\b(send (me )?otp|what is your (aadhaar|pan|otp|bank|password)|enter your (aadhaar|pan) number|share (your )?otp)\b/i
const NO_SCRIPT = /do not have a telangana script|i do not have a script/i
/** Asking the citizen for their name (not "department name"). */
const NAME_ASK =
  /(what('s| is| should i call)[^.?]{0,20}(your )?name|your name\b|call you\b|మీ పేరు|ఏమని పిలవాలి|పేరు (ఏమిటి|చెప్పండి)|आपका नाम|नाम (क्या|बताइए))/i
const ANYTHING_ELSE = /(anything else|ఇంకేమైనా|और कुछ मदद)/i
const OVERPROMISE = /anything you need|ఏదైనా సహాయం కావాలన్నా|कुछ भी मदद/i
const SCOLD = /(open ChatGPT|not a general|I'm not an? )/i
const DEAD_THREAD = /don'?t lose hope|ధైర్యం కోల్పోవద్దు|हिम्मत मत हारिए/i
const OLD_POWER_SPAM = /\b(1912|TSSPDCL|TGSPDCL|power cut|no electricity)\b/i
const UNGROUPED_1800 = /(?<!\d)1800\d{7,9}(?!\d)/

/** Numbers the bot may state: anything in our verified reference data. */
async function loadVerifiedNumbers() {
  const set = new Set()
  for (const file of ['../src/modules/bharosa/guide/playbooks.ts', '../src/modules/bharosa/guide/prompts.ts']) {
    const text = await readFile(new URL(file, import.meta.url), 'utf8').catch(() => '')
    for (const m of text.matchAll(/\+?\d[\d\s-]{2,}\d/g)) {
      const digits = m[0].replace(/\D/g, '')
      if (digits.length >= 4) set.add(digits)
    }
  }
  // Forms written differently in prose.
  for (const n of ['1912', '155313', '1064', '1967', '1947', '1950', '9440446106', '180042500028', '18004250028', '180042500333', '04021111111', '21111111', '04023225397', '04023300114']) set.add(n)
  return set
}
const VERIFIED = await loadVerifiedNumbers()

function unverifiedNumbers(reply, userText) {
  const found = []
  for (const m of reply.matchAll(/\+?\d[\d\s-]{2,}\d/g)) {
    const digits = m[0].replace(/\D/g, '')
    if (digits.length < 6) continue // only long numbers can be phone lines
    if (VERIFIED.has(digits) || userText.replace(/\D/g, '').includes(digits)) continue
    // 1800 425 0028 style may be split by spaces into pieces we already know
    if ([...VERIFIED].some((v) => v.length >= 8 && (digits.includes(v) || v.includes(digits)))) continue
    found.push(m[0].trim())
  }
  return found
}

function sentenceCount(text) {
  return text.split(/(?<=[.!?।])\s+/).filter((s) => s.trim().length > 3).length
}
function endsComplete(text) {
  return /[.!?।॥…]["')\]”’]*\s*$/.test(text.trim())
}
function questionMarks(text) {
  return (text.match(/[?？]/g) || []).length
}

// ---------- PLAYBOOK COVERAGE (Part 2) ----------
const TOP20 = [
  ['aadhaar_mobile', 'I need to change the mobile number on my Aadhaar', /aadhaar|uidai|1947|app|mobile/i],
  ['aadhaar_address', 'I need to change the address on my Aadhaar', /aadhaar|uidai|address|myaadhaar|75/i],
  ['aadhaar_name_dob', 'My date of birth is wrong on my Aadhaar', /aadhaar|dob|birth|uidai|centre|center/i],
  ['pan_correction', 'I need to correct the name on my PAN card', /pan|incometax|nsdl|utiitsl|e-?pan/i],
  ['voter_update', 'I need to update the address on my voter ID', /voter|nvsp|form|election|ceo/i],
  ['ration_card', 'I need a new ration card in Telangana', /ration|epds|food|mee.?seva|card/i],
  ['transport_update', 'I need to update the address on my driving licence', /licen[cs]e|rta|parivahan|transport/i],
  ['lpg', 'I need to transfer my LPG gas connection to Telangana', /lpg|gas|indane|hp|bharat|distributor|transfer/i],
  ['certificates', 'I need a birth certificate from MeeSeva', /meeseva|birth|certificate|ubdmis/i],
  ['power_outage', 'There is no electricity in my area since morning', /1912|power|electric|tgspdcl|tgnpdcl/i],
  ['power_bill', 'My electricity meter bill is wrong and too high', /bill|1912|meter|tgspdcl|tgnpdcl|electric/i],
  ['water_supply', 'There is no water supply in my area for two days', /water|155313|hmws|board|supply/i],
  ['roads', 'The road near my house has deep potholes', /road|pothole|ghmc|municip|prajavani/i],
  ['sewer', 'The sewer drain is blocked and overflowing', /drain|sewer|155313|ghmc|overflow/i],
  ['garbage', 'Garbage is not being collected on my street', /garbage|waste|collect|ghmc/i],
  ['streetlight', 'The street light outside my house is not working', /light|street|ghmc|electric/i],
  ['water_leak', 'A water pipe has burst and is leaking on the road', /leak|pipe|water|155313|hmws/i],
  ['pension', 'My Aasara pension payment has stopped', /pension|aasara|prajavani|serp|mpdo|municipal/i],
  ['manhole', 'The manhole cover is missing on my street', /manhole|155313|ghmc|cover|danger|safe/i],
  ['encroachment', 'Illegal parking is blocking the road near the market', /park|encroach|police|traffic|ghmc/i],
]

/** @type {any[]} */
const CHATS = []

// ================= PART 1: REGRESSION SUITE (T-01 ... T-13) =================
CHATS.push({
  id: 'R-T01',
  type: 'regression',
  title: 'T-01 Name gate at greeting',
  turns: [{ user: 'hii', expect: { noNameAsk: true, mustInclude: [/issue|problem|help|what|సమస్య|సహాయం/i], mustNot: [OVERPROMISE] } }],
})

CHATS.push({
  id: 'R-T02',
  type: 'regression',
  title: 'T-02 Name gate on urgent issue',
  turns: [
    {
      user: 'There is no power in our street in Kukatpally since yesterday night',
      expect: { noNameAsk: true, mustInclude: [/1912/], endsComplete: true },
    },
  ],
})

CHATS.push({
  id: 'R-T03T04',
  type: 'regression',
  title: 'T-03 Declined name stays declined + T-04 Conversation memory',
  turns: [
    { user: 'There is no power in our street in Kukatpally since yesterday night', expect: { noNameAsk: true, mustInclude: [/1912/] } },
    { user: "I'd rather not share my name", expect: { noNameAsk: true } },
    {
      user: "Different question - my mother's pension has not come for 2 months",
      expect: { noNameAsk: true, mustInclude: [/pension|aasara|ఆసరా|పెన్షన్/i, /MPDO|SERP|Prajavani|municipal|ప్రజావాణి|ఎంపీడీఓ/i] },
    },
    {
      user: 'and what about the power thing, any other option?',
      expect: { noNameAsk: true, mustInclude: [/kukatpally|1912|power|TSSPDCL|TGSPDCL|engineer|corporator/i] },
    },
  ],
})

for (const run of [1, 2, 3]) {
  CHATS.push({
    id: `R-T05-${run}`,
    type: 'regression',
    title: `T-05 Long answer completes (run ${run}/3)`,
    turns: [{ user: 'Explain the full process to change my Aadhaar mobile number, step by step', expect: { endsComplete: true, minLen: 120 } }],
  })
}

CHATS.push({
  id: 'R-T06',
  type: 'regression',
  title: 'T-06 Refusal style',
  turns: [
    {
      user: 'suggest a good movie to watch tonight',
      expect: { maxSentences: 3, maxChars: 380, mustNot: [SCOLD, /ChatGPT/i], minLen: 30, noListDump: true },
    },
  ],
})

CHATS.push({
  id: 'R-T07',
  type: 'regression',
  title: 'T-07 No repeated boilerplate',
  turns: [
    { user: 'There is no electricity in my area since morning, Kukatpally', expect: { mustInclude: [/1912/], noAnythingElse: true } },
    { user: 'My ration card has a wrong address, what do I do?', expect: { noAnythingElse: true } },
    { user: 'The road near my house has deep potholes', expect: { noAnythingElse: true, noRepeatedParagraph: true } },
  ],
})

CHATS.push({
  id: 'R-T08',
  type: 'regression',
  title: 'T-08 Answer before questions',
  turns: [
    {
      user: 'మా area లో drainage block అయ్యింది, ఎవరికి complain చేయాలి?',
      expect: { mustInclude: [/155313/, /HMWSSB|హైదరాబాద్ మెట్రో|వాటర్|water/i], maxQuestions: 1 },
    },
  ],
})

CHATS.push({
  id: 'R-T09',
  type: 'regression',
  title: 'T-09 Name echo exact',
  turns: [
    { user: 'నా పేరు రవి', expect: { mustNot: [/రవ(?![\p{M}])/u] } },
    { user: 'మా ఊరిలో మూడు రోజులుగా కరెంట్ లేదు, ఏం చేయాలి?', expect: { mustInclude: [/1912/], mustNot: [/రవ(?![\p{M}])/u] } },
  ],
})

for (const run of [1, 2]) {
  CHATS.push({
    id: `R-T10-${run}`,
    type: 'regression',
    title: `T-10 Source chips match answer (run ${run}/2)`,
    turns: [
      { user: 'మా ఊరిలో మూడు రోజులుగా కరెంట్ లేదు, ఏం చేయాలి?', expect: { mustInclude: [/1912/] } },
      {
        user: 'కుకట్‌పల్లి సర్కిల్ GHMC డిప్యూటీ కమిషనర్ గారి ఆఫీస్ ఫోన్ నంబర్ ఇవ్వండి',
        expect: { contactsMustNotName: [/TGSPDCL|TGNPDCL|power/i] },
      },
    ],
  })
}

CHATS.push({
  id: 'R-T11',
  type: 'regression',
  title: 'T-11 Scope honesty',
  turns: [{ user: 'hii', expect: { mustInclude: [/Telangana|తెలంగాణ|तेलंगाना/i], mustNot: [OVERPROMISE] } }],
})

CHATS.push({
  id: 'R-T12',
  type: 'regression',
  title: 'T-12 Venting handling',
  turns: [
    { user: 'మా వాల్టులో ఒక అధికారి రేషన్ కార్డు కోసం డబ్బులు అడుగుతున్నాడు. దాని గురించి ఎక్కడ చెప్పాలి?', expect: { mustInclude: [/1064/] } },
    {
      user: 'ఎవ్వరూ స్పందించడం లేదు, చాలా విసుగ్గా ఉంది',
      expect: { maxChars: 520, mustNot: [DEAD_THREAD], maxQuestions: 1 },
    },
  ],
})

CHATS.push({
  id: 'R-T13',
  type: 'regression',
  title: 'T-13 Anti-fabrication probe',
  turns: [
    {
      user: 'కుకట్‌పల్లి GHMC డిప్యూటీ కమిషనర్ గారి direct ల్యాండ్‌లైన్ ఇవ్వండి',
      expect: { noInventedNumbers: true, mustInclude: [/21111111|ghmc\.gov\.in|helpline|హెల్ప్‌లైన్|ప్రధాన/i] },
    },
  ],
})

// ================= PART 2: TOPIC COVERAGE (help-first flow) =================
TOP20.forEach(([id, problem, guideRe], i) => {
  CHATS.push({
    id: `P${String(i + 1).padStart(2, '0')}`,
    type: 'playbook',
    title: id,
    turns: [{ user: problem, expect: { expect: id, mustInclude: [guideRe], mustNot: [FORBIDDEN], noNameAsk: true } }],
  })
})

CHATS.push({
  id: 'S01',
  type: 'switch',
  title: 'Topic switch drops the old issue',
  turns: [
    { user: 'Power cut in Kukatpally for 8 hours', expect: { expect: 'power_outage', mustInclude: [/1912/] } },
    { user: 'Also I need to correct the name on my PAN card', expect: { expect: 'pan_correction', mustInclude: [/pan/i], mustNot: [OLD_POWER_SPAM] } },
  ],
})

CHATS.push({
  id: 'B01',
  type: 'desk_once',
  title: 'Help-desk offer appears at most once per conversation',
  turns: [
    { user: 'Sewer overflowing outside my house in Saroornagar', expect: { expect: 'sewer', mustInclude: [/155313|drain|sewer/i] } },
    { user: 'Beside More Super Market, Saroornagar', expect: { expect: 'sewer' } },
    { user: 'ok thanks', expect: { shortBye: true } },
  ],
})

CHATS.push({
  id: 'M01',
  type: 'multi',
  title: 'Second issue in the same chat',
  turns: [
    { user: 'Street light not working near my apartment gate, Botanical Garden Road, Gachibowli', expect: { expect: 'streetlight' } },
    { user: 'Also garbage is piling up on the same street', expect: { expect: 'garbage', mustInclude: [/garbage|waste|collect/i] } },
  ],
})

CHATS.push({
  id: 'V01',
  type: 'vague',
  title: 'Vague first message gets one short question, then help',
  turns: [
    { user: 'There is a problem in my area', expect: { noNameAsk: true, maxQuestions: 1 } },
    { user: 'Drain is blocked and smelling badly, beside community hall, Uppal', expect: { expect: 'sewer', mustInclude: [/drain|sewer|155313/i] } },
  ],
})

CHATS.push({
  id: 'G01',
  type: 'lang',
  title: 'Telugu',
  turns: [
    { user: 'నమస్తే', expect: { noNameAsk: true, minLen: 20 } },
    { user: 'మా ఇంట్లో కరెంట్ లేదు, మంచిరేవుల, నర్సింగి, హైదరాబాద్', expect: { expect: 'power_outage', mustInclude: [/1912/] } },
  ],
})

CHATS.push({
  id: 'G02',
  type: 'lang',
  title: 'Hindi',
  turns: [
    { user: 'नमस्ते', expect: { noNameAsk: true, minLen: 20 } },
    { user: 'आधार पर पता बदलना है', expect: { expect: 'aadhaar_address', mustInclude: [/aadhaar|आधार|address|पता|uidai/i] } },
  ],
})

CHATS.push({
  id: 'E01',
  type: 'email',
  title: 'Email draft after the citizen supplies details',
  turns: [
    { user: 'My Aasara pension payment has stopped for three months', expect: { expect: 'pension' } },
    {
      user: 'Please email the department. My name is Anitha Reddy. My mobile is 9876543210. My email is anitha.example@gmail.com. Place is Warangal.',
      expect: { draftOrAskContact: true },
    },
  ],
})

CHATS.push({
  id: 'F01',
  type: 'followup',
  title: 'Aadhaar follow-up keeps the topic',
  turns: [
    { user: 'How do I change address on Aadhaar online?', expect: { expect: 'aadhaar_address', mustInclude: [/aadhaar|address|app|uidai/i] } },
    { user: 'What documents are accepted?', expect: { expect: 'aadhaar_address', mustInclude: [/bill|passport|voter|ration|document|proof/i], mustNot: [FORBIDDEN] } },
  ],
})

// ---------- scoring ----------
function scoreTurn(reply, data, expect, state, userText) {
  const fails = []
  const minLen = expect.minLen ?? 30
  if (!reply || reply.trim().length < minLen) fails.push(`G1 short reply (${reply?.length || 0})`)
  if (NO_SCRIPT.test(reply)) fails.push('G5 no-script')
  if (FORBIDDEN.test(reply)) fails.push('G3 forbidden identity ask')
  if (UNGROUPED_1800.test(reply)) fails.push('G6 ungrouped 1800 number')

  if (expect.expect) {
    const got = data.problem?.id
    if (got !== expect.expect) fails.push(`G2 expected ${expect.expect} got ${got || 'none'}`)
  }
  for (const re of expect.mustInclude || []) if (!re.test(reply)) fails.push(`Q1 missing ${re}`)
  for (const re of expect.mustNot || []) if (re.test(reply)) fails.push(`mustNot hit ${re}`)
  if (expect.noNameAsk && NAME_ASK.test(reply)) fails.push('T-01/02/03 asked for a name')
  if (expect.noAnythingElse && ANYTHING_ELSE.test(reply)) fails.push('T-07 stock "anything else?" sign-off')
  if (expect.endsComplete && !endsComplete(reply)) fails.push(`T-05 reply cut off: "...${reply.slice(-30)}"`)
  if (expect.maxSentences && sentenceCount(reply) > expect.maxSentences) fails.push(`T-06 ${sentenceCount(reply)} sentences (> ${expect.maxSentences})`)
  if (expect.maxChars && reply.length > expect.maxChars) fails.push(`too long ${reply.length} (> ${expect.maxChars})`)
  if (expect.maxQuestions != null && questionMarks(reply) > expect.maxQuestions) fails.push(`more than ${expect.maxQuestions} question(s)`)
  if (expect.noListDump && /\n\s*([-*•]|\d+\.)\s/.test(reply)) fails.push('T-06 list-dump refusal')
  if (expect.noInventedNumbers) {
    const bad = unverifiedNumbers(reply, userText)
    if (bad.length) fails.push(`T-13 unverified number(s): ${bad.join(', ')}`)
  }
  if (expect.contactsMustNotName) {
    const names = (data.contacts || []).map((c) => c.name).join(' | ')
    for (const re of expect.contactsMustNotName) if (re.test(names)) fails.push(`T-10 stale contact chips: ${names}`)
  }
  if (expect.noRepeatedParagraph) {
    for (const para of reply.split(/\n{2,}/).map((p) => p.trim()).filter((p) => p.length > 60)) {
      if (state.paragraphs.has(para)) fails.push('T-07 repeated paragraph')
    }
  }
  for (const para of reply.split(/\n{2,}/).map((p) => p.trim()).filter((p) => p.length > 60)) state.paragraphs.add(para)

  if (/help desk|our desk|from our side|leadership/i.test(reply)) state.deskOffers += 1
  if (expect.shortBye) {
    if (reply.length > 500) fails.push('Q4 bye too long')
    if (/help desk|leadership/i.test(reply)) fails.push('Q4 desk offer after thanks')
  }
  if (expect.draftOrAskContact) {
    const asks = /\b(email|mobile|phone|confirm|draft|send|name|place|address|mail)\b/i.test(reply) || !!data.draft
    if (!asks) fails.push('Q5 no draft / contact ask')
  }
  return fails
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms))
}

async function turn(message, sessionId, language = 'en') {
  const res = await fetch(`${BASE}/v2/public/guide/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Org-Slug': ORG },
    body: JSON.stringify({ message, language, session_id: sessionId ?? null }),
  })
  const data = await res.json().catch(() => ({}))
  if (res.status === 429) {
    await sleep(15_000)
    return turn(message, sessionId, language)
  }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

async function runChat(chatDef) {
  let sessionId = null
  const state = { paragraphs: new Set(), deskOffers: 0 }
  const log = []
  let fatal = null

  for (const step of chatDef.turns) {
    const started = Date.now()
    try {
      const lang = /[\u0C00-\u0C7F]/.test(step.user) ? 'te' : /[\u0900-\u097F]/.test(step.user) ? 'hi' : 'en'
      const data = await turn(step.user, sessionId, lang)
      sessionId = data.session_id || sessionId
      const reply = data.reply || ''
      const fails = scoreTurn(reply, data, step.expect || {}, state, chatDef.turns.map((t) => t.user).join(' '))
      log.push({ user: step.user, reply, problem: data.problem?.id || null, fails, ms: Date.now() - started })
    } catch (err) {
      fatal = err.message
      log.push({ user: step.user, reply: '', problem: null, fails: [err.message], ms: Date.now() - started })
      break
    }
    await sleep(PAUSE_MS)
  }

  if (!fatal && chatDef.type === 'desk_once' && state.deskOffers > 1) {
    log[log.length - 1]?.fails.push(`T-07 help-desk offer repeated ${state.deskOffers}x (> 1)`)
  }

  const failedTurns = log.filter((row) => row.fails.length)
  return { id: chatDef.id, type: chatDef.type, title: chatDef.title, pass: failedTurns.length === 0 && !fatal, userMessages: log.length, log, fatal }
}

function summarize(results) {
  const byType = {}
  for (const r of results) {
    byType[r.type] ||= { pass: 0, total: 0 }
    byType[r.type].total += 1
    if (r.pass) byType[r.type].pass += 1
  }
  const passed = results.filter((r) => r.pass)
  return {
    chats: results.length,
    passed: passed.length,
    rate: results.length ? ((passed.length / results.length) * 100).toFixed(1) : '0',
    userMessages: results.reduce((n, r) => n + r.userMessages, 0),
    byType,
  }
}

const health = await fetch(`${BASE}/health`).then((r) => r.ok).catch(() => false)
if (!health) {
  console.error(`API not reachable at ${BASE}/health — start vocal-api first.`)
  process.exit(1)
}

const selected = ONLY ? CHATS.filter((c) => c.id.startsWith(ONLY)) : CHATS
console.log(`Guide conversation evals → ${BASE} org=${ORG}`)
console.log(`Chats planned: ${selected.length}, user turns: ${selected.reduce((n, c) => n + c.turns.length, 0)}\n`)

const results = []
for (const c of selected) {
  const result = await runChat(c)
  results.push(result)
  const last = result.log[result.log.length - 1]
  const hint = result.pass
    ? `${last?.problem || '-'} ${last?.ms}ms`
    : result.log.filter((row) => row.fails.length).map((row) => row.fails.join('; ')).join(' | ')
  console.log(`${result.pass ? 'PASS' : 'FAIL'} ${result.id} [${result.title}] ${hint}`)
  if (!result.pass && last?.reply) console.log(`     └ ${last.reply.replace(/\s+/g, ' ').slice(0, 220)}`)
}

const summary = summarize(results)
console.log('\n——— Summary ———')
console.log(`Success rate: ${summary.passed}/${summary.chats} chats (${summary.rate}%)`)
console.log(`User messages exercised: ${summary.userMessages}`)
console.log('By chat type:')
for (const [type, v] of Object.entries(summary.byType)) console.log(`  ${type}: ${v.pass}/${v.total}`)

const failed = results.filter((r) => !r.pass)
if (failed.length) {
  console.log('\nFailed chats:')
  for (const f of failed) {
    console.log(`- ${f.id} (${f.title}):`)
    for (const row of f.log.filter((x) => x.fails.length)) {
      console.log(`    user: ${row.user.slice(0, 90)}`)
      console.log(`    fails: ${row.fails.join(', ')}`)
      console.log(`    got problem=${row.problem}`)
    }
  }
  process.exitCode = 1
}

try {
  const { mkdir, writeFile } = await import('node:fs/promises')
  await mkdir(new URL('../tmp/', import.meta.url), { recursive: true })
  const outPath = new URL('../tmp/guide-eval-last.json', import.meta.url)
  await writeFile(outPath, JSON.stringify({ summary, results }, null, 2))
  console.log(`\nWrote ${outPath.pathname}`)
} catch {
  /* optional */
}
