/**
 * Multi-turn Priya Guide evals — aligned to soft ladder (name → problem → area → help).
 * Docs: docs/GUIDE_TEST_CASES.md
 *
 *   node scripts/guide-conversation-evals.mjs
 */
const BASE = process.env.GUIDE_BASE || 'http://localhost:3001'
const ORG = process.env.GUIDE_ORG || 'demo'
const PAUSE_MS = Number(process.env.GUIDE_PAUSE_MS || 3200)

const FORBIDDEN =
  /\b(send (me )?otp|what is your (aadhaar|pan|otp|bank|password)|enter your (aadhaar|pan) number|share (your )?otp)\b/i
const NO_SCRIPT = /do not have a telangana script|i do not have a script/i
const NAME_ASK = /\b(name|call you|what (should|can) i call|నా పేరు|మీ పేరు|పేరు|పిలవాలి|आपका नाम|नाम|कहूँ|कहुं)\b/i
const AREA_ASK = /\b(area|address|where|location|place|colony|locality|landmark|ప్రాంతం|చిరునామా|కాలనీ|ల్యాండ్|ఎక్కడ|इलाका|पता|कॉलोनी|कहाँ)\b/i
const PROBLEM_ASK = /\b(problem|issue|help|what (do you|can i)|tell me|need help|going on|సమస్య|సహాయం|ఏమి|समस्या|मदद|क्या)\b/i
const OLD_POWER_SPAM = /\b(1912|TSSPDCL|TGSPDCL|power cut|no electricity)\b/i

/** Local civic → need area after problem. Self-serve → no forced area. */
const LOCAL = new Set([
  'power_outage', 'power_bill', 'water_supply', 'roads', 'sewer', 'garbage',
  'streetlight', 'water_leak', 'manhole', 'encroachment',
])

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
  ['water_supply', 'There is no water supply in my area for two days', /water|1912|hmws|board|supply/i],
  ['roads', 'The road near my house has deep potholes', /road|pothole|ghmc|municip|1912|prajavani/i],
  ['sewer', 'The sewer drain is blocked and overflowing', /drain|sewer|1912|ghmc|overflow/i],
  ['garbage', 'Garbage is not being collected on my street', /garbage|waste|collect|ghmc|1912/i],
  ['streetlight', 'The street light outside my house is not working', /light|street|1912|ghmc|electric/i],
  ['water_leak', 'A water pipe has burst and is leaking on the road', /leak|pipe|water|1912|hmws/i],
  ['pension', 'My Aasara pension payment has stopped', /pension|aasara|prajavani|meeseva|welfare/i],
  ['manhole', 'The manhole cover is missing on my street', /manhole|1912|ghmc|cover|danger|safe/i],
  ['encroachment', 'Illegal parking is blocking the road near the market', /park|encroach|police|traffic|ghmc|1912/i],
]

const PLACES = [
  'H.No 12-5/3, Manchirevula colony, Narsingi, Hyderabad 500089',
  'Plot 8, OU Colony, Shaikpet, Hyderabad',
  'Lane 2 near community hall, Uppal, Hyderabad',
  'KPHB 5th phase, road no 4, Kukatpally',
  'Beside More Super Market, Saroornagar, LB Nagar',
]

const NAMES = ['Ravi', 'Lakshmi', 'Suresh', 'Fatima', 'Venkat', 'Anitha', 'Imran', 'Meena', 'Kiran', 'Priya']

/** @type {any[]} */
const CHATS = []

// —— 20 ladder chats (one per playbook): hi → name → problem → [area] → help ——
TOP20.forEach(([id, problem, guideRe], i) => {
  const name = NAMES[i % NAMES.length]
  const local = LOCAL.has(id)
  const place = PLACES[i % PLACES.length]
  /** @type {any[]} */
  const turns = [
    { user: i % 2 === 0 ? 'Hi' : 'Hello', expect: { askName: true } },
    { user: name, expect: { askProblem: true } },
    {
      user: problem,
      expect: local
        ? { expect: id, askArea: true }
        : { expect: id, noAreaPressure: true, mustInclude: [guideRe], mustNot: [FORBIDDEN] },
    },
  ]
  if (local) {
    turns.push({
      user: place,
      expect: { expect: id, mustInclude: [guideRe], dualClose: true },
    })
  }
  CHATS.push({
    id: `P${String(i + 1).padStart(2, '0')}`,
    type: local ? 'ladder_local' : 'ladder_self',
    persona: name,
    expectFinal: id,
    turns,
  })
})

