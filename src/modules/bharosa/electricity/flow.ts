/**
 * Multi-turn electricity features for the Bharosa guide.
 * Feature 1: understand bill · Feature 2: new connection cost (limited without pole data)
 */

import type { GuideLang } from '../guide/playbooks.js'
import { explainAllCharges } from './charges.js'
import {
  chartAscii,
  estimateNextBill,
  estimateSentence,
  mergeHistory,
  readingToHistoryPoint,
  usageChangeSentence,
} from './billMath.js'
import { applyBillCorrection, parseBillTextFallback, readBillFromImage, readBillFromText } from './billOcr.js'
import {
  BILL_ACTIONS,
  CONNECTION_TYPE_ACTIONS,
  ECOPY,
} from './copy.js'
import {
  CONNECTION_CONTACTS,
  estimateConnectionCost,
  findNearestPole,
  isInsideTelangana,
  materialsForConnection,
  nextStepsCopy,
  parseConnectionType,
  parseLoadKw,
  parseLocationFromText,
  suggestLoadFromAppliances,
} from './newConnection.js'
import type {
  BillFlowState,
  BillReading,
  ConnectionFlowState,
  ConnectionKind,
  ElectricityState,
  ElectricityTurnResult,
  ElectricityUiPayload,
  GeoPoint,
} from './types.js'

const BILL_START =
  /\b(understand|explain|read|analyse|analyze)\b.{0,40}\b(bill|electricity bill|power bill)\b|\b(bill)\b.{0,20}\b(photo|explain|understand)\b|బిల్లు\s*(అర్థం|వివర|ఫోటో)|बिल\s*(समझ|फ़ोटो|फोटो|व्याख्या)|explain my (electricity )?bill|analyse my bill|analyze my bill/i

const CONNECTION_START =
  /\bnew\s+(electricity\s+)?connection\b|\bconnection\s+cost\b|\bnew\s+power\s+connection\b|కొత్త\s*(కరెంట్\s*)?కనెక్షన్|नया\s*(बिजली\s*)?कनेक्शन|new connection/i

const CANCEL = /^\s*(cancel|stop|exit|quit|never\s*mind|వద్దు|रद्द|बस)\s*$/i
const CORRECT = /^\s*(correct|yes|looks?\s*good|సరియైంది|సరే|सही|ठीक\s*है)\s*[!.]*\s*$/i
const FIX = /^\s*(fix|change|update|సరిదిద్దు|सुधार)\b/i
const FINAL_PRICE = /final\s*price|exact\s*(price|amount|cost)|అంతిమ\s*ధర|अंतिम\s*(कीमत|राशि)/i

export function detectsBillFeature(text: string): boolean {
  return BILL_START.test(text)
}

export function detectsConnectionFeature(text: string): boolean {
  return CONNECTION_START.test(text)
}

export function isElectricityActive(state: ElectricityState | null | undefined): boolean {
  return !!state?.feature
}

function emptyBillState(): BillFlowState {
  return {
    feature: 'bill',
    stage: 'await_photo',
    reading: null,
    confirmed: null,
    history: [],
    fix_field: null,
  }
}

function emptyConnectionState(): ConnectionFlowState {
  return {
    feature: 'connection',
    stage: 'await_location',
    location: null,
    location_text: null,
    connection_type: null,
    load_kw: null,
    appliances_note: null,
  }
}

function billContacts() {
  return CONNECTION_CONTACTS.slice(0, 2)
}

function formatReading(reading: BillReading, lang: GuideLang): string {
  const lines: string[] = []
  if (lang === 'te') lines.push('నేను బిల్లు నుంచి ఇలా చదివాను:')
  else if (lang === 'hi') lines.push('मैंने बिल से यह पढ़ा:')
  else lines.push('Here is what I read from the bill:')

  const row = (label: string, value: string | number | null) => {
    if (value == null || value === '') return
    lines.push(`• ${label}: ${value}`)
  }
  row(lang === 'te' ? 'సర్వీస్ నం' : lang === 'hi' ? 'सर्विस नं' : 'Service no', reading.service_no)
  row(lang === 'te' ? 'కాలం' : lang === 'hi' ? 'अवधि' : 'Billing period', reading.billing_period)
  row(lang === 'te' ? 'యూనిట్లు' : lang === 'hi' ? 'यूनिट' : 'Units', reading.units)
  row(lang === 'te' ? 'మొత్తం' : lang === 'hi' ? 'कुल' : 'Total', reading.total_inr != null ? `Rs ${Math.round(reading.total_inr)}` : null)
  if (reading.discom && reading.discom !== 'unknown') row('Discom', reading.discom)
  if (reading.charges.length) {
    lines.push(lang === 'te' ? 'ఛార్జీలు:' : lang === 'hi' ? 'शुल्क:' : 'Charges:')
    for (const c of reading.charges) {
      const amt = c.amount_inr != null ? `Rs ${Math.round(c.amount_inr)}` : '?'
      const flag = c.clear ? '' : lang === 'te' ? ' (అస్పష్టం)' : lang === 'hi' ? ' (अस्पष्ट)' : ' (unclear)'
      lines.push(`  – ${c.label}: ${amt}${flag}`)
    }
  }
  return lines.join('\n')
}

