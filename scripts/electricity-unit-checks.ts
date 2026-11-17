/**
 * Offline checks for Bharosa electricity features + manager 17 Nov regression.
 *
 *   npx tsx scripts/electricity-unit-checks.ts
 */
import assert from 'node:assert/strict'
import { explainAllCharges } from '../src/modules/bharosa/electricity/charges.js'
import {
  estimateNextBill,
  estimateSentence,
  forecastEnabled,
  mergeHistoryForService,
  normalizeServiceNo,
  usageChangeSentence,
} from '../src/modules/bharosa/electricity/billMath.js'
import { applyBillCorrection, parseBillOcrJson, parseBillTextFallback } from '../src/modules/bharosa/electricity/billOcr.js'
import {
  detectsBillFeature,
  detectsConnectionFeature,
  handleElectricityTurn,
} from '../src/modules/bharosa/electricity/flow.js'
import { canonicalizeLabel, explainFromKb, matchKbRecord } from '../src/modules/bharosa/electricity/kb.js'
import { answerChargeQuestion, buildFirstBillReply, userFacingField } from '../src/modules/bharosa/electricity/kbExplain.js'
import {
  findNearestPole,
  isInsideTelangana,
  parseConnectionType,
  parseLoadKw,
  suggestLoadFromAppliances,
} from '../src/modules/bharosa/electricity/newConnection.js'
import { matchPlaybook } from '../src/modules/bharosa/guide/playbooks.js'
import {
  SPECIMEN_DOMESTIC_A,
  SPECIMEN_DOMESTIC_B,
  SPECIMEN_SYNTHETIC_240_PREV,
  SPECIMEN_SYNTHETIC_280,
} from './fixtures/tgspdcl-public-bills.js'

let passed = 0
function check(label: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1
      console.log(`ok   ${label}`)
    })
    .catch((err) => {
      console.error(`FAIL ${label}\n     ${err instanceof Error ? err.message : err}`)
      process.exitCode = 1
    })
}

