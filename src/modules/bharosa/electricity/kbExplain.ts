/**
 * First-message shape + charge explanations from the KB (manager §4 / §5).
 */

import type { GuideLang } from '../guide/playbooks.js'
import { explainFromKb, matchKbRecord } from './kb.js'
import type { BillCharge, BillMonthPoint, BillReading } from './types.js'

function money(n: number, lang: GuideLang): string {
  const v = Math.round(n * 100) / 100
  return lang === 'te' || lang === 'hi' ? `₹${v}` : `Rs ${v}`
}

export function classifyCharges(charges: BillCharge[], lang: GuideLang, units: number | null, loadKw: number | null) {
  const energy: Array<{ charge: BillCharge; text: string }> = []
  const lump: Array<{ charge: BillCharge; title: string; amount: number }> = []
  const attention: Array<{ charge: BillCharge; text: string }> = []
  const explained: string[] = []

  for (const c of charges) {
    const ex = explainFromKb(c.label, c.amount_inr, lang, { units, loadKw })
    const rec = matchKbRecord(c.label)

    if (rec?.id === 'kb-energy-charges' || /energy/i.test(c.label)) {
      energy.push({ charge: c, text: ex.body })
      explained.push(`${ex.title}${c.amount_inr != null ? ` (${money(c.amount_inr, lang)})` : ''}: ${ex.body}`)
      continue
    }
    // Totals / payable lines are stated once at the top — don't spam “not a charge” for each
    if (rec?.id === 'kb-totals') continue
    // Zero advance is noise on most bills — only call out when money was applied
    if (rec?.id === 'kb-advance-payment' && (c.amount_inr == null || c.amount_inr === 0)) continue

    explained.push(`${ex.title}${c.amount_inr != null ? ` (${money(c.amount_inr, lang)})` : ''}: ${ex.body}`)

    if (ex.attention || ex.status === 'unverified' || ex.status === 'disabled' || ex.status === 'unknown' || ex.status === 'partial') {
      attention.push({ charge: c, text: ex.body })
      continue
    }
    if (ex.lumpable && c.amount_inr != null) {
      lump.push({ charge: c, title: ex.title, amount: c.amount_inr })
      continue
    }
    attention.push({ charge: c, text: ex.body })
  }

  return { energy, lump, attention, explained }
}