// —— Behaviour chats ——
CHATS.push({
  id: 'S01',
  type: 'switch',
  persona: 'Kiran',
  expectFinal: 'pan_correction',
  turns: [
    { user: 'Hi', expect: { askName: true } },
    { user: 'Kiran', expect: { askProblem: true } },
    { user: 'Power cut in Kukatpally for 8 hours', expect: { expect: 'power_outage', askArea: true } },
    { user: 'Near KPHB 5th phase, road number 4', expect: { expect: 'power_outage', mustInclude: [/1912/i] } },
    {
      user: 'Also I need to correct the name on my PAN card',
      expect: {
        expect: 'pan_correction',
        mustInclude: [/pan/i],
        mustNot: [OLD_POWER_SPAM],
      },
    },
  ],
})

CHATS.push({
  id: 'B01',
  type: 'dual_once',
  persona: 'Venkat',
  expectFinal: 'sewer',
  turns: [
    { user: 'Hello', expect: { askName: true } },
    { user: 'Venkat', expect: { askProblem: true } },
    { user: 'Sewer overflowing outside my house', expect: { expect: 'sewer', askArea: true } },
    { user: 'Beside More Super Market, Saroornagar', expect: { expect: 'sewer', dualClose: true, mustInclude: [/1912|drain|sewer/i] } },
    { user: 'ok thanks', expect: { shortBye: true } },
  ],
})

CHATS.push({
  id: 'B02',
  type: 'bye',
  persona: 'Priya-user',
  expectFinal: 'garbage',
  turns: [
    { user: 'hi', expect: { askName: true } },
    { user: 'Meena', expect: { askProblem: true } },
    { user: 'Garbage not collected on my street', expect: { expect: 'garbage', askArea: true } },
    { user: 'Near Ramanthapur bus depot, Amberpet', expect: { expect: 'garbage' } },
    { user: 'thank you so much', expect: { shortBye: true } },
  ],
})

CHATS.push({
  id: 'M01',
  type: 'multi',
  persona: 'Lakshmi',
  expectFinal: 'garbage',
  turns: [
    { user: 'Hi', expect: { askName: true } },
    { user: 'Lakshmi', expect: { askProblem: true } },
    { user: 'Street light not working near my apartment gate', expect: { expect: 'streetlight', askArea: true } },
    { user: 'Botanical Garden Road, Gachibowli', expect: { expect: 'streetlight', mustInclude: [/light|1912|ghmc/i] } },
    {
      user: 'Also garbage is piling up on the same street',
      expect: { expect: 'garbage', mustInclude: [/garbage|waste|collect/i] },
    },
  ],
})

CHATS.push({
  id: 'V01',
  type: 'vague',
  persona: 'Suresh',
  expectFinal: 'sewer',
  turns: [
    { user: 'Hi', expect: { askName: true } },
    { user: 'Suresh', expect: { askProblem: true } },
    { user: 'There is a problem in my area', expect: { askProblem: true } },
    { user: 'Drain is blocked and smelling badly', expect: { expect: 'sewer', askArea: true } },
    { user: 'Beside community hall, Uppal', expect: { expect: 'sewer', mustInclude: [/drain|sewer|1912/i] } },
  ],
})

CHATS.push({
  id: 'G01',
  type: 'lang',
  persona: 'Suresh',
  expectFinal: 'power_outage',
  turns: [
    // Te/Hi ladder phrasing varies — score locked topic + official guidance
    { user: 'నమస్తే', expect: { minLen: 20 } },
    { user: 'సురేష్', expect: { minLen: 20 } },
    { user: 'మా ఇంట్లో కరెంట్ లేదు', expect: { expect: 'power_outage' } },
    {
      user: 'మంచిరేవుల, నర్సింగి, హైదరాబాద్',
      expect: { expect: 'power_outage', mustInclude: [/1912|కరెంట్|విద్యుత్|power|electric/i] },
    },
  ],
})

CHATS.push({
  id: 'G02',
  type: 'lang',
  persona: 'Anitha',
  expectFinal: 'aadhaar_address',
  turns: [
    { user: 'नमस्ते', expect: { minLen: 20 } },
    { user: 'अनीता', expect: { minLen: 20 } },
    {
      user: 'आधार पर पता बदलना है',
      expect: { expect: 'aadhaar_address', noAreaPressure: true, mustInclude: [/aadhaar|आधार|address|पता|uidai/i] },
    },
  ],
})