function buildBillExplanation(state: BillFlowState, lang: GuideLang): {
  reply: string
  ui: ElectricityUiPayload
} {
  const reading = state.confirmed ?? state.reading
  if (!reading) {
    return { reply: ECOPY.billStart(lang), ui: { feature: 'bill', stage: 'await_photo' } }
  }
  const history = state.history
  const estimate = estimateNextBill(history)
  const parts = [
    formatReading(reading, lang),
    '',
    lang === 'te' ? 'ప్రతి ఛార్జ్ సాధారణ మాటల్లో:' : lang === 'hi' ? 'हर शुल्क सादे शब्दों में:' : 'Each charge in plain words:',
    explainAllCharges(reading.charges, lang, reading.units),
    '',
    usageChangeSentence(history, lang),
  ]
  if (history.length) {
    parts.push('', lang === 'te' ? 'వాడకం చార్ట్:' : lang === 'hi' ? 'इस्तेमाल चार्ट:' : 'Usage over recent months:', chartAscii(history))
  }
  parts.push('', estimateSentence(estimate, lang))
  parts.push(
    '',
    lang === 'te'
      ? 'ఇది సమాచారం మాత్రమే. భరోసా ఏ ఆఫీసుకూ బిల్లు పంపదు. మరో బిల్లు పంపితే చరిత్రకు చేరుస్తాను.'
      : lang === 'hi'
        ? 'यह केवल जानकारी है। भरोसा किसी दफ़्तर में बिल नहीं भेजता। और बिल भेजेंगे तो इतिहास में जोड़ूँगी।'
        : 'This is information only. Bharosa submits nothing to any office. Send another bill photo to add to your history.',
  )

  return {
    reply: parts.filter(Boolean).join('\n'),
    ui: {
      feature: 'bill',
      stage: 'explained',
      usage_chart: history,
      estimate,
      reading_summary: reading,
      actions: [],
    },
  }
}