/** Manager §4 first-message shape after confirmation. */
export function buildFirstBillReply(args: {
  reading: BillReading
  history: BillMonthPoint[]
  lang: GuideLang
}): string {
  const { reading, history, lang } = args
  const total = reading.total_inr
  const due = reading.due_date
  const units = reading.units
  const loadKw = reading.contracted_load_kw
  const { energy, lump, attention, explained } = classifyCharges(reading.charges, lang, units, loadKw)

  const energyAmt = energy[0]?.charge.amount_inr
  const lumpSum = lump.reduce((s, x) => s + x.amount, 0)
  const parts: string[] = []

  if (lang === 'te') {
    parts.push(
      `చదివాను. ఈ నెల కట్టాల్సిన మొత్తం ${total != null ? money(total, lang) : 'స్పష్టం కాలేదు'}${due ? `, గడువు ${due}` : ''}.`,
    )
    if (units != null && energyAmt != null) {
      parts.push(`పెద్ద భాగం కరెంట్ ఛార్జీ: ${units} యూనిట్లకు ${money(energyAmt, lang)}.`)
    } else if (units != null) {
      parts.push(`యూనిట్లు: ${units}.`)
    }
    if (lump.length) {
      const names = lump.map((x) => x.title).join(', ')
      parts.push(`మిగిలిన ${money(lumpSum, lang)} — ${names} కలిపి.`)
    }
  } else if (lang === 'hi') {
    parts.push(
      `पढ़ लिया। इस महीने की रकम ${total != null ? money(total, lang) : 'साफ़ नहीं'}${due ? `, नियत तारीख ${due}` : ''}.`,
    )
    if (units != null && energyAmt != null) {
      parts.push(`सबसे बड़ा हिस्सा ऊर्जा शुल्क: ${units} यूनिट पर ${money(energyAmt, lang)}.`)
    } else if (units != null) {
      parts.push(`यूनिट: ${units}.`)
    }
    if (lump.length) {
      const names = lump.map((x) => x.title).join(', ')
      parts.push(`बाकी ${money(lumpSum, lang)} — ${names} मिलाकर.`)
    }
  } else {
    parts.push(
      `Here is what I read. Amount to pay this month: ${total != null ? money(total, lang) : 'not clear'}${due ? `, due ${due}` : ''}.`,
    )
    if (units != null && energyAmt != null) {
      parts.push(`Main part is energy charges: ${units} units for ${money(energyAmt, lang)}.`)
    } else if (units != null) {
      parts.push(`Units: ${units}.`)
    }
    if (lump.length) {
      const names = lump.map((x) => x.title).join(', ')
      parts.push(`The remaining ${money(lumpSum, lang)} covers ${names}.`)
    }
  }

  for (const a of attention) {
    parts.push(a.text)
  }

  // Same-service comparison
  if (history.length >= 2) {
    const prev = history[history.length - 2]!
    const curr = history[history.length - 1]!
    const dUnits = curr.units - prev.units
    const dTotal = curr.total_inr - prev.total_inr
    if (lang === 'te') {
      parts.push(
        `గత బిల్లు (${prev.period}): ${prev.units} యూనిట్లు, ${money(prev.total_inr, lang)}. యూనిట్లు ${dUnits >= 0 ? dUnits + ' ఎక్కువ' : Math.abs(dUnits) + ' తక్కువ'}; మొత్తం తేడా ${money(Math.abs(dTotal), lang)}.`,
      )
    } else if (lang === 'hi') {
      parts.push(
        `पिछला बिल (${prev.period}): ${prev.units} यूनिट, ${money(prev.total_inr, lang)}. यूनिट ${dUnits >= 0 ? dUnits + ' ज़्यादा' : Math.abs(dUnits) + ' कम'}; कुल अंतर ${money(Math.abs(dTotal), lang)}.`,
      )
    } else {
      parts.push(
        `Compared with ${prev.period}: ${prev.units} units, ${money(prev.total_inr, lang)}. Units ${dUnits >= 0 ? dUnits + ' more' : Math.abs(dUnits) + ' fewer'}; total difference ${money(Math.abs(dTotal), lang)}.`,
      )
    }
  }

  // Detailed explanations (for follow-ups / full dump after first beat)
  parts.push('')
  parts.push(
    lang === 'te'
      ? 'ప్రతి ఛార్జ్ వివరం:'
      : lang === 'hi'
        ? 'हर शुल्क का विवरण:'
        : 'Each charge in plain words:',
  )
  parts.push(explained.join('\n\n'))

  parts.push('')
  parts.push(
    lang === 'te'
      ? "తదుపరి బిల్లు అంచనా ఇంకా చూపను — నమ్మదగిన ఫోర్‌కాస్ట్ విధానం ధృవీకరించే వరకు గత బిల్లులు మాత్రమే. 'ఫిక్స్డ్ ఛార్జీ ఏంటి?' అని అడగొచ్చు."
      : lang === 'hi'
        ? "अगले बिल का अनुमान अभी नहीं — विश्वसनीय विधि जाँच तक सिर्फ़ पिछले बिल। 'फिक्स्ड चार्ज क्या है?' पूछ सकते हैं।"
        : "I am not showing a next-bill forecast until the method is validated on held-out bills. You can ask “What is fixed charge?” about this bill.",
  )

  parts.push(
    lang === 'te'
      ? 'ఇది సమాచారం మాత్రమే. భరోసా ఫిర్యాదు ఫైల్ చేయదు / ఆఫీసుకు పంపదు.'
      : lang === 'hi'
        ? 'यह केवल जानकारी है। भरोसा शिकायत दर्ज नहीं करता / दफ़्तर नहीं भेजता।'
        : 'This is information only. Bharosa does not file or follow up a complaint from this bill flow.',
  )

  return parts.filter(Boolean).join('\n')
}