CHATS.push({
  id: 'E01',
  type: 'email',
  persona: 'Anitha',
  expectFinal: 'pension',
  turns: [
    { user: 'Hi', expect: { askName: true } },
    { user: 'Anitha', expect: { askProblem: true } },
    { user: 'My Aasara pension payment has stopped for three months', expect: { expect: 'pension' } },
    {
      user:
        'Please email the department. My name is Anitha Reddy. My mobile is 9876543210. My email is anitha.example@gmail.com. Place is Warangal.',
      expect: { draftOrAskContact: true },
    },
  ],
})

CHATS.push({
  id: 'E02',
  type: 'email',
  persona: 'Kiran',
  expectFinal: 'power_outage',
  turns: [
    { user: 'Hello', expect: { askName: true } },
    { user: 'Kiran', expect: { askProblem: true } },
    { user: 'No electricity in Bachupally since yesterday night', expect: { expect: 'power_outage', askArea: true } },
    { user: 'Bachupally, near Miyapur, Hyderabad', expect: { expect: 'power_outage', mustInclude: [/1912/i] } },
    {
      user:
        'Please email them. Name Kiran, mobile 9123456780, email kiran.test@gmail.com, place Bachupally Hyderabad',
      expect: { draftOrAskContact: true },
    },
  ],
})

CHATS.push({
  id: 'F01',
  type: 'followup',
  persona: 'Ravi',
  expectFinal: 'aadhaar_address',
  turns: [
    { user: 'Hi', expect: { askName: true } },
    { user: 'Ravi', expect: { askProblem: true } },
    { user: 'How do I change address on Aadhaar online?', expect: { expect: 'aadhaar_address', mustInclude: [/aadhaar|address|app|uidai/i] } },
    {
      user: 'What documents are accepted?',
      expect: { expect: 'aadhaar_address', mustInclude: [/bill|passport|voter|ration|document|proof/i], mustNot: [FORBIDDEN] },
    },
  ],
})

CHATS.push({
  id: 'F02',
  type: 'followup',
  persona: 'Ravi',
  expectFinal: 'aadhaar_mobile',
  turns: [
    { user: 'hi', expect: { askName: true } },
    { user: 'Ravi Kumar', expect: { askProblem: true } },
    { user: 'Change mobile on Aadhaar', expect: { expect: 'aadhaar_mobile' } },
    {
      user: 'Old number is lost, cannot get OTP',
      expect: { expect: 'aadhaar_mobile', mustInclude: [/centre|center|seva|1947/i], mustNot: [FORBIDDEN] },
    },
  ],
})

function countDualClose(reply) {
  const hits = reply.match(
    /help desk|raise (this|it|a complaint)|I can (also )?record|escalate|leadership|prajavani|forward (this|your)|record it here/gi,
  )
  return hits ? hits.length : 0
}

