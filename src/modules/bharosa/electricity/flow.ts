/**
 * Multi-turn electricity features for the Bharosa guide.
 * Feature 1: understand bill · Feature 2: new connection cost (limited without pole data)
 */

import type { GuideLang } from '../guide/playbooks.js'
import {
  chartAscii,
  estimateNextBill,
  estimateSentence,
  mergeHistoryForService,
  normalizeServiceNo,
  readingToHistoryPoint,
  usageChangeSentence,
} from './billMath.js'
import { applyBillCorrection, parseBillTextFallback, readBillFromImage, readBillFromText } from './billOcr.js'
import {
  BILL_ACTIONS,
  CONNECTION_TYPE_ACTIONS,
  ECOPY,
} from './copy.js'
import { answerChargeQuestion, buildFirstBillReply, userFacingField } from './kbExplain.js'
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
/** Exact short confirmations */
const CORRECT_EXACT =
  /^\s*(correct|yes|yep|yeah|yup|ok|okay|sure|right|fine|good|looks?\s*good|all\s*good|go\s*ahead|proceed|continue|explain|సరియైంది|సరే|అవును|सही|ठीक\s*है|हाँ|हां)\s*[!.]*\s*$/i
/** Natural “this looks right” even with extra words */
const CORRECT_SOFT =
  /\b(correct|looks?\s*(correct|right|good|fine|ok|okay)|details?\s*(look|are|seem)s?\s*(correct|right|good|fine|ok)|yeah\b.*\b(correct|right)|yes\b.*\b(correct|right)|that'?s?\s*(right|correct|fine)|all\s*(good|correct)|go\s*ahead|please\s*explain|can\s*(you\s*)?explain|సరియైంది|సరిపోయింది|సరైనది|सही\s*(लग|है)|ठीक\s*है)\b/i
const FIX = /^\s*(fix|change|update|wrong|incorrect|సరిదిద్దు|సరియైంది\s*కాదు|सुधार|गलत)\b/i
const HIGH_BILL =
  /\b(why|how come|too\s*(much|high)|so\s*high|bill\s*(is\s*)?(high|more|expensive)|higher|what\s*(am\s*i|i'?m)\s*doing\s*wrong|ఎక్కువ|ఎందుకు|ఎక్కువైంది|ज्यादा|महंगा|क्यों)\b/i
const FINAL_PRICE = /final\s*price|exact\s*(price|amount|cost)|అంతిమ\s*ధర|अंतिम\s*(कीमत|राशि)/i
const NEW_CONN_HISTORY = /^\s*(new\s+connection\s+history|fresh\s+history|కొత్త\s*చరిత్ర|नया\s*इतिहास)\s*$/i
const COMPLAINT_ASK =
  /\b(file|raise|register|follow\s*up)\b.{0,30}\b(complaint|grievance)|ఫిర్యాదు\s*(పెట్ట|ఫైల్)|शिकायत\s*(दर्ज|फाइल)/i
const DEFLECT =
  /\b(aadhaar|ration|pension|pothole|sewer|water\s*supply|passport|voter)\b|ఆధార్|రేషన్|నీళ్లు|రోడ్డు|आधार|राशन|सड़क/i

function isConfirm(text: string): boolean {
  const t = text.trim()
  if (!t || FIX.test(t)) return false
  if (CORRECT_EXACT.test(t)) return true
  // Soft confirm only if they are not asking to change a number
  if (/fix\s+\w+/i.test(t)) return false
  return CORRECT_SOFT.test(t)
}

function wantsHighBillExplain(text: string): boolean {
  return HIGH_BILL.test(text)
}

function explainWhyHigh(reading: BillReading, lang: GuideLang): string {
  const units = reading.units
  const energy = reading.charges.find((c) => /energy/i.test(c.label))
  const subsidy = reading.charges.find((c) => /subsidy|gruha/i.test(c.label))
  const lpsc = reading.charges.find((c) => /lpsc|delayed|dps|surcharge/i.test(c.label) && (c.amount_inr ?? 0) > 0)
  const arrears = reading.charges.find((c) => /arrear/i.test(c.label) && (c.amount_inr ?? 0) > 0)
  const bits: string[] = []

  if (lang === 'te') {
    bits.push('బిల్లు ఎక్కువగా అనిపించడానికి, ఈ బిల్లులో కనిపించినవి:')
    if (units != null) bits.push(`• యూనిట్లు: ${units} — వాడకం ఎక్కువైతే ఎనర్జీ ఛార్జీ పెరుగుతుంది.`)
    if (energy?.amount_inr != null) bits.push(`• ఎనర్జీ ఛార్జీ: Rs ${energy.amount_inr} (ప్రధాన భాగం).`)
    if (lpsc?.amount_inr != null) bits.push(`• LPSC / ఆలస్య ఛార్జీ: Rs ${lpsc.amount_inr} — గడువు తర్వాత కట్టితే వస్తుంది.`)
    if (arrears?.amount_inr != null) bits.push(`• బకాయి: Rs ${arrears.amount_inr}.`)
    if (subsidy?.amount_inr != null) bits.push(`• సబ్సిడీ క్రెడిట్: Rs ${Math.abs(subsidy.amount_inr)} తగ్గింపు.`)
    bits.push('నేను రేట్లు ఊహించను. మరిన్ని నెలల బిల్లులు పంపితే వాడకం పోల్చి చెప్పగలను.')
  } else if (lang === 'hi') {
    bits.push('बिल ज़्यादा लगने के पीछे, इस बिल पर जो दिखा:')
    if (units != null) bits.push(`• यूनिट: ${units} — इस्तेमाल ज़्यादा हो तो ऊर्जा शुल्क बढ़ता है।`)
    if (energy?.amount_inr != null) bits.push(`• ऊर्जा शुल्क: Rs ${energy.amount_inr} (मुख्य हिस्सा)।`)
    if (lpsc?.amount_inr != null) bits.push(`• LPSC / विलंब शुल्क: Rs ${lpsc.amount_inr} — देर से भरने पर।`)
    if (arrears?.amount_inr != null) bits.push(`• बकाया: Rs ${arrears.amount_inr}.`)
    if (subsidy?.amount_inr != null) bits.push(`• सब्सिडी क्रेडिट: Rs ${Math.abs(subsidy.amount_inr)} की कटौती।`)
    bits.push('मैं दरें नहीं गढ़ूँगी। और महीने के बिल भेजें तो तुलना बता सकती हूँ।')
  } else {
    bits.push('From what is printed on this bill, here is what usually makes the amount feel high:')
    if (units != null) bits.push(`• Units: ${units} — higher use raises the energy charge.`)
    if (energy?.amount_inr != null) bits.push(`• Energy charges: Rs ${energy.amount_inr} (usually the main part).`)
    if (lpsc?.amount_inr != null) bits.push(`• LPSC / late-payment charge: Rs ${lpsc.amount_inr} — added when payment is after the due date.`)
    if (arrears?.amount_inr != null) bits.push(`• Arrears: Rs ${arrears.amount_inr}.`)
    if (subsidy?.amount_inr != null) bits.push(`• Subsidy credit: Rs ${Math.abs(subsidy.amount_inr)} already reduced.`)
    bits.push('I will not invent tariff rates. Send previous months’ bills if you want a usage comparison.')
  }
  return bits.join('\n')
}

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
    history_service_no: null,
    pending_foreign: null,
    fix_field: null,
  }
}

function deflectNonBill(lang: GuideLang): string {
  return lang === 'te'
    ? 'ఈ బిల్లు ఫ్లోలో నేను మీ ప్రస్తుత కరెంట్ బిల్లు అర్థం చేయడమే చేస్తాను. వేరే సేవ కావాలంటే *cancel* చెప్పి కొత్త ప్రశ్న అడగండి.'
    : lang === 'hi'
      ? 'इस बिल फ़्लो में मैं सिर्फ़ आपका वर्तमान बिजली बिल समझाती हूँ। दूसरी सेवा हो तो *cancel* कहकर नई बात शुरू करें।'
      : 'In this flow I only help you understand your current electricity bill. For another service, say *cancel* and ask again.'
}

function noComplaint(lang: GuideLang): string {
  return lang === 'te'
    ? 'ఈ బిల్లు ఫ్లోలో ఫిర్యాదు ఫైల్ / ఫాలో-అప్ చేయను. బిల్లు అర్థం చేసుకోవడమే. అవసరమైతే 1912 లేదా డిస్కం సైట్.'
    : lang === 'hi'
      ? 'इस बिल फ़्लो में शिकायत दर्ज / फॉलो-अप नहीं करती। सिर्फ़ बिल समझाना। ज़रूरत हो तो 1912 या डिस्कॉम साइट।'
      : 'I do not file or follow up complaints in this bill flow — I only explain the bill. For a complaint, use 1912 or the discom site.'
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
  row(userFacingField('service_no', lang), reading.service_no)
  row(userFacingField('billing_period', lang), reading.billing_period)
  row(userFacingField('units', lang), reading.units)
  row(
    userFacingField('total', lang),
    reading.total_inr != null ? `Rs ${Math.round(reading.total_inr * 100) / 100}` : null,
  )
  row(userFacingField('due_date', lang), reading.due_date)
  if (reading.category) row(lang === 'te' ? 'వర్గం' : lang === 'hi' ? 'श्रेणी' : 'Category', reading.category)
  if (reading.discom && reading.discom !== 'unknown') row('Discom', reading.discom)
  if (reading.charges.length) {
    lines.push(lang === 'te' ? 'ఛార్జీలు:' : lang === 'hi' ? 'शुल्क:' : 'Charges:')
    for (const c of reading.charges) {
      const amt = c.amount_inr != null ? `Rs ${Math.round(c.amount_inr * 100) / 100}` : '?'
      const flag = c.clear ? '' : lang === 'te' ? ' (అస్పష్టం)' : lang === 'hi' ? ' (अस्पष्ट)' : ' (unclear)'
      lines.push(`  – ${c.label}: ${amt}${flag}`)
    }
  }
  if (reading.reconciliation_warning) {
    lines.push(
      lang === 'te'
        ? 'గమనిక: కొన్ని అంకెలు బిల్లు మొత్తంతో సరిపోలడం లేదు — ధృవీకరించండి. ఊహించి సరిదిద్దను.'
        : lang === 'hi'
          ? 'नोट: कुछ अंक कुल रकम से मेल नहीं खाते — जाँचें। मैं अनुमान से नहीं सुधारूँगी।'
          : 'Note: some figures do not reconcile with the bill total — please check. I will not invent fixes.',
    )
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
  const first = buildFirstBillReply({ reading, history, lang })
  const parts = [first]
  if (history.length) {
    parts.push('', usageChangeSentence(history, lang), chartAscii(history))
  }
  parts.push('', estimateSentence(estimate, lang, history))

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

function confirmBill(state: BillFlowState, lang: GuideLang): ElectricityTurnResult {
  const reading = state.reading!
  const point = readingToHistoryPoint(reading)
  if (point) {
    const merged = mergeHistoryForService(state.history, state.history_service_no, point)
    if (!merged.ok) {
      state.pending_foreign = reading
      return {
        reply: ECOPY.differentService(lang, merged.existing, merged.incoming),
        state,
        contacts: billContacts(),
        ui: { feature: 'bill', stage: 'confirm', reading_summary: reading, actions: BILL_ACTIONS(lang) },
        problem_id: 'power_bill_explain',
      }
    }
    state.history = merged.history
    state.history_service_no = merged.service_no
  }
  state.confirmed = reading
  state.pending_foreign = null
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

async function handleBillTurn(args: {
  state: BillFlowState
  lang: GuideLang
  text: string
  image?: { buffer: Buffer; mimetype: string } | null
}): Promise<ElectricityTurnResult> {
  const { lang, text, image } = args
  let state: BillFlowState = {
    ...args.state,
    history: [...args.state.history],
    history_service_no: args.state.history_service_no ?? null,
    pending_foreign: args.state.pending_foreign ?? null,
  }

  if (CANCEL.test(text)) {
    return { reply: ECOPY.cancel(lang), state: null, contacts: [], ui: null, problem_id: 'power_bill_explain' }
  }
  if (COMPLAINT_ASK.test(text)) {
    return {
      reply: noComplaint(lang),
      state,
      contacts: billContacts(),
      ui: { feature: 'bill', stage: state.stage, actions: state.stage === 'confirm' ? BILL_ACTIONS(lang) : [] },
      problem_id: 'power_bill_explain',
    }
  }
  if (DEFLECT.test(text) && !detectsBillFeature(text) && !parseBillTextFallback(text) && !image) {
    return {
      reply: deflectNonBill(lang),
      state,
      contacts: billContacts(),
      ui: { feature: 'bill', stage: state.stage },
      problem_id: 'power_bill_explain',
    }
  }

  // Switch history to the pending foreign service number
  if (state.pending_foreign && NEW_CONN_HISTORY.test(text)) {
    state.history = []
    state.history_service_no = normalizeServiceNo(state.pending_foreign.service_no)
    state.reading = state.pending_foreign
    state.pending_foreign = null
    state.stage = 'confirm'
    return confirmBill(state, lang)
  }

  // Mid-flow charge question (RT-02)
  const chargeQ = answerChargeQuestion(
    text,
    state.confirmed ?? state.reading,
    lang,
    state.stage === 'confirm',
  )
  if (chargeQ) {
    return {
      reply: chargeQ,
      state,
      contacts: billContacts(),
      ui: {
        feature: 'bill',
        stage: state.stage,
        reading_summary: state.reading,
        actions: state.stage === 'confirm' ? BILL_ACTIONS(lang) : [],
      },
      problem_id: 'power_bill_explain',
    }
  }

  // Awaiting a corrected field value — patch one field, re-show ALL values (TC-04)
  if (state.stage === 'fix_field' && state.fix_field && state.reading) {
    const updated = applyBillCorrection(state.reading, state.fix_field, text)
    state.reading = updated
    state.fix_field = null
    state.stage = 'confirm'
    return {
      reply: `${formatReading(updated, lang)}\n\n${ECOPY.confirmPrompt(lang)}`,
      state,
      contacts: billContacts(),
      ui: { feature: 'bill', stage: 'confirm', reading_summary: updated, actions: BILL_ACTIONS(lang) },
      problem_id: 'power_bill_explain',
    }
  }

  if (state.stage === 'confirm' && state.reading) {
    // Natural “units should be 210” without requiring the word Fix
    const softFix = text.match(
      /\b(units?|total|amount|period|month|service(?:\s*no)?)\b.{0,20}(?:should\s*be|is|are|=|:)?\s*([A-Za-z0-9./-]{1,40})/i,
    )
    if (FIX.test(text) || /fix\s+\w+/i.test(text) || (softFix && !isConfirm(text) && !wantsHighBillExplain(text))) {
      const m = text.match(/fix\s+(\w+)\s*[:=]?\s*(.+)$/i) || softFix
      if (m && m[2]) {
        const field = (m[1] || 'units').toLowerCase()
        const updated = applyBillCorrection(state.reading, field, m[2]!.trim())
        state.reading = updated
        return {
          reply: `${formatReading(updated, lang)}\n\n${ECOPY.confirmPrompt(lang)}`,
          state,
          contacts: billContacts(),
          ui: { feature: 'bill', stage: 'confirm', reading_summary: updated, actions: BILL_ACTIONS(lang) },
          problem_id: 'power_bill_explain',
        }
      }
      if (FIX.test(text) || /wrong|incorrect|తప్పు|गलत/i.test(text)) {
        state.stage = 'fix_field'
        state.fix_field = 'units'
        return {
          reply:
            lang === 'te'
              ? `ఏది మార్చాలి? ${userFacingField('units', lang)} / ${userFacingField('total', lang)} / ${userFacingField('period', lang)}. తర్వాత విలువ పంపండి.`
              : lang === 'hi'
                ? `क्या बदलें? ${userFacingField('units', lang)} / ${userFacingField('total', lang)} / ${userFacingField('period', lang)}। फिर मान भेजें।`
                : `Which should I change — ${userFacingField('units', lang)}, ${userFacingField('total', lang)}, or ${userFacingField('period', lang)}? Then send the value.`,
          state,
          contacts: billContacts(),
          ui: { feature: 'bill', stage: 'fix_field', actions: [] },
          problem_id: 'power_bill_explain',
        }
      }
    }

    if (isConfirm(text) || wantsHighBillExplain(text)) {
      const confirmed = confirmBill(state, lang)
      if (wantsHighBillExplain(text) && confirmed.state && 'confirmed' in confirmed.state && confirmed.state.confirmed) {
        confirmed.reply = `${confirmed.reply}\n\n${explainWhyHigh(confirmed.state.confirmed, lang)}`
      }
      return confirmed
    }
  }

  // After explanation: “why so high?” without needing a new bill
  if (state.stage === 'explained' && state.confirmed && wantsHighBillExplain(text)) {
    return {
      reply: explainWhyHigh(state.confirmed, lang),
      state,
      contacts: billContacts(),
      ui: { feature: 'bill', stage: 'explained', reading_summary: state.confirmed, usage_chart: state.history },
      problem_id: 'power_bill_explain',
    }
  }

  if (state.stage === 'explained' && (image || parseBillTextFallback(text))) {
    state.stage = 'await_photo'
  }

  if (state.stage === 'await_photo' || state.stage === 'explained' || !state.reading) {
    let reading: BillReading | null = null
    if (image) {
      const ocr = await readBillFromImage(image)
      if (!ocr.ok) {
        return {
          reply: `${ECOPY.unclearPhoto(lang)}\n(${ocr.error})`,
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

    // Almost everything unclear → retake guidance (not "not a bill")
    if (
      reading.units == null &&
      reading.total_inr == null &&
      reading.charges.every((c) => !c.clear || c.amount_inr == null)
    ) {
      return {
        reply: ECOPY.unclearPhoto(lang),
        state: { ...state, stage: 'await_photo', reading: null },
        contacts: billContacts(),
        ui: { feature: 'bill', stage: 'await_photo' },
        problem_id: 'power_bill_explain',
      }
    }

    const friendlyUnclear = reading.unclear_fields.map((f) => userFacingField(f, lang))
    state.reading = reading
    state.stage = 'confirm'
    const warn =
      reading.unclear_fields.length && (reading.units == null || reading.total_inr == null)
        ? `\n\n${ECOPY.unclear(lang, friendlyUnclear)}`
        : reading.reconciliation_warning
          ? lang === 'te'
            ? '\n\nకొన్ని అంకెలు మొత్తంతో సరిపోలడం లేదు — ధృవీకరించండి.'
            : lang === 'hi'
              ? '\n\nकुछ अंक कुल से मेल नहीं खाते — जाँचें।'
              : '\n\nSome figures do not reconcile with the total — please check.'
          : ''
    return {
      reply: `${formatReading(reading, lang)}${warn}\n\n${ECOPY.confirmPrompt(lang)}`,
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
      !isConfirm(text) &&
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

  if (state.stage === 'confirm' && !isConfirm(text)) {
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
      history_service_no: typeof row.history_service_no === 'string' ? row.history_service_no : null,
      pending_foreign: (row.pending_foreign as BillReading) || null,
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