export function answerChargeQuestion(
  text: string,
  reading: BillReading | null,
  lang: GuideLang,
  resumeConfirm = false,
): string | null {
  const q =
    /(?:what|whats|what's|explain|ఏంటి|ఏమిటి|क्या|मतलब).{0,40}(fixed|energy|duty|customer|cust|surcharge|arrears|acd|fsa|fca|subsidy|gruha|ఫిక్స్|ఎనర్జీ|డ్యూటీ|సర్.?ఛార్జ్|बकाया|फिक्स्ड|ऊर्जा)/i.test(
      text,
    ) ||
    /^(fixed|energy|duty|customer)\s*(charges?)?\??$/i.test(text.trim())
  if (!q) return null

  const pick =
    /fixed|ఫిక్స్|फिक्स्ड/i.test(text)
      ? 'FIXED CHARGES'
      : /energy|ఎనర్జీ|ऊर्जा|కరెంట్ ఛార్జ్/i.test(text)
        ? 'ENERGY CHARGES'
        : /duty|డ్యూటీ|ड्यूटी|\bed\b/i.test(text)
          ? 'ELECTRICITY DUTY'
          : /customer|cust|కస్టమర్|कस्टमर/i.test(text)
            ? 'CUSTOMER CHARGES'
            : /arrears|బకాయి|बकाया/i.test(text)
              ? 'ARREARS'
              : /acd/i.test(text)
                ? 'ACD DUE'
                : /fsa|fca/i.test(text)
                  ? 'FSA/FCA'
                  : /gruha|గృహ|गृह/i.test(text)
                    ? 'GRUHA JYOTHI'
                    : /subsidy|సబ్సిడీ|सब्सिडी/i.test(text)
                      ? 'SUBSIDY'
                      : /surcharge|సర్.?ఛార్జ్|सरचार्ज/i.test(text)
                        ? 'SURCHARGE'
                        : null

  if (!pick) return null
  const fromBill = reading?.charges.find((c) => matchKbRecord(c.label)?.match_labels.some((m) => m.includes(pick.split(' ')[0]!)) || canonicalizeIncludes(c.label, pick))
  const amount = fromBill?.amount_inr ?? null
  const ex = explainFromKb(pick, amount, lang, {
    units: reading?.units ?? null,
    loadKw: reading?.contracted_load_kw ?? null,
  })
  const resume =
    lang === 'te'
      ? '\n\nబిల్లు కొనసాగింపు: సరియైతే *Correct*, మార్పు ఉంటే *Fix* చెప్పండి.'
      : lang === 'hi'
        ? '\n\nबिल जारी: सही हो तो *Correct*, बदलाव हो तो *Fix*।'
        : '\n\nBack to your bill: reply *Correct* if the read-back is right, or *Fix* to change a value.'
  return `${ex.body}${resumeConfirm ? resume : ''}`
}

function canonicalizeIncludes(label: string, pick: string): boolean {
  return label.toUpperCase().includes(pick.split(' ')[0]!.toUpperCase())
}

/** Map internal keys → user-facing names (TC-04). */
export function userFacingField(key: string, lang: GuideLang): string {
  const k = key.toLowerCase().replace(/\s+/g, '_')
  const map: Record<string, Record<GuideLang, string>> = {
    units: { en: 'units', te: 'యూనిట్లు', hi: 'यूनिट' },
    total: { en: 'total', te: 'మొత్తం', hi: 'कुल' },
    total_inr: { en: 'total', te: 'మొత్తం', hi: 'कुल' },
    amount: { en: 'total', te: 'మొత్తం', hi: 'कुल' },
    period: { en: 'billing period', te: 'బిల్లింగ్ కాలం', hi: 'बिलिंग अवधि' },
    billing_period: { en: 'billing period', te: 'బిల్లింగ్ కాలం', hi: 'बिलिंग अवधि' },
    service: { en: 'service number', te: 'సర్వీస్ నంబర్', hi: 'सर्विस नंबर' },
    service_no: { en: 'service number', te: 'సర్వీస్ నంబర్', hi: 'सर्विस नंबर' },
    ukscno: { en: 'service number', te: 'సర్వీస్ నంబర్', hi: 'सर्विस नंबर' },
    due_date: { en: 'due date', te: 'గడువు', hi: 'नियत तारीख' },
  }
  return map[k]?.[lang] ?? key.replace(/_/g, ' ')
}
