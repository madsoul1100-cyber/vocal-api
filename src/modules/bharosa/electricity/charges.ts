/**
 * Plain-language glossary for common Telangana electricity bill line items.
 *
 * Source note (team): charge *meanings* curated from TGSPDCL / TGNPDCL consumer bill
 * layouts and public tariff FAQs. Amounts always come from the user's bill — we never
 * invent a rate. When a line is unrecognised or the calculation rule is unknown, we say so.
 *
 * Last reviewed: 2026-11-16 (meanings only; not an official tariff schedule).
 */

import type { GuideLang } from '../guide/playbooks.js'
import type { BillCharge } from './types.js'

export interface ChargeExplanation {
  code: string
  match: RegExp
  title: Record<GuideLang, string>
  /** What the charge is for — no invented rates */
  meaning: Record<GuideLang, string>
  /** How it was worked out *from this bill's figures* when units/amount are known */
  howFromBill: (args: {
    lang: GuideLang
    amount: number | null
    units: number | null
  }) => string
  known: boolean
}

function amountLine(lang: GuideLang, amount: number | null): string {
  if (amount == null || !Number.isFinite(amount)) {
    return lang === 'te'
      ? 'ఈ బిల్లులో మొత్తం స్పష్టంగా కనిపించలేదు.'
      : lang === 'hi'
        ? 'इस बिल में रकम साफ़ नहीं दिखी।'
        : 'The amount was not clear on this bill.'
  }
  const rs = `Rs ${Math.round(amount)}`
  if (lang === 'te') return `ఈ బిల్లులో ${rs} చూపించారు.`
  if (lang === 'hi') return `इस बिल में ${rs} दिखाया गया है।`
  return `This bill shows ${rs}.`
}