function scoreTurn(reply, data, expect, state) {
  const fails = []
  const minLen = expect.minLen ?? 40
  if (!reply || reply.trim().length < minLen) fails.push(`G1 short reply (${reply?.length || 0})`)
  if (NO_SCRIPT.test(reply)) fails.push('G5 no-script')
  if (FORBIDDEN.test(reply)) fails.push('G3 forbidden identity ask')

  if (expect.expect) {
    const got = data.problem?.id
    if (got !== expect.expect) fails.push(`G2 expected ${expect.expect} got ${got || 'none'}`)
  }
  for (const re of expect.mustInclude || []) {
    if (!re.test(reply)) fails.push(`Q1 missing ${re}`)
  }
  for (const re of expect.mustNot || []) {
    if (re.test(reply)) fails.push(`mustNot hit ${re}`)
  }
  if (expect.askName && !NAME_ASK.test(reply)) fails.push('L1 did not ask name')
  if (expect.askProblem && !PROBLEM_ASK.test(reply)) fails.push('L2 did not ask problem')
  if (expect.askArea && !AREA_ASK.test(reply)) fails.push('L3 did not ask area')
  if (expect.noAreaPressure) {
    const onlyArea =
      AREA_ASK.test(reply) &&
      !/aadhaar|pan|uidai|step|app|website|document|voter|ration|licen/i.test(reply) &&
      reply.length < 220
    if (onlyArea) fails.push('L4 forced area on self-serve')
  }
  if (expect.dualClose) {
    const n = countDualClose(reply)
    if (n > 0) state.dualClosesSoFar += 1
    if (!/1912|call|email|website|complaint|app|portal/i.test(reply)) fails.push('Q2 no official path')
  }
  if (expect.shortBye) {
    if (reply.length > 500) fails.push('Q4 bye too long')
    if (countDualClose(reply) > 0) fails.push('Q4 dual-path after thanks')
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
  const state = { dualClosesSoFar: 0 }
  const log = []
  let fatal = null

  for (const step of chatDef.turns) {
    const started = Date.now()
    try {
      const lang = /[\u0C00-\u0C7F]/.test(step.user) ? 'te' : /[\u0900-\u097F]/.test(step.user) ? 'hi' : 'en'
      const data = await turn(step.user, sessionId, lang)
      sessionId = data.session_id || sessionId
      const reply = data.reply || ''
      const fails = scoreTurn(reply, data, step.expect || {}, state)
      log.push({ user: step.user, reply, problem: data.problem?.id || null, fails, ms: Date.now() - started })
    } catch (err) {
      fatal = err.message
      log.push({ user: step.user, reply: '', problem: null, fails: [err.message], ms: Date.now() - started })
      break
    }
    await sleep(PAUSE_MS)
  }

  if (!fatal && chatDef.type === 'dual_once' && state.dualClosesSoFar > 1) {
    log[log.length - 1]?.fails.push(`Q2 dual-close ${state.dualClosesSoFar}× (>1)`)
  }

  const failedTurns = log.filter((row) => row.fails.length)
  return {
    id: chatDef.id,
    type: chatDef.type,
    persona: chatDef.persona,
    expectFinal: chatDef.expectFinal,
    pass: failedTurns.length === 0 && !fatal,
    userMessages: log.length,
    log,
    fatal,
  }
}

function summarize(results) {
  const totalMsgs = results.reduce((n, r) => n + r.userMessages, 0)
  const passed = results.filter((r) => r.pass)
  const byType = {}
  for (const r of results) {
    byType[r.type] ||= { pass: 0, total: 0 }
    byType[r.type].total += 1
    if (r.pass) byType[r.type].pass += 1
  }
  const playbookOk = results.filter((r) => r.id.startsWith('P') && r.pass).length
  return {
    chats: results.length,
    passed: passed.length,
    rate: results.length ? ((passed.length / results.length) * 100).toFixed(1) : '0',
    userMessages: totalMsgs,
    playbookLadderPass: `${playbookOk}/20`,
    byType,
  }
}

const health = await fetch(`${BASE}/health`).then((r) => r.ok).catch(() => false)
if (!health) {
  console.error(`API not reachable at ${BASE}/health — start vocal-api first.`)
  process.exit(1)
}

const plannedMsgs = CHATS.reduce((n, c) => n + c.turns.length, 0)
console.log(`Guide conversation evals → ${BASE} org=${ORG}`)
console.log(`Chats planned: ${CHATS.length}, user turns: ${plannedMsgs}\n`)

const results = []
for (const c of CHATS) {
  const result = await runChat(c)
  results.push(result)
  const mark = result.pass ? 'PASS' : 'FAIL'
  const last = result.log[result.log.length - 1]
  const hint = result.pass
    ? `${last?.problem || '-'} ${last?.ms}ms`
    : result.log.filter((row) => row.fails.length).map((row) => row.fails.join('; ')).join(' | ')
  console.log(`${mark} ${result.id} [${result.type}/${result.persona}] ${hint}`)
  if (!result.pass && last?.reply) {
    console.log(`     └ ${last.reply.replace(/\s+/g, ' ').slice(0, 180)}`)
  }
}

const summary = summarize(results)
console.log('\n——— Summary ———')
console.log(`Success rate: ${summary.passed}/${summary.chats} chats (${summary.rate}%)`)
console.log(`Top-20 ladder pass: ${summary.playbookLadderPass}`)
console.log(`User messages exercised: ${summary.userMessages}`)
console.log('By chat type:')
for (const [type, v] of Object.entries(summary.byType)) {
  console.log(`  ${type}: ${v.pass}/${v.total}`)
}

const failed = results.filter((r) => !r.pass)
if (failed.length) {
  console.log('\nFailed chats:')
  for (const f of failed) {
    console.log(`- ${f.id} (${f.type}):`)
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