async function handleBillTurn(args: {
  state: BillFlowState
  lang: GuideLang
  text: string
  image?: { buffer: Buffer; mimetype: string } | null
}): Promise<ElectricityTurnResult> {
  const { lang, text, image } = args
  let state = { ...args.state, history: [...args.state.history] }

  if (CANCEL.test(text)) {
    return {
      reply: ECOPY.cancel(lang),
      state: null,
      contacts: [],
      ui: null,
      problem_id: 'power_bill_explain',
    }
  }

  // Awaiting a corrected field value
  if (state.stage === 'fix_field' && state.fix_field && state.reading) {
    const updated = applyBillCorrection(state.reading, state.fix_field, text)
    state.reading = updated
    state.fix_field = null
    state.stage = 'confirm'
    return {
      reply: `${formatReading(updated, lang)}\n\n${ECOPY.confirmPrompt(lang)}`,
      state,
      contacts: billContacts(),
      ui: {
        feature: 'bill',
        stage: 'confirm',
        reading_summary: updated,
        actions: BILL_ACTIONS(lang),
      },
      problem_id: 'power_bill_explain',
    }
  }

  // Confirm / fix after OCR
  if (state.stage === 'confirm' && state.reading) {
    if (CORRECT.test(text) || /^correct$/i.test(text.trim())) {
      state.confirmed = state.reading
      const point = readingToHistoryPoint(state.reading)
      if (point) state.history = mergeHistory(state.history, point)
      state.stage = 'explained'
      const built = buildBillExplanation(state, lang)
      return {
        reply: built.reply,
        state,
        contacts: billContacts(),
        ui: built.ui,
        problem_id: 'power_bill_explain',
      }
    }
    if (FIX.test(text) || /fix\s+\w+/i.test(text)) {
      const m = text.match(/fix\s+(\w+)\s*[:=]?\s*(.+)$/i)
      if (m) {
        const updated = applyBillCorrection(state.reading, m[1]!, m[2]!.trim())
        state.reading = updated
        return {
          reply: `${formatReading(updated, lang)}\n\n${ECOPY.confirmPrompt(lang)}`,
          state,
          contacts: billContacts(),
          ui: { feature: 'bill', stage: 'confirm', reading_summary: updated, actions: BILL_ACTIONS(lang) },
          problem_id: 'power_bill_explain',
        }
      }
      state.stage = 'fix_field'
      state.fix_field = 'units'
      return {
        reply:
          lang === 'te'
            ? 'ఏ ఫీల్డ్ మార్చాలి? ఉదా: units / total / period. ఆపై విలువ పంపండి.'
            : lang === 'hi'
              ? 'कौन सा फ़ील्ड बदलें? जैसे units / total / period। फिर मान भेजें।'
              : 'Which field should I change — units, total, or period? Then send the value.',
        state,
        contacts: billContacts(),
        ui: { feature: 'bill', stage: 'fix_field', actions: [] },
        problem_id: 'power_bill_explain',
      }
    }
  }

  // Explained — accept another bill into history
  if (state.stage === 'explained' && (image || parseBillTextFallback(text))) {
    state.stage = 'await_photo'
  }

  // Read photo or typed bill
  if (state.stage === 'await_photo' || state.stage === 'explained' || !state.reading) {
    let reading: BillReading | null = null
    if (image) {
      const ocr = await readBillFromImage(image)
      if (!ocr.ok) {
        return {
          reply: `${ocr.error}\n\n${ECOPY.billStart(lang)}`,
          state: { ...state, stage: 'await_photo' },
          contacts: billContacts(),
          ui: { feature: 'bill', stage: 'await_photo' },
          problem_id: 'power_bill_explain',
        }
      }
      reading = ocr.reading
    } else if (text.trim()) {
      const ocr = await readBillFromText(text)
      if (ocr.ok) reading = ocr.reading
      else if (!detectsBillFeature(text)) {
        // stay waiting
        return {
          reply: ECOPY.billStart(lang),
          state: { ...state, stage: 'await_photo' },
          contacts: billContacts(),
          ui: { feature: 'bill', stage: 'await_photo' },
          problem_id: 'power_bill_explain',
        }
      }
    }

    if (!reading) {
      return {
        reply: ECOPY.billStart(lang),
        state: { ...state, stage: 'await_photo' },
        contacts: billContacts(),
        ui: { feature: 'bill', stage: 'await_photo' },
        problem_id: 'power_bill_explain',
      }
    }

    if (reading.not_a_bill) {
      return {
        reply: ECOPY.notABill(lang),
        state: { ...state, stage: 'await_photo', reading: null },
        contacts: billContacts(),
        ui: { feature: 'bill', stage: 'await_photo' },
        problem_id: 'power_bill_explain',
      }
    }

    if (reading.unclear_fields.length && (reading.units == null || reading.total_inr == null)) {
      state.reading = reading
      state.stage = 'confirm'
      return {
        reply: `${formatReading(reading, lang)}\n\n${ECOPY.unclear(lang, reading.unclear_fields)}\n\n${ECOPY.confirmPrompt(lang)}`,
        state,
        contacts: billContacts(),
        ui: { feature: 'bill', stage: 'confirm', reading_summary: reading, actions: BILL_ACTIONS(lang) },
        problem_id: 'power_bill_explain',
      }
    }

    state.reading = reading
    state.stage = 'confirm'
    return {
      reply: `${formatReading(reading, lang)}\n\n${ECOPY.confirmPrompt(lang)}`,
      state,
      contacts: billContacts(),
      ui: { feature: 'bill', stage: 'confirm', reading_summary: reading, actions: BILL_ACTIONS(lang) },
      problem_id: 'power_bill_explain',
    }
  }

  return {
    reply: ECOPY.confirmPrompt(lang),
    state,
    contacts: billContacts(),
    ui: { feature: 'bill', stage: state.stage, reading_summary: state.reading, actions: BILL_ACTIONS(lang) },
    problem_id: 'power_bill_explain',
  }
}

