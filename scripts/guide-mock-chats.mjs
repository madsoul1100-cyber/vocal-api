/**
 * One fresh chat per Telangana help case.
 * Run while vocal-api is up: node scripts/guide-mock-chats.mjs
 */
const CASES = [
  ['aadhaar_mobile', 'I need to change the mobile number on my Aadhaar'],
  ['aadhaar_address', 'I need to change the address on my Aadhaar'],
  ['aadhaar_name_dob', 'My date of birth is wrong on my Aadhaar'],
  ['pan_correction', 'I need to correct the name on my PAN card'],
  ['voter_update', 'I need to update the address on my voter ID'],
  ['ration_card', 'I need a new ration card in Telangana'],
  ['transport_update', 'I need to update the address on my driving licence'],
  ['lpg', 'I need to transfer my LPG gas connection to Telangana'],
  ['certificates', 'I need a birth certificate from MeeSeva'],
  ['power_outage', 'There is no electricity in my area'],
  ['power_bill', 'My electricity meter bill is wrong and too high'],
  ['water_supply', 'There is no water supply in my area'],
  ['roads', 'The road near my house has potholes'],
  ['sewer', 'The sewer drain is blocked and overflowing'],
  ['garbage', 'Garbage is not being collected on my street'],
  ['streetlight', 'The street light outside my house is not working'],
  ['water_leak', 'A water pipe has burst and is leaking on the road'],
  ['pension', 'My Aasara pension payment has stopped'],
  ['manhole', 'The manhole cover is missing on my street'],
  ['encroachment', 'Illegal parking is blocking the road'],
]

const MAIL_ASK = 'Please email the department. My name is Ravi Kumar. My mobile is 9876543210. My email is ravi.example@gmail.com. Place is Hyderabad.'

async function turn(message, sessionId) {
  const res = await fetch('http://localhost:3001/v2/public/guide/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Org-Slug': 'demo' },
    body: JSON.stringify({ message, language: 'en', session_id: sessionId ?? null }),
  })
  const data = await res.json()
  if (res.status === 429) {
    await new Promise((resolve) => setTimeout(resolve, 20_000))
    return turn(message, sessionId)
  }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

function checks(row) {
  const reply = row.reply || ''
  const notes = []
  if (row.problem?.id !== row.expect) notes.push(`case ${row.problem?.id || 'none'}`)
  if (reply.length < 80) notes.push('reply too short')
  if (/do not have a telangana script|i do not have a script/i.test(reply)) notes.push('no script')
  if (!/anything else/i.test(reply)) notes.push('no follow-up offer')
  if (!/you can call|i will not invent a complaint email|you can also email/i.test(reply)) notes.push('no phone or mail offer')
  return notes
}

const rows = []
for (const [expect, message] of CASES) {
  const started = Date.now()
  try {
    const data = await turn(message)
    const row = {
      expect,
      problem: data.problem,
      reply: data.reply || '',
      contacts: (data.contacts || []).map((c) => [c.name, c.phone, c.email].filter(Boolean).join(' ')),
      ms: Date.now() - started,
    }
    row.notes = checks(row)
    rows.push(row)
    console.log(`${row.notes.length ? 'FAIL' : 'ok  '} ${expect} ${row.ms}ms ${row.notes.join('; ')}`)
    console.log(`     ${row.reply.replace(/\s+/g, ' ').slice(0, 180)}`)
  } catch (err) {
    rows.push({ expect, reply: '', notes: [err.message], ms: Date.now() - started, contacts: [] })
    console.log(`FAIL ${expect} ${err.message}`)
  }
}

async function mailCheck(label, opener) {
  const first = await turn(opener)
  const second = await turn(MAIL_ASK, first.session_id)
  const draft = second.draft
  console.log(`\n${label}`)
  console.log(`case ${second.problem?.id} status ${second.status}`)
  console.log(draft ? `draft to ${draft.to}` : 'no draft')
  console.log((second.reply || '').slice(-500))
}

await mailCheck('MAIL pension (published Prajavani address)', 'My Aasara pension payment has stopped')
await mailCheck('MAIL power cut (no published complaint inbox)', 'There is no electricity in my area')

const failed = rows.filter((row) => row.notes.length)
console.log(`\n${rows.length - failed.length}/${rows.length} cases passed`)
if (failed.length) {
  console.log(failed.map((row) => `${row.expect}: ${row.notes.join(', ')}`).join('\n'))
  process.exitCode = 1
}