async function main() {
  await check('detects bill / connection phrases', () => {
    assert.equal(detectsBillFeature('Explain my electricity bill'), true)
    assert.equal(detectsConnectionFeature('New electricity connection'), true)
  })

  await check('playbook hints', () => {
    assert.equal(matchPlaybook('Explain my electricity bill')?.playbook.id, 'power_bill_explain')
    assert.equal(matchPlaybook('New electricity connection')?.playbook.id, 'power_new_connection')
  })

  // ---- TC-02b: ED vs ED INTEREST never share wording ----
  await check('TC-02b ED and ED INTEREST are separate KB records', () => {
    const duty = matchKbRecord('ELECTRICITY DUTY')
    const edint = matchKbRecord('ED INTEREST')
    const edint2 = matchKbRecord('EDINT')
    assert.equal(duty?.id, 'kb-electricity-duty')
    assert.equal(edint?.id, 'kb-ed-interest')
    assert.equal(edint2?.id, 'kb-ed-interest')
    assert.notEqual(duty!.id, edint!.id)
    const dBody = explainFromKb('ELECTRICITY DUTY', 4.98, 'en').body
    const iBody = explainFromKb('ED INTEREST', 0.03, 'en').body
    assert.match(iBody, /interest/i)
    assert.ok(!/main charge for the electricity units/i.test(iBody))
    assert.ok(dBody !== iBody)
  })

  // ---- TC-03: label flicker canonicalization ----
  await check('TC-03 BCD/RCD SURCHARGES canonicalize toward ACD', () => {
    assert.equal(canonicalizeLabel('BCD SURCHARGES'), 'ACD SURCHARGES')
    assert.equal(canonicalizeLabel('RCD SURCHARGES'), 'ACD SURCHARGES')
    assert.equal(matchKbRecord('ACD SURCHARGES')?.id, 'kb-acd-surcharges')
    // Must NOT inherit ACD DUE deposit wording
    const body = explainFromKb('ACD SURCHARGES', 10, 'en').body
    assert.match(body, /not available|printed|will not invent/i)
    assert.ok(!/additional consumption deposit \(ACD\) due/i.test(body))
  })

  // ---- Public domestic specimen parse ----
  await check('public domestic specimen A parses with key lines', () => {
    const r = parseBillTextFallback(SPECIMEN_DOMESTIC_A)
    assert.ok(r)
    assert.equal(r!.units, 83)
    assert.equal(r!.total_inr, 302)
    assert.ok(r!.charges.some((c) => /ENERGY/i.test(c.label)))
    assert.ok(r!.charges.some((c) => /ELECTRICITY DUTY|DUTY/i.test(c.label)))
    assert.ok(r!.charges.some((c) => /ED INTEREST|INTEREST ON ED/i.test(c.label)))
    assert.ok(r!.charges.some((c) => /GRUHA|SUBSIDY/i.test(c.label)))
    assert.ok(r!.charges.some((c) => /SURCHARGE/i.test(c.label)))
  })

  await check('public domestic specimen B parses', () => {
    const r = parseBillTextFallback(SPECIMEN_DOMESTIC_B)
    assert.ok(r)
    assert.equal(r!.units, 70)
    assert.equal(r!.service_no, '102629545')
  })

  await check('SUBSIDY never equated to Gruha Jyothi', () => {
    const sub = explainFromKb('SUBSIDY', 100, 'en')
    assert.match(sub.body, /never|not|printed|credit/i)
    assert.ok(!/eligible|scheme rules/i.test(sub.body))
    const gj = explainFromKb('GRUHA JYOTHI SUBSIDY', 244, 'en')
    assert.equal(matchKbRecord('GRUHA JYOTHI')?.id, 'kb-gruha-jyothi')
    assert.ok(gj.body.includes('244') || /Gruha|subsidy/i.test(gj.body))
  })

  await check('true-up disabled: amount shown, no rates', () => {
    const ex = explainFromKb('TRUE-UP CHARGES', 50, 'en')
    assert.equal(ex.status, 'disabled')
    assert.match(ex.body, /50|TRUE-UP|true-up/i)
    assert.ok(!/30 paise|50 paise|two and a half years/i.test(ex.body))
  })

  // ---- TC-04: correction keeps other values; no internal keys ----
  await check('TC-04 Fix units keeps total and charges; user-facing field names', async () => {
    assert.equal(userFacingField('total_inr', 'en'), 'total')
    assert.ok(!userFacingField('total_inr', 'en').includes('_'))

    const start = await handleElectricityTurn({ state: null, lang: 'en', text: 'Explain my electricity bill' })
    const read = await handleElectricityTurn({
      state: start!.state,
      lang: 'en',
      text: SPECIMEN_SYNTHETIC_280,
    })
    assert.equal(read!.ui?.stage, 'confirm')
    assert.match(read!.reply, /280/)
    assert.match(read!.reply, /1773|1636/)
    assert.ok(!/total_inr/.test(read!.reply))

    const fixed = await handleElectricityTurn({
      state: read!.state,
      lang: 'en',
      text: 'Fix units 1263',
    })
    assert.match(fixed!.reply, /1263/)
    assert.match(fixed!.reply, /1773|1636/) // other values kept
    assert.ok(!/total_inr/.test(fixed!.reply))
  })

  // ---- TC-07b: different service numbers never merge ----
  await check('TC-07b different service numbers blocked', async () => {
    const start = await handleElectricityTurn({ state: null, lang: 'en', text: 'Explain my electricity bill' })
    const a = await handleElectricityTurn({ state: start!.state, lang: 'en', text: SPECIMEN_DOMESTIC_A })
    const ok = await handleElectricityTurn({ state: a!.state, lang: 'en', text: 'Correct' })
    assert.equal(ok!.ui?.stage, 'explained')

    const b = await handleElectricityTurn({ state: ok!.state, lang: 'en', text: SPECIMEN_DOMESTIC_B })
    assert.equal(b!.ui?.stage, 'confirm')
    const tryMerge = await handleElectricityTurn({ state: b!.state, lang: 'en', text: 'Correct' })
    assert.match(tryMerge!.reply, /will not merge|different service/i)
    assert.ok(tryMerge!.state && 'pending_foreign' in tryMerge!.state && tryMerge!.state.pending_foreign)
  })

  await check('mergeHistoryForService rejects cross-account', () => {
    const r = mergeHistoryForService(
      [{ period: 'Dec 2024', units: 83, total_inr: 302, service_no: '103813630' }],
      '103813630',
      { period: 'Feb 2026', units: 70, total_inr: 244, service_no: '102629545' },
    )
    assert.equal(r.ok, false)
  })

  await check('normalizeServiceNo strips spaces', () => {
    assert.equal(normalizeServiceNo('0101 10622'), '010110622')
  })

  // ---- Forecast off by default (TC-07) ----
  await check('TC-07 forecast disabled by default; past bills shown', async () => {
    assert.equal(forecastEnabled(), false)
    assert.equal(estimateNextBill([
      { period: 'a', units: 1, total_inr: 100, service_no: '1' },
      { period: 'b', units: 2, total_inr: 200, service_no: '1' },
      { period: 'c', units: 3, total_inr: 300, service_no: '1' },
    ]), null)

    const start = await handleElectricityTurn({ state: null, lang: 'en', text: 'Explain my electricity bill' })
    const prev = await handleElectricityTurn({ state: start!.state, lang: 'en', text: SPECIMEN_SYNTHETIC_240_PREV })
    const prevOk = await handleElectricityTurn({ state: prev!.state, lang: 'en', text: 'Correct' })
    const curr = await handleElectricityTurn({ state: prevOk!.state, lang: 'en', text: SPECIMEN_SYNTHETIC_280 })
    const done = await handleElectricityTurn({ state: curr!.state, lang: 'en', text: 'Correct' })
    assert.match(done!.reply, /not showing a next-bill forecast|validated/i)
    assert.ok(!/Probably between Rs/i.test(done!.reply))
  })

  // ---- First-message shape + no complaint ----
  await check('first-message shape and no complaint offer', async () => {
    const start = await handleElectricityTurn({ state: null, lang: 'en', text: 'Explain my electricity bill' })
    const read = await handleElectricityTurn({ state: start!.state, lang: 'en', text: SPECIMEN_SYNTHETIC_280 })
    const done = await handleElectricityTurn({ state: read!.state, lang: 'en', text: 'Correct' })
    assert.match(done!.reply, /Amount to pay|1773/i)
    assert.match(done!.reply, /energy charges|280 units/i)
    assert.match(done!.reply, /does not file or follow up a complaint/i)

    const complaint = await handleElectricityTurn({
      state: done!.state,
      lang: 'en',
      text: 'Please file a complaint and follow up',
    })
    assert.match(complaint!.reply, /do not file|1912/i)
  })

  await check('RT-02 mid-confirm charge question resumes', async () => {
    const start = await handleElectricityTurn({ state: null, lang: 'en', text: 'Explain my electricity bill' })
    const read = await handleElectricityTurn({ state: start!.state, lang: 'en', text: SPECIMEN_SYNTHETIC_280 })
    const q = await handleElectricityTurn({ state: read!.state, lang: 'en', text: 'What is fixed charge?' })
    assert.match(q!.reply, /fixed|connection load|monthly/i)
    assert.match(q!.reply, /Correct|Fix/i)
    assert.equal(q!.ui?.stage, 'confirm')
  })

  await check('RT-04 non-bill deflection keeps state', async () => {
    const start = await handleElectricityTurn({ state: null, lang: 'en', text: 'Explain my electricity bill' })
    const read = await handleElectricityTurn({ state: start!.state, lang: 'en', text: SPECIMEN_SYNTHETIC_280 })
    const deflect = await handleElectricityTurn({ state: read!.state, lang: 'en', text: 'Change my Aadhaar mobile number' })
    assert.match(deflect!.reply, /only help you understand your current electricity bill/i)
    assert.ok(deflect!.state && 'reading' in deflect!.state && deflect!.state.reading)
  })

  await check('Telugu base language for bill start and unclear photo copy', async () => {
    const start = await handleElectricityTurn({
      state: null,
      lang: 'te',
      text: 'నా కరెంట్ బిల్లు అర్థం చేసుకోవాలి',
    })
    assert.match(start!.reply, /[\u0C00-\u0C7F]/)
    assert.ok(!/Please send a clear photo of the bill/.test(start!.reply))
  })

  await check('OCR JSON never invents units; wrong doc flagged', () => {
    const reading = parseBillOcrJson({
      is_electricity_bill: true,
      units: null,
      total_inr: 1000,
      charges: [],
      unclear_fields: ['units'],
    })
    assert.equal(reading.units, null)
    assert.ok(reading.unclear_fields.includes('units') || reading.unclear_fields.includes('total'))
    assert.equal(parseBillOcrJson({ is_electricity_bill: false }).not_a_bill, true)
  })

  await check('connection limited form still works', async () => {
    assert.equal(isInsideTelangana({ lat: 17.44, lng: 78.39 }), true)
    assert.equal(findNearestPole({ lat: 17.44, lng: 78.39 }).available, false)
    assert.equal(parseLoadKw('2 kW'), 2)
    assert.equal(parseConnectionType('home'), 'home')
    assert.ok(suggestLoadFromAppliances('fan fridge TV'))

    const start = await handleElectricityTurn({ state: null, lang: 'en', text: 'New electricity connection' })
    const withLoc = await handleElectricityTurn({
      state: start!.state,
      lang: 'en',
      text: 'home',
      location: { lat: 17.4435, lng: 78.391, label: 'Madhapur' },
    })
    const withLoad = await handleElectricityTurn({ state: withLoc!.state, lang: 'en', text: '2 kW' })
    const result = await handleElectricityTurn({ state: withLoad!.state, lang: 'en', text: 'Correct' })
    assert.match(result!.reply, /do not have pole data|not invent/i)
  })

  await check('buildFirstBillReply uses printed amounts only', () => {
    const reading = parseBillTextFallback(SPECIMEN_SYNTHETIC_280)!
    const reply = buildFirstBillReply({ reading, history: [], lang: 'en' })
    assert.match(reply, /1773/)
    assert.match(reply, /280/)
    assert.match(reply, /1636/)
  })

  await check('charge question helper', () => {
    const reading = parseBillTextFallback(SPECIMEN_SYNTHETIC_280)!
    const ans = answerChargeQuestion('What is fixed charge?', reading, 'en', true)
    assert.ok(ans)
    assert.match(ans!, /fixed|load/i)
  })

  await check('corrections API keeps sibling fields', () => {
    const base = parseBillTextFallback(SPECIMEN_SYNTHETIC_280)!
    const next = applyBillCorrection(base, 'units', '1263')
    assert.equal(next.units, 1263)
    assert.equal(next.total_inr, base.total_inr)
    assert.equal(next.charges.length, base.charges.length)
  })

  await check('usage sentence with one month', () => {
    assert.match(
      usageChangeSentence([{ period: 'Sep', units: 1, total_inr: 1, service_no: '1' }], 'en'),
      /Only one bill/i,
    )
    assert.match(estimateSentence(null, 'en'), /cannot estimate|not showing|previous bills/i)
  })

  await check('unknown charge refuses invention', () => {
    const unknown = explainAllCharges([{ label: 'XYZ Special Levy', amount_inr: 10, clear: true }], 'en', 182)
    assert.match(unknown, /not sure|electricity office/i)
  })

  console.log(`\n${passed} checks passed`)
}

main()