function handleConnectionTurn(args: {
  state: ConnectionFlowState
  lang: GuideLang
  text: string
  location?: GeoPoint | null
}): ElectricityTurnResult {
  const { lang, text } = args
  let state: ConnectionFlowState = { ...args.state }

  if (CANCEL.test(text)) {
    return { reply: ECOPY.cancel(lang), state: null, contacts: [], ui: null, problem_id: 'power_new_connection' }
  }
  if (FINAL_PRICE.test(text)) {
    return {
      reply: ECOPY.notFinalPrice(lang),
      state,
      contacts: CONNECTION_CONTACTS,
      ui: { feature: 'connection', stage: state.stage },
      problem_id: 'power_new_connection',
    }
  }

  // Location — never treat feature starters / type / load answers as an address
  const looksLikePlaceOnly =
    !!args.location ||
    /location|lat|lng|నా\s*లొకేషన్|मेरा\s*लोकेशन/i.test(text) ||
    (state.stage === 'await_location' &&
      !detectsConnectionFeature(text) &&
      !parseConnectionType(text) &&
      parseLoadKw(text) == null &&
      !CORRECT.test(text) &&
      !FIX.test(text) &&
      !CANCEL.test(text) &&
      text.length > 3)

  if (args.location) {
    state.location = args.location
    state.location_text = args.location.label ?? `${args.location.lat}, ${args.location.lng}`
  } else if (looksLikePlaceOnly) {
    const parsed = parseLocationFromText(text)
    if (parsed.point) {
      state.location = parsed.point
      state.location_text = parsed.label
    } else if (parsed.label && parsed.label.length > 3) {
      state.location_text = parsed.label
    }
  }

  if (state.location && !isInsideTelangana(state.location)) {
    return {
      reply: ECOPY.outsideArea(lang),
      state: null,
      contacts: CONNECTION_CONTACTS,
      ui: null,
      problem_id: 'power_new_connection',
    }
  }

  if (!state.location && !state.location_text) {
    state.stage = 'await_location'
    return {
      reply: state.stage === 'await_location' && text && !detectsConnectionFeature(text) ? ECOPY.noLocation(lang) : ECOPY.connectionStart(lang),
      state,
      contacts: CONNECTION_CONTACTS,
      ui: { feature: 'connection', stage: 'await_location' },
      problem_id: 'power_new_connection',
    }
  }

  // Type
  const typed = parseConnectionType(text)
  if (typed) state.connection_type = typed
  if (!state.connection_type) {
    state.stage = 'ask_type'
    return {
      reply: ECOPY.askType(lang),
      state,
      contacts: CONNECTION_CONTACTS,
      ui: { feature: 'connection', stage: 'ask_type', actions: CONNECTION_TYPE_ACTIONS(lang) },
      problem_id: 'power_new_connection',
    }
  }

  // Load
  const load = parseLoadKw(text)
  if (load != null) state.load_kw = load
  if (state.load_kw == null) {
    const suggestion = suggestLoadFromAppliances(text)
    if (suggestion) {
      state.load_kw = suggestion.kw
      state.appliances_note = suggestion.explanation
      state.stage = 'confirm'
      return {
        reply: `${suggestion.explanation}\n\n${confirmConnectionSummary(state, lang)}\n\n${ECOPY.confirmConnection(lang)}`,
        state,
        contacts: CONNECTION_CONTACTS,
        ui: connectionUi(state, lang, null, null, null),
        problem_id: 'power_new_connection',
      }
    }
    state.stage = 'ask_load'
    return {
      reply: ECOPY.askLoad(lang),
      state,
      contacts: CONNECTION_CONTACTS,
      ui: { feature: 'connection', stage: 'ask_load' },
      problem_id: 'power_new_connection',
    }
  }

  // Confirm
  if (state.stage !== 'result' && state.stage !== 'confirm') {
    state.stage = 'confirm'
    return {
      reply: `${confirmConnectionSummary(state, lang)}\n\n${ECOPY.confirmConnection(lang)}`,
      state,
      contacts: CONNECTION_CONTACTS,
      ui: connectionUi(state, lang, null, null, null),
      problem_id: 'power_new_connection',
    }
  }

  if (state.stage === 'confirm' && !CORRECT.test(text) && !/^correct$/i.test(text.trim())) {
    // Allow fixing type/load/location in place
    if (typed || load != null || args.location) {
      return {
        reply: `${confirmConnectionSummary(state, lang)}\n\n${ECOPY.confirmConnection(lang)}`,
        state,
        contacts: CONNECTION_CONTACTS,
        ui: connectionUi(state, lang, null, null, null),
        problem_id: 'power_new_connection',
      }
    }
    if (FIX.test(text)) {
      return {
        reply: ECOPY.askLoad(lang),
        state: { ...state, stage: 'ask_load', load_kw: null },
        contacts: CONNECTION_CONTACTS,
        ui: { feature: 'connection', stage: 'ask_load' },
        problem_id: 'power_new_connection',
      }
    }
    return {
      reply: `${confirmConnectionSummary(state, lang)}\n\n${ECOPY.confirmConnection(lang)}`,
      state,
      contacts: CONNECTION_CONTACTS,
      ui: connectionUi(state, lang, null, null, null),
      problem_id: 'power_new_connection',
    }
  }

  // Result
  state.stage = 'result'
  const pole = state.location
    ? findNearestPole(state.location)
    : { available: false as const, note: 'Location was text-only; GPS pin is needed for pole distance.' }

  const materials =
    pole.available && state.connection_type && state.load_kw != null
      ? materialsForConnection({
          kind: state.connection_type,
          loadKw: state.load_kw,
          distanceM: pole.distance_m ?? null,
        })
      : null

  const cost =
    pole.available && state.connection_type && state.load_kw != null
      ? estimateConnectionCost({
          kind: state.connection_type,
          loadKw: state.load_kw,
          distanceM: pole.distance_m ?? null,
        })
      : null

  const parts: string[] = [confirmConnectionSummary(state, lang), '']

  if (pole.available && pole.pole_id != null && pole.distance_m != null) {
    parts.push(
      lang === 'te'
        ? `సమీపంలోని సరిపడే పోల్: ${pole.pole_id}, సుమారు ${pole.distance_m} మీ. ${pole.note}`
        : lang === 'hi'
          ? `निकट उपयुक्त पोल: ${pole.pole_id}, लगभग ${pole.distance_m} मी. ${pole.note}`
          : `Nearest suitable pole: ${pole.pole_id}, about ${pole.distance_m} m away. ${pole.note}`,
    )
  } else {
    parts.push(ECOPY.noPoleData(lang))
    if (pole.note) parts.push(pole.note)
  }

  if (materials?.length) {
    parts.push('')
    parts.push(lang === 'te' ? 'అవసరమైనవి (అంచనా):' : lang === 'hi' ? 'ज़रूरी सामग्री (अनुमान):' : 'What is needed (estimate):')
    for (const line of materials) {
      parts.push(`• ${line.item}: ${line.quantity}${line.note ? ` — ${line.note}` : ''}`)
    }
  }

  if (cost) {
    parts.push('')
    parts.push(
      lang === 'te'
        ? `మెటీరియల్స్ / పని అంచనా: Rs ${cost.materials_work_low_inr} నుంచి Rs ${cost.materials_work_high_inr}.\nదరఖాస్తుదారు చెల్లించే ఛార్జీల అంచనా: Rs ${cost.applicant_charges_low_inr} నుంచి Rs ${cost.applicant_charges_high_inr} (అధికారిక ఛార్జీలు నిర్ధారించిన తర్వాత).\nఇవి అంచనాలు — అధికారిక కోట్ కాదు.`
        : lang === 'hi'
          ? `सामग्री / काम का अनुमान: Rs ${cost.materials_work_low_inr} से Rs ${cost.materials_work_high_inr}.\nआवेदक के शुल्कों का अनुमान: Rs ${cost.applicant_charges_low_inr} से Rs ${cost.applicant_charges_high_inr} (आधिकारिक शुल्क पुष्टि के बाद).\nये अनुमान हैं — आधिकारिक कोट नहीं।`
          : `Estimated cost of materials and work: Rs ${cost.materials_work_low_inr} to Rs ${cost.materials_work_high_inr}.\nCharges you may have to pay: Rs ${cost.applicant_charges_low_inr} to Rs ${cost.applicant_charges_high_inr}, once the official charges are confirmed.\nThese are estimates, not an official quote.`,
    )
    parts.push(cost.source_note)
  }

  parts.push('', nextStepsCopy(lang))

  return {
    reply: parts.join('\n'),
    state,
    contacts: CONNECTION_CONTACTS,
    ui: connectionUi(state, lang, pole, materials, cost),
    problem_id: 'power_new_connection',
  }
}

