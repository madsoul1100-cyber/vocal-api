/**
 * Offline checks for Bharosa electricity features (no DB / optional LLM).
 *
 *   npx tsx scripts/electricity-unit-checks.ts
 */
import assert from 'node:assert/strict'
import { explainAllCharges, matchCharge } from '../src/modules/bharosa/electricity/charges.js'
import {
  chartAscii,
  estimateNextBill,
  estimateSentence,
  mergeHistory,
  MIN_HISTORY_FOR_ESTIMATE,
  usageChangeSentence,
} from '../src/modules/bharosa/electricity/billMath.js'
import { applyBillCorrection, parseBillOcrJson, parseBillTextFallback } from '../src/modules/bharosa/electricity/billOcr.js'
import {
  detectsBillFeature,
  detectsConnectionFeature,
  handleElectricityTurn,
} from '../src/modules/bharosa/electricity/flow.js'
import {
  findNearestPole,
  isInsideTelangana,
  parseConnectionType,
  parseLoadKw,
  suggestLoadFromAppliances,
} from '../src/modules/bharosa/electricity/newConnection.js'
import { matchPlaybook } from '../src/modules/bharosa/guide/playbooks.js'

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
  await check('detects bill feature phrases', () => {
    assert.equal(detectsBillFeature('Explain my electricity bill'), true)
    assert.equal(detectsBillFeature('నా కరెంట్ బిల్లు అర్థం చేసుకోవాలి'), true)
    assert.equal(detectsBillFeature('No electricity in my area'), false)
  })

  await check('detects new connection phrases', () => {
    assert.equal(detectsConnectionFeature('New electricity connection'), true)
    assert.equal(detectsConnectionFeature('కొత్త కరెంట్ కనెక్షన్'), true)
    assert.equal(detectsConnectionFeature('Understand my electricity bill'), false)
  })

  await check('playbook hints route to new electricity playbooks', () => {
    assert.equal(matchPlaybook('Explain my electricity bill')?.playbook.id, 'power_bill_explain')
    assert.equal(matchPlaybook('New electricity connection')?.playbook.id, 'power_new_connection')
  })

  await check('parse typed bill values without guessing', () => {
    const reading = parseBillTextFallback(
      'units 182 total 1450 period Sep 2026 Energy charges: 980 Fixed charges: 120 Electricity duty: 50',
    )
    assert.ok(reading)
    assert.equal(reading!.units, 182)
    assert.equal(reading!.total_inr, 1450)
    assert.equal(reading!.billing_period, 'Sep 2026')
    assert.equal(reading!.charges.length, 3)
    assert.equal(reading!.unclear_fields.length, 0)
  })

  await check('OCR JSON marks unclear fields and never invents units', () => {
    const reading = parseBillOcrJson({
      is_electricity_bill: true,
      units: null,
      total_inr: 1000,
      charges: [],
      unclear_fields: ['units'],
    })
    assert.equal(reading.units, null)
    assert.ok(reading.unclear_fields.includes('units'))
  })

  await check('wrong document flagged', () => {
    const reading = parseBillOcrJson({ is_electricity_bill: false, units: 10, total_inr: 1 })
    assert.equal(reading.not_a_bill, true)
  })

  await check('corrections update units', () => {
    const base = parseBillTextFallback('units 100 total 900 period Aug 2026')!
    const next = applyBillCorrection(base, 'units', '182')
    assert.equal(next.units, 182)
  })

  await check('charge glossary explains known lines and refuses unknown', () => {
    assert.ok(matchCharge('Energy Charges'))
    const known = explainAllCharges(
      [{ label: 'Energy Charges', amount_inr: 980, clear: true }],
      'en',
      182,
    )
    assert.match(known, /main charge|units/i)
    const unknown = explainAllCharges([{ label: 'XYZ Special Levy', amount_inr: 10, clear: true }], 'en', 182)
    assert.match(unknown, /not sure|electricity office/i)
  })

  await check('usage sentence and no estimate with one month', () => {
    const one = [{ period: 'Sep 2026', units: 182, total_inr: 1450 }]
    assert.match(usageChangeSentence(one, 'en'), /Only one bill/i)
    assert.equal(estimateNextBill(one), null)
    assert.match(estimateSentence(null, 'en'), /cannot estimate/i)
  })

  await check('estimate is a labelled range with enough history', () => {
    assert.ok(MIN_HISTORY_FOR_ESTIMATE >= 2)
    const hist = mergeHistory(
      [
        { period: 'Aug 2026', units: 147, total_inr: 1100 },
        { period: 'Sep 2026', units: 182, total_inr: 1450 },
      ],
      { period: 'Oct 2026', units: 160, total_inr: 1300 },
    )
    const est = estimateNextBill(hist)
    assert.ok(est)
    assert.equal(est!.labelled, true)
    assert.ok(est!.high_inr >= est!.low_inr)
    assert.match(estimateSentence(est, 'en'), /estimate/i)
    assert.match(usageChangeSentence(hist, 'en'), /units/i)
    assert.ok(chartAscii(hist).includes('units'))
  })

  await check('Telangana bounds and pole data absent by default', () => {
    assert.equal(isInsideTelangana({ lat: 17.44, lng: 78.39 }), true)
    assert.equal(isInsideTelangana({ lat: 28.61, lng: 77.2 }), false) // Delhi
    const pole = findNearestPole({ lat: 17.44, lng: 78.39 })
    assert.equal(pole.available, false)
    assert.match(pole.note, /not loaded|approved/i)
  })

  await check('load and type parsers + appliance suggestion', () => {
    assert.equal(parseLoadKw('I need 2 kW'), 2)
    assert.equal(parseConnectionType('home connection'), 'home')
    assert.equal(parseConnectionType('shop'), 'shop')
    const sug = suggestLoadFromAppliances('fan fridge TV lights')
    assert.ok(sug)
    assert.ok(sug!.kw >= 1)
    assert.match(sug!.explanation, /suggest|starting load|kW/i)
  })

  await check('bill flow: typed bill -> confirm -> explain, no invented next bill', async () => {
    const start = await handleElectricityTurn({
      state: null,
      lang: 'en',
      text: 'Explain my electricity bill',
    })
    assert.ok(start)
    assert.equal(start!.problem_id, 'power_bill_explain')
    assert.match(start!.reply, /photo|type the units/i)

    const read = await handleElectricityTurn({
      state: start!.state,
      lang: 'en',
      text: 'units 182 total 1450 period Sep 2026 Energy charges: 980 Fixed charges: 120',
    })
    assert.ok(read)
    assert.equal(read!.ui?.stage, 'confirm')
    assert.match(read!.reply, /182/)
    assert.match(read!.reply, /Correct/i)

    const done = await handleElectricityTurn({
      state: read!.state,
      lang: 'en',
      text: 'Correct',
    })
    assert.ok(done)
    assert.equal(done!.ui?.stage, 'explained')
    assert.match(done!.reply, /Energy|charge/i)
    assert.match(done!.reply, /cannot estimate|previous bills/i)
    assert.ok(!/next bill will be Rs \d+[^.]/i.test(done!.reply))
  })

  await check('bill flow: blurry / unclear asks to retake, does not invent units', async () => {
    // Force confirm path with missing units via partial typed input that still looks like a bill
    const start = await handleElectricityTurn({ state: null, lang: 'en', text: 'Explain my electricity bill' })
    const unclear = await handleElectricityTurn({
      state: start!.state,
      lang: 'en',
      text: 'total 1450 period Sep 2026 this is my electricity bill units unclear',
    })
    // May still parse or ask — never invent a specific units figure that wasn't provided
    assert.ok(unclear)
    if (unclear!.state && 'reading' in unclear!.state && unclear!.state.reading) {
      // If units missing, reply must ask / not pretend
      if (unclear!.state.reading.units == null) {
        assert.match(unclear!.reply, /could not read|type|photo|unclear|Fix|Correct/i)
      }
    }
  })

  await check('connection flow: location + type + load -> limited form without pole inventing', async () => {
    const start = await handleElectricityTurn({
      state: null,
      lang: 'en',
      text: 'New electricity connection',
    })
    assert.ok(start)
    assert.match(start!.reply, /location/i)

    const withLoc = await handleElectricityTurn({
      state: start!.state,
      lang: 'en',
      text: 'home',
      location: { lat: 17.4435, lng: 78.391, label: 'Madhapur' },
    })
    assert.ok(withLoc)
    // After location+type may ask load
    const withLoad = await handleElectricityTurn({
      state: withLoc!.state,
      lang: 'en',
      text: '2 kW',
    })
    assert.ok(withLoad)
    assert.match(withLoad!.reply, /Correct|2 kW|Home|Madhapur/i)

    const result = await handleElectricityTurn({
      state: withLoad!.state,
      lang: 'en',
      text: 'Correct',
    })
    assert.ok(result)
    assert.match(result!.reply, /do not have pole data|not invent|process|MeeSeva|1912/i)
    assert.ok(!/nearest suitable pole is DEMO/i.test(result!.reply))
    assert.ok(!/Your cost will be Rs \d+ exactly/i.test(result!.reply))
  })

  await check('connection flow: outside Telangana refuses estimate', async () => {
    const start = await handleElectricityTurn({
      state: null,
      lang: 'en',
      text: 'New electricity connection',
    })
    const out = await handleElectricityTurn({
      state: start!.state,
      lang: 'en',
      text: '',
      location: { lat: 28.6139, lng: 77.209, label: 'Delhi' },
    })
    assert.ok(out)
    assert.match(out!.reply, /outside the area/i)
    assert.equal(out!.state, null)
  })

  await check('final price question never confirmed as final', async () => {
    const start = await handleElectricityTurn({
      state: null,
      lang: 'en',
      text: 'New electricity connection',
    })
    const mid = await handleElectricityTurn({
      state: start!.state,
      lang: 'en',
      text: 'home',
      location: { lat: 17.44, lng: 78.39 },
    })
    const load = await handleElectricityTurn({ state: mid!.state, lang: 'en', text: '1 kW' })
    const ask = await handleElectricityTurn({
      state: load!.state,
      lang: 'en',
      text: 'Is this the final price?',
    })
    assert.ok(ask)
    assert.match(ask!.reply, /No\.|official amount after inspection/i)
  })

  await check('Telugu reply stays in Telugu for bill start', async () => {
    const start = await handleElectricityTurn({
      state: null,
      lang: 'te',
      text: 'నా కరెంట్ బిల్లు అర్థం చేసుకోవాలి',
    })
    assert.ok(start)
    assert.match(start!.reply, /[\u0C00-\u0C7F]/)
    assert.ok(!/Please send a clear photo of the bill/.test(start!.reply))
  })

  console.log(`\n${passed} checks passed`)
}

main()