export const CHARGE_GLOSSARY: ChargeExplanation[] = [
  {
    code: 'energy',
    match: /energy\s*charg|current\s*charg|cc\b|విద్యుత్\s*ఛార్జ్|ఎనర్జీ|ऊर्जा\s*प्रभार|बिजली\s*शुल्क/i,
    title: {
      en: 'Energy / current charges',
      te: 'ఎనర్జీ / కరెంట్ ఛార్జీలు',
      hi: 'ऊर्जा / करंट शुल्क',
    },
    meaning: {
      en: 'This is the main charge for the electricity units you used in the billing period.',
      te: 'బిల్లింగ్ కాలంలో మీరు వాడిన యూనిట్లకు ఇది ప్రధాన ఛార్జ్.',
      hi: 'बिलिंग अवधि में आपके इस्तेमाल की गई इकाइयों का मुख्य शुल्क यही है।',
    },
    howFromBill: ({ lang, amount, units }) => {
      const a = amountLine(lang, amount)
      if (units != null && Number.isFinite(units)) {
        if (lang === 'te') return `${a} మీరు ${units} యూనిట్లు వాడారు. స్లాబ్ రేట్లు అధికారిక టారిఫ్ ప్రకారం ఉంటాయి; నేను రేట్ ఊహించను.`
        if (lang === 'hi') return `${a} आपने ${units} यूनिट इस्तेमाल किए। स्लैब दरें आधिकारिक टैरिफ के अनुसार होती हैं; मैं दर का अनुमान नहीं लगाऊँगी।`
        return `${a} You used ${units} units. Slab rates follow the official tariff; I will not invent a rate.`
      }
      return a
    },
    known: true,
  },
  {
    code: 'fixed',
    match: /fixed\s*charg|demand\s*charg|కనెక్షన్\s*ఛార్జ్|ఫిక్స్‌?డ్|नियत\s*शुल्क|फिक्स्ड/i,
    title: {
      en: 'Fixed / demand charges',
      te: 'ఫిక్స్‌డ్ / డిమాండ్ ఛార్జీలు',
      hi: 'फिक्स्ड / डिमांड शुल्क',
    },
    meaning: {
      en: 'A standing charge linked to your connection or sanctioned load, not only to how many units you used this month.',
      te: 'మీ కనెక్షన్ లేదా సాంక్షన్డ్ లోడ్‌కు సంబంధించిన స్థిర ఛార్జ్. ఈ నెల యూనిట్లు మాత్రమే కాదు.',
      hi: 'यह आपके कनेक्शन या स्वीकृत लोड से जुड़ा स्थायी शुल्क है, सिर्फ़ इस महीने की इकाइयों से नहीं।',
    },
    howFromBill: ({ lang, amount }) => amountLine(lang, amount),
    known: true,
  },
  {
    code: 'duty',
    match: /electricity\s*duty|eduty|\bed\b|విద్యుత్\s*పన్ను|विद्युत\s*शुल्क|ड्यूटी/i,
    title: {
      en: 'Electricity duty',
      te: 'విద్యుత్ పన్ను (డ్యూటీ)',
      hi: 'विद्युत शुल्क (ड्यूटी)',
    },
    meaning: {
      en: 'A government duty collected along with the bill. The discom shows the amount; the exact duty rule is set by the state.',
      te: 'బిల్లుతో వసూలు చేసే ప్రభుత్వ పన్ను. మొత్తం డిస్కం చూపిస్తుంది; నియమం రాష్ట్రం నిర్ణయిస్తుంది.',
      hi: 'बिल के साथ वसूला जाने वाला सरकारी शुल्क। रकम डिस्कॉम दिखाती है; नियम राज्य तय करता है।',
    },
    howFromBill: ({ lang, amount }) => amountLine(lang, amount),
    known: true,
  },
  {
    code: 'fsa',
    match: /fuel\s*surcharge|fsa|fppca|ఇంధన|ईंधन\s*अधिभार/i,
    title: {
      en: 'Fuel surcharge / FSA',
      te: 'ఇంధన సర్‌ఛార్జ్ / FSA',
      hi: 'ईंधन अधिभार / FSA',
    },
    meaning: {
      en: 'An adjustment linked to fuel and power-purchase costs. It appears as a separate line when the discom applies it.',
      te: 'ఇంధన / పవర్ కొనుగోలు ఖర్చుల సర్దుబాటు. డిస్కం వేస్తే వేరే లైన్‌గా కనిపిస్తుంది.',
      hi: 'ईंधन और बिजली खरीद लागत का समायोजन। डिस्कॉम लगाए तो अलग पंक्ति में दिखता है।',
    },
    howFromBill: ({ lang, amount }) => amountLine(lang, amount),
    known: true,
  },
  {
    code: 'customer',
    match: /customer\s*charg|meter\s*rent|service\s*charg|కస్టమర్|मीटर\s*किराया/i,
    title: {
      en: 'Customer / meter / service charges',
      te: 'కస్టమర్ / మీటర్ / సర్వీస్ ఛార్జీలు',
      hi: 'कस्टमर / मीटर / सेवा शुल्क',
    },
    meaning: {
      en: 'Small recurring charges for metering or customer service as printed on the bill.',
      te: 'మీటర్ లేదా కస్టమర్ సర్వీస్ కోసం బిల్లులో చూపిన చిన్న పునరావృత ఛార్జీలు.',
      hi: 'मीटर या कस्टमर सेवा के लिए बिल पर छपे छोटे आवर्ती शुल्क।',
    },
    howFromBill: ({ lang, amount }) => amountLine(lang, amount),
    known: true,
  },
  {
    code: 'arrears',
    match: /arrear|previous\s*(due|balance)|pending|బకాయి|बकाया|पिछला/i,
    title: {
      en: 'Arrears / previous balance',
      te: 'బకాయిలు / మునుపటి బ్యాలెన్స్',
      hi: 'बकाया / पिछला बैलेंस',
    },
    meaning: {
      en: 'An unpaid amount carried forward from an earlier bill. Paying this month’s bill may not clear old dues if they are listed separately.',
      te: 'మునుపటి బిల్లు నుంచి మిగిలిన చెల్లించని మొత్తం. వేరుగా ఉంటే ఈ నెల బిల్లు కట్టినా పాత బకాయి తీరకపోవచ్చు.',
      hi: 'पिछले बिल से बचा भुगतान। अलग दिखा हो तो इस महीने का बिल भरने से पुराना बकाया नहीं हट सकता।',
    },
    howFromBill: ({ lang, amount }) => amountLine(lang, amount),
    known: true,
  },
  {
    code: 'subsidy',
    match: /subsidy|rebate|credit|సబ్సిడీ|रियायत|सब्सिडी/i,
    title: {
      en: 'Subsidy / rebate / credit',
      te: 'సబ్సిడీ / రిబేట్ / క్రెడిట్',
      hi: 'सब्सिडी / छूट / क्रेडिट',
    },
    meaning: {
      en: 'An amount reduced from what you would otherwise pay, when the discom applies a subsidy or credit.',
      te: 'సబ్సిడీ లేదా క్రెడిట్ వర్తిస్తే మీరు చెల్లించవలసిన మొత్తం నుంచి తగ్గించిన భాగం.',
      hi: 'सब्सिडी या क्रेडिट लगने पर आपके भुगतान से घटाई गई राशि।',
    },
    howFromBill: ({ lang, amount }) => amountLine(lang, amount),
    known: true,
  },
]