function confirmConnectionSummary(state: ConnectionFlowState, lang: GuideLang): string {
  const typeLabel =
    state.connection_type === 'home'
      ? lang === 'te'
        ? 'ఇల్లు'
        : lang === 'hi'
          ? 'घर'
          : 'Home'
      : state.connection_type === 'shop'
        ? lang === 'te'
          ? 'దుకాణం'
          : lang === 'hi'
            ? 'दुकान'
            : 'Shop'
        : state.connection_type === 'farm'
          ? lang === 'te'
            ? 'వ్యవసాయం'
            : lang === 'hi'
              ? 'खेत'
              : 'Farm'
          : '?'
  const loc = state.location_text || (state.location ? `${state.location.lat}, ${state.location.lng}` : '?')
  const load = state.load_kw != null ? `${state.load_kw} kW` : '?'
  if (lang === 'te') return `నేను ఇలా అర్థం చేసుకున్నాను — లొకేషన్: ${loc}; రకం: ${typeLabel}; లోడ్: ${load}.`
  if (lang === 'hi') return `मैंने यह समझा — लोकेशन: ${loc}; प्रकार: ${typeLabel}; लोड: ${load}.`
  return `I have: location ${loc}; type ${typeLabel}; load ${load}.`
}

function connectionUi(
  state: ConnectionFlowState,
  lang: GuideLang,
  pole: ReturnType<typeof findNearestPole> | null,
  materials: ReturnType<typeof materialsForConnection>,
  cost: ReturnType<typeof estimateConnectionCost>,
): ElectricityUiPayload {
  return {
    feature: 'connection',
    stage: state.stage,
    actions:
      state.stage === 'ask_type'
        ? CONNECTION_TYPE_ACTIONS(lang)
        : state.stage === 'confirm'
          ? BILL_ACTIONS(lang)
          : [],
    connection_summary: {
      location_text: state.location_text,
      connection_type: state.connection_type,
      load_kw: state.load_kw,
      pole,
      materials: materials ?? undefined,
      cost,
    },
  }
}

export async function handleElectricityTurn(args: {
  state: ElectricityState | null | undefined
  lang: GuideLang
  text: string
  image?: { buffer: Buffer; mimetype: string } | null
  location?: GeoPoint | null
}): Promise<ElectricityTurnResult | null> {
  const text = (args.text || '').trim()
  let state = args.state ?? null

  // Start features from keywords
  if (!state) {
    if (detectsBillFeature(text) || args.image) {
      state = emptyBillState()
      if (detectsBillFeature(text) && !args.image && !parseBillTextFallback(text)) {
        return {
          reply: ECOPY.billStart(args.lang),
          state,
          contacts: billContacts(),
          ui: { feature: 'bill', stage: 'await_photo' },
          problem_id: 'power_bill_explain',
        }
      }
    } else if (detectsConnectionFeature(text)) {
      state = emptyConnectionState()
      // If location already in the same message, continue
    } else {
      return null
    }
  }

  if (state.feature === 'bill') {
    return handleBillTurn({ state, lang: args.lang, text, image: args.image })
  }
  return handleConnectionTurn({
    state,
    lang: args.lang,
    text: text || (args.location ? 'My location shared' : ''),
    location: args.location,
  })
}

export function serializeElectricityState(state: ElectricityState | null | undefined): ElectricityState | null {
  return state ?? null
}

export function parseElectricityState(raw: unknown): ElectricityState | null {
  if (!raw || typeof raw !== 'object') return null
  const row = raw as Record<string, unknown>
  if (row.feature === 'bill') {
    return {
      feature: 'bill',
      stage: (row.stage as BillFlowState['stage']) || 'await_photo',
      reading: (row.reading as BillReading) || null,
      confirmed: (row.confirmed as BillReading) || null,
      history: Array.isArray(row.history) ? (row.history as BillFlowState['history']) : [],
      fix_field: typeof row.fix_field === 'string' ? row.fix_field : null,
    }
  }
  if (row.feature === 'connection') {
    return {
      feature: 'connection',
      stage: (row.stage as ConnectionFlowState['stage']) || 'await_location',
      location: (row.location as GeoPoint) || null,
      location_text: typeof row.location_text === 'string' ? row.location_text : null,
      connection_type: (row.connection_type as ConnectionKind) || null,
      load_kw: typeof row.load_kw === 'number' ? row.load_kw : null,
      appliances_note: typeof row.appliances_note === 'string' ? row.appliances_note : null,
    }
  }
  return null
}