export function matchCharge(label: string): ChargeExplanation | null {
  for (const entry of CHARGE_GLOSSARY) {
    if (entry.match.test(label)) return entry
  }
  return null
}

export function explainCharge(
  charge: BillCharge,
  lang: GuideLang,
  units: number | null,
): { title: string; body: string; known: boolean } {
  const hit = matchCharge(charge.label)
  if (!hit) {
    const unsure =
      lang === 'te'
        ? `“${charge.label}” గురించి నాకు నిశ్చయం లేదు. మీ విద్యుత్ కార్యాలయం / డిస్కంతో చూడండి. నేను రూల్ లేదా హెల్ప్‌లైన్ ఊహించను.`
        : lang === 'hi'
          ? `“${charge.label}” के बारे में मुझे यकीन नहीं। अपने बिजली कार्यालय / डिस्कॉम से जाँचें। मैं नियम या हेल्पलाइन नहीं गढ़ूँगी।`
          : `I am not sure about “${charge.label}”. Please check with your electricity office. I will not invent a rule or a helpline number.`
    return { title: charge.label, body: unsure, known: false }
  }
  const how = hit.howFromBill({ lang, amount: charge.amount_inr, units })
  return {
    title: hit.title[lang],
    body: `${hit.meaning[lang]} ${how}`.trim(),
    known: true,
  }
}

export function explainAllCharges(
  charges: BillCharge[],
  lang: GuideLang,
  units: number | null,
): string {
  if (!charges.length) {
    return lang === 'te'
      ? 'ఈ బిల్లులో వేరు వేరు ఛార్జ్ లైన్లు స్పష్టంగా చదవలేకపోయాను. మీరు ఛార్జ్ పేర్లు టైప్ చేయవచ్చు.'
      : lang === 'hi'
        ? 'इस बिल की अलग-अलग शुल्क पंक्तियाँ साफ़ नहीं पढ़ सकी। आप शुल्क के नाम टाइप कर सकते हैं।'
        : 'I could not read separate charge lines clearly on this bill. You can type the charge names.'
  }
  return charges
    .map((c, i) => {
      const ex = explainCharge(c, lang, units)
      const amt =
        c.amount_inr != null && Number.isFinite(c.amount_inr) ? ` (Rs ${Math.round(c.amount_inr)})` : ''
      return `${i + 1}. ${ex.title}${amt}: ${ex.body}`
    })
    .join('\n\n')
}
