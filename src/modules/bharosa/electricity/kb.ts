/**
 * Electricity-bill knowledge base (manager package 17 Nov 2026).
 * Runtime source of truth. Mirror: docs/bharosa-electricity-kb.yaml
 *
 * Status gates explanation — never invent; never hide attention lines.
 */

import type { GuideLang } from '../guide/playbooks.js'

export type KbStatus =
  | 'official'
  | 'secondary'
  | 'partial'
  | 'unverified'
  | 'disabled'
  | 'structural'

export interface KbRecord {
  id: string
  match_labels: string[]
  status: KbStatus
  /** Attention line: always show amount individually, never bury in lump */
  attention?: boolean
  /** Small known charge: may be lumped in first message */
  lumpable?: boolean
  meaning: Record<GuideLang, string>
  when: Record<GuideLang, string>
  allowed: string[]
  not_allowed: string[]
  sources: string[]
  applicability?: {
    categories?: string[]
    discoms?: string[]
    note?: string
  }
}

function normLabel(label: string): string {
  return label
    .toUpperCase()
    .replace(/[.\u2013\u2014]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export const ELECTRICITY_KB: KbRecord[] = [
  {
    id: 'kb-energy-charges',
    match_labels: ['ENERGY CHARGES', 'ENERGY CHARGE', 'CURRENT CHARGES'],
    status: 'official',
    lumpable: false,
    meaning: {
      en: 'This is the main charge for the electricity units you used this month.',
      te: 'ఈ నెల మీరు వాడిన యూనిట్లకు ఇది ప్రధాన కరెంట్ ఛార్జీ.',
      hi: 'इस महीने इस्तेमाल की गई यूनिटों का मुख्य बिजली शुल्क यही है।',
    },
    when: {
      en: 'Say with the printed units and amount from this bill. Do not invent slab rates unless the domestic rate table applicability matches.',
      te: 'ఈ బిల్లులోని యూనిట్లు మరియు మొత్తంతో చెప్పండి. సరిపోయే టారిఫ్ లేకుండా స్లాబ్ రేట్ ఊహించవద్దు.',
      hi: 'इस बिल की यूनिट और रकम के साथ बताएँ। लागू टैरिफ के बिना स्लैब दर न गढ़ें।',
    },
    allowed: ['explain_with_printed_amount', 'compare_units'],
    not_allowed: ['invent_slab_rate_for_commercial'],
    sources: ['https://tgsouthernpower.org/resources/PDF/Tariffs/69tarifffile.pdf'],
  },
  {
    id: 'kb-fixed-charges',
    match_labels: ['FIXED CHARGES', 'FIXED CHARGE'],
    status: 'official',
    lumpable: true,
    meaning: {
      en: 'A monthly fixed fee for your connection load — charged whether or not you used much power.',
      te: 'మీ కనెక్షన్ లోడ్‌కు ప్రతీ నెలా కట్టే ఫిక్స్డ్ ఛార్జీ — కరెంటు ఎక్కువ వాడినా తక్కువ వాడినా.',
      hi: 'आपके कनेक्शन लोड का मासिक फिक्स्ड शुल्क — बिजली कम या ज़्यादा इस्तेमाल पर भी लगता है।',
    },
    when: {
      en: 'Explain with the printed amount. Mention load only if the bill shows contracted load.',
      te: 'బిల్లులోని మొత్తంతో చెప్పండి. కాంట్రాక్టెడ్ లోడ్ ఉంటే మాత్రమే చెప్పండి.',
      hi: 'बिल की रकम के साथ बताएँ। कॉन्ट्रैक्टेड लोड दिखे तभी कहें।',
    },
    allowed: ['explain_with_printed_amount'],
    not_allowed: ['invent_per_kw_rate_unless_official_table_applies'],
    sources: ['https://tgsouthernpower.org/resources/PDF/Tariffs/69tarifffile.pdf'],
  },
  {
    id: 'kb-customer-charges',
    match_labels: ['CUSTOMER CHARGES', 'CUST CHARGES', 'CUST. CHARGES', 'CUST.', 'CUSTOMER CHARGE'],
    status: 'secondary',
    lumpable: true,
    meaning: {
      en: 'A monthly customer / service charge shown on the bill.',
      te: 'బిల్లులో చూపిన నెలవారీ కస్టమర్ / సర్వీస్ ఛార్జీ.',
      hi: 'बिल पर दिखाया गया मासिक कस्टमर / सेवा शुल्क।',
    },
    when: {
      en: 'Name it and show the printed amount. Do not quote band values until re-verified against the order text.',
      te: 'పేరు చెప్పి బిల్లు మొత్తం చూపండి. ఆర్డర్ టెక్స్ట్ రీ-వెరిఫై అయ్యే వరకు బ్యాండ్ రేట్లు చెప్పవద్దు.',
      hi: 'नाम बताकर बिल की रकम दिखाएँ। ऑर्डर टेक्स्ट दोबारा जाँच तक बैंड दरें न बताएँ।',
    },
    allowed: ['name_and_printed_amount'],
    not_allowed: ['quote_unverified_band_rupees'],
    sources: [
      'https://thediscombill.com/tariffs/telangana/tsspdcl/',
      'https://billunits.in/state-calculators/tsspdcl-bill-calculator/',
    ],
  },
  {
    id: 'kb-electricity-duty',
    match_labels: ['ELECTRICITY DUTY', 'ELECTRICI DUTY', 'ED', 'E D'],
    status: 'secondary',
    lumpable: true,
    meaning: {
      en: 'Electricity duty — a tax collected with the bill, separate from the tariff energy charge.',
      te: 'విద్యుత్ పన్ను (డ్యూటీ) — టారిఫ్ ఛార్జీకి అదనంగా బిల్లుతో వసూలు అయ్యే పన్ను.',
      hi: 'विद्युत शुल्क (ड्यूटी) — टैरिफ ऊर्जा शुल्क से अलग, बिल के साथ वसूला जाने वाला कर।',
    },
    when: {
      en: 'Show printed amount. Do not quote 6 paise/unit in production until re-verified against the order text.',
      te: 'బిల్లు మొత్తం చూపండి. ఆర్డర్ టెక్స్ట్ రీ-వెరిఫై అయ్యే వరకు 6 పైసలు/యూనిట్ చెప్పవద్దు.',
      hi: 'बिल की रकम दिखाएँ। ऑर्डर टेक्स्ट जाँच तक 6 पैसे/यूनिट न बताएँ।',
    },
    allowed: ['name_and_printed_amount', 'say_it_is_extra_to_tariff'],
    not_allowed: ['quote_unverified_paise_rate'],
    sources: [
      'https://tgsouthernpower.org/resources/PDF/Tariffs/69tarifffile.pdf',
      'https://indiacode.ecourtsindia.com/telangana-electricity-duty-act-1939/',
    ],
  },
  {
    id: 'kb-ed-interest',
    match_labels: ['ED INTEREST', 'EDINT', 'INTEREST ON ED', 'INTEREST ON ELECTRICITY DUTY'],
    status: 'secondary',
    attention: true,
    meaning: {
      en: 'Interest on electricity duty — separate from the duty itself.',
      te: 'విద్యుత్ పన్నుపై వడ్డీ — పన్ను మొత్తానికి వేరు.',
      hi: 'विद्युत शुल्क पर ब्याज — खुद शुल्क से अलग।',
    },
    when: {
      en: 'One-line meaning + printed amount. Never reuse the electricity-duty explanation.',
      te: 'ఒక వాక్యం అర్థం + బిల్లు మొత్తం. డ్యూటీ వివరణను ఇక్కడ వాడవద్దు.',
      hi: 'एक पंक्ति अर्थ + बिल की रकम। ड्यूटी की व्याख्या यहाँ न दोहराएँ।',
    },
    allowed: ['one_line_meaning', 'printed_amount'],
    not_allowed: ['inherit_duty_rate_explanation'],
    sources: [
      'https://www.hindustantimes.com/telugu/telangana/do-you-know-how-your-electricity-bill-is-calculated-tgspdcl-explained-261780883423018.html',
    ],
  },
  {
    id: 'kb-fca-fsa',
    match_labels: ['FCA', 'FSA', 'FSA/FCA CHARGES', 'FCA CHARGES', 'FSA CHARGES', 'FSA/FCA'],
    status: 'official',
    lumpable: true,
    meaning: {
      en: 'Fuel / power-purchase adjustment (FCA/FSA) when the discom applies it.',
      te: 'ఇంధన / పవర్ కొనుగోలు సర్దుబాటు (FCA/FSA) — డిస్కం వేస్తే.',
      hi: 'ईंधन / बिजली खरीद समायोजन (FCA/FSA) — डिस्कॉम लगाए तो।',
    },
    when: {
      en: 'Existence is official; show printed amount only — no unverified rate claims.',
      te: 'ఉనికి అధికారికం; బిల్లు మొత్తం మాత్రమే — రేట్ ఊహించవద్దు.',
      hi: 'अस्तित्व आधिकारिक है; सिर्फ़ बिल की रकम — दर न गढ़ें।',
    },
    allowed: ['name_and_printed_amount'],
    not_allowed: ['invent_fca_rate'],
    sources: ['https://tgsouthernpower.org/resources/PDF/Tariffs/69tarifffile.pdf'],
  },
  {
    id: 'kb-true-up',
    match_labels: ['TRUE-UP CHARGES', 'TRUE UP CHARGES', 'TRUEUP', 'TRUUP', 'TRUE-UP'],
    status: 'disabled',
    attention: true,
    meaning: {
      en: 'A true-up line appears on this bill.',
      te: 'ఈ బిల్లులో ట్రూఅప్ ఛార్జీ లైన్ ఉంది.',
      hi: 'इस बिल पर ट्रू-अप शुल्क पंक्ति है।',
    },
    when: {
      en: 'Show label + printed amount only. No rates, duration, or exemptions until the TGERC order dated 5 Oct 2026 is read.',
      te: 'లేబుల్ + మొత్తం మాత్రమే. 5 Oct 2026 TGERC ఆర్డర్ చదివే వరకు రేట్/కాలం/మినహాయింపు చెప్పవద్దు.',
      hi: 'लेबल + रकम ही। 5 Oct 2026 TGERC ऑर्डर पढ़े बिना दर/अवधि/छूट न बताएँ।',
    },
    allowed: ['show_printed_line'],
    not_allowed: ['quote_rates', 'quote_duration', 'quote_gruha_jyothi_exemption'],
    sources: [
      'https://www.thehindu.com/news/national/telangana/monthly-electricity-bills-in-telangana-to-become-heavy-from-november-2026-erc-approves-true-up-charges-recovery/article71550236.ece',
    ],
  },
  {
    id: 'kb-dps',
    match_labels: ['DPS', 'DELAYED PAYMENT SURCHARGE', 'DELAYED PAYMENT'],
    status: 'official',
    attention: true,
    meaning: {
      en: 'Delayed payment surcharge for paying after the due date.',
      te: 'గడువు తర్వాత కట్టితే వచ్చే డిలేడ్ పేమెంట్ సర్‌ఛార్జ్.',
      hi: 'नियत तारीख के बाद भुगतान पर विलंब अधिभार।',
    },
    when: {
      en: 'Existence official; show printed amount; do not invent the rate.',
      te: 'ఉనికి అధికారికం; మొత్తం చూపండి; రేట్ ఊహించవద్దు.',
      hi: 'अस्तित्व आधिकारिक; रकम दिखाएँ; दर न गढ़ें।',
    },
    allowed: ['name_and_printed_amount'],
    not_allowed: ['invent_dps_rate'],
    sources: ['https://tgsouthernpower.org/resources/PDF/Tariffs/69tarifffile.pdf'],
  },
  {
    id: 'kb-surcharge',
    match_labels: ['SURCHARGE'],
    status: 'unverified',
    attention: true,
    meaning: {
      en: 'A surcharge line is printed on the bill.',
      te: 'బిల్లులో సర్‌ఛార్జ్ లైన్ ఉంది.',
      hi: 'बिल पर सरचार्ज पंक्ति छपी है।',
    },
    when: {
      en: 'Show label + amount. Never assume it means DPS without verified label context.',
      te: 'లేబుల్ + మొత్తం. నిర్ధారణ లేకుండా DPS అని అనుకోవద్దు.',
      hi: 'लेबल + रकम। बिना पुष्टि DPS न मानें।',
    },
    allowed: ['show_printed_line'],
    not_allowed: ['assume_dps'],
    sources: [],
  },
  {
    id: 'kb-arrears',
    match_labels: ['ARREARS', 'ARREARS AFTER', 'ARREARS AS ON', 'PREVIOUS BALANCE'],
    status: 'structural',
    attention: true,
    meaning: {
      en: 'Unpaid amount carried from earlier bills.',
      te: 'మునుపటి బిల్లుల నుంచి మిగిలిన బకాయి.',
      hi: 'पिछले बिलों से बचा बकाया।',
    },
    when: {
      en: 'Always show with printed amount. Paying this month’s bill may not clear old dues.',
      te: 'మొత్తంతో చూపండి. ఈ నెల బిల్లు కట్టినా పాత బకాయి తీరకపోవచ్చు.',
      hi: 'रकम के साथ दिखाएँ। इस महीने का बिल भरने से पुराना बकाया नहीं हट सकता।',
    },
    allowed: ['show_printed_line', 'warn_may_remain'],
    not_allowed: [],
    sources: [],
  },
  {
    id: 'kb-int-on-sd',
    match_labels: ['INT. ON SD', 'INT ON SD', 'INTEREST ON SD', 'INTEREST ON CD', 'INT. ON CD'],
    status: 'secondary',
    lumpable: true,
    meaning: {
      en: 'Interest related to the security / consumption deposit.',
      te: 'సెక్యూరిటీ / కన్జంప్షన్ డిపాజిట్‌పై వడ్డీ.',
      hi: 'सिक्योरिटी / कंजम्पशन डिपॉजिट पर ब्याज।',
    },
    when: {
      en: 'One-line meaning + printed amount. Do not invent mechanics.',
      te: 'ఒక వాక్యం + మొత్తం. మెకానిక్స్ ఊహించవద్దు.',
      hi: 'एक पंक्ति + रकम। यांत्रिकी न गढ़ें।',
    },
    allowed: ['one_line_meaning', 'printed_amount'],
    not_allowed: ['invent_interest_formula'],
    sources: [
      'https://www.tgsouthernpower.org/resources/PDF/Tarrif_Regulations/GTCS%20Consolidated%20version%20as%20on%2001-03-2019.pdf',
    ],
  },
  {
    id: 'kb-acd-due',
    match_labels: ['ACD DUE', 'ADDITIONAL CONSUMPTION DEPOSIT', 'ACD'],
    status: 'partial',
    attention: true,
    meaning: {
      en: 'Additional consumption deposit (ACD) due.',
      te: 'అదనపు కన్జంప్షన్ డిపాజిట్ (ACD) బకాయి.',
      hi: 'अतिरिक्त कंजम्पशन डिपॉजिट (ACD) बकाया।',
    },
    when: {
      en: 'Name only + printed amount. Do not explain mechanics.',
      te: 'పేరు + మొత్తం మాత్రమే. మెకానిక్స్ చెప్పవద్దు.',
      hi: 'नाम + रकम ही। यांत्रिकी न बताएँ।',
    },
    allowed: ['name_and_printed_amount'],
    not_allowed: ['explain_deposit_rules'],
    sources: [],
  },
  {
    id: 'kb-acd-surcharges',
    match_labels: ['ACD SURCHARGES', 'ACD SURCHARGE'],
    status: 'unverified',
    attention: true,
    meaning: {
      en: 'An ACD surcharge line is printed.',
      te: 'ACD సర్‌ఛార్జ్ లైన్ చూపబడింది.',
      hi: 'ACD सरचार्ज पंक्ति छपी है।',
    },
    when: {
      en: 'Show plainly. Never inherit ACD DUE deposit wording.',
      te: 'స్పష్టంగా చూపండి. ACD DUE వివరణను వాడవద్దు.',
      hi: 'साफ़ दिखाएँ। ACD DUE की व्याख्या न लें।',
    },
    allowed: ['show_printed_line'],
    not_allowed: ['inherit_acd_due_wording'],
    sources: [],
  },
  {
    id: 'kb-int-on-acd',
    match_labels: ['INT. ON ACD', 'INT ON ACD', 'INTEREST ON ACD'],
    status: 'unverified',
    attention: true,
    meaning: {
      en: 'An interest-on-ACD line is printed.',
      te: 'ACDపై వడ్డీ లైన్ చూపబడింది.',
      hi: 'ACD पर ब्याज पंक्ति छपी है।',
    },
    when: {
      en: 'Show plainly. Never inherit INT. ON SD wording.',
      te: 'స్పష్టంగా చూపండి. INT. ON SD వివరణను వాడవద్దు.',
      hi: 'साफ़ दिखाएँ। INT. ON SD की व्याख्या न लें।',
    },
    allowed: ['show_printed_line'],
    not_allowed: ['inherit_int_on_sd_wording'],
    sources: [],
  },
  {
    id: 'kb-gruha-jyothi',
    match_labels: ['GRUHA JYOTHI', 'GRUHA JYOTHI SUBSIDY', 'GJ SUBSIDY', 'GRUHA JYOTHI SUBSIDY'],
    status: 'official',
    attention: true,
    meaning: {
      en: 'Gruha Jyothi subsidy credit as printed on the bill.',
      te: 'బిల్లులో చూపిన గృహజ్యోతి సబ్సిడీ క్రెడిట్.',
      hi: 'बिल पर छपी गृह ज्योति सब्सिडी क्रेडिट।',
    },
    when: {
      en: 'Scheme label + printed amount only. Never assume eligibility. True-up exemption stays disabled.',
      te: 'పథకం లేబుల్ + మొత్తం. అర్హత ఊహించవద్దు. ట్రూఅప్ మినహాయింపు disabled.',
      hi: 'योजना लेबल + रकम। पात्रता न मानें। ट्रू-अप छूट disabled।',
    },
    allowed: ['name_and_printed_amount'],
    not_allowed: ['infer_eligibility', 'claim_true_up_exemption'],
    sources: ['https://mahabubnagar.telangana.gov.in/scheme/gruha-jyothi-scheme/'],
  },
  {
    id: 'kb-subsidy',
    match_labels: ['SUBSIDY'],
    status: 'structural',
    attention: true,
    meaning: {
      en: 'A subsidy credit as printed.',
      te: 'బిల్లులో చూపిన సబ్సిడీ క్రెడిట్.',
      hi: 'बिल पर छपी सब्सिडी क्रेडिट।',
    },
    when: {
      en: 'Printed credit only. Never equate with Gruha Jyothi or infer eligibility.',
      te: 'ప్రింటెడ్ క్రెడిట్ మాత్రమే. గృహజ్యోతితో సమం చేయవద్దు.',
      hi: 'सिर्फ़ छपी क्रेडिट। गृह ज्योति से न जोड़ें।',
    },
    allowed: ['show_printed_line'],
    not_allowed: ['equate_gruha_jyothi', 'infer_eligibility'],
    sources: [],
  },
  {
    id: 'kb-totals',
    match_labels: ['BILL AMOUNT', 'NET', 'NET BILL AMOUNT', 'TOTAL', 'TOTAL DUE', 'TOTAL AMOUNT DUE', 'NET AMOUNT'],
    status: 'structural',
    lumpable: false,
    meaning: {
      en: 'A total / net line on the bill.',
      te: 'బిల్లు మొత్తం / నెట్ లైన్.',
      hi: 'बिल का कुल / नेट पंक्ति।',
    },
    when: {
      en: 'State once as totals. Never itemize as a charge explanation.',
      te: 'మొత్తంగా ఒక్కసారి చెప్పండి. ఛార్జ్ వివరణలా చెప్పవద్దు.',
      hi: 'कुल के रूप में एक बार। शुल्क व्याख्या न बनाएँ।',
    },
    allowed: ['state_as_total'],
    not_allowed: ['itemize_as_charge'],
    sources: [],
  },
  {
    id: 'kb-loss-gain',
    match_labels: ['LOSS/GAIN', 'LOSS GAIN', 'LOSS', 'GAIN'],
    status: 'structural',
    lumpable: true,
    meaning: {
      en: 'A rounding loss/gain line.',
      te: 'రౌండింగ్ LOSS/GAIN లైన్.',
      hi: 'राउंडिंग LOSS/GAIN पंक्ति।',
    },
    when: {
      en: 'Show only if the user asks or it materially affects reconciliation.',
      te: 'అడిగితే లేదా మొత్తం సరిపోలికకు అవసరమైతే మాత్రమే.',
      hi: 'पूछे या मिलान पर असर हो तभी।',
    },
    allowed: ['show_if_asked_or_material'],
    not_allowed: [],
    sources: [],
  },
  {
    id: 'kb-addl-charges',
    match_labels: ['ADDL. CHARGES', 'ADDL CHARGES', 'ADDITIONAL CHARGES'],
    status: 'unverified',
    attention: true,
    meaning: {
      en: 'An additional-charges line is printed.',
      te: 'అదనపు ఛార్జీల లైన్ చూపబడింది.',
      hi: 'अतिरिक्त शुल्क पंक्ति छपी है।',
    },
    when: {
      en: 'Show plainly with amount. Never guess the meaning.',
      te: 'మొత్తంతో స్పష్టంగా చూపండి. అర్థం ఊహించవద్దు.',
      hi: 'रकम के साथ साफ़ दिखाएँ। अर्थ न गढ़ें।',
    },
    allowed: ['show_printed_line'],
    not_allowed: ['guess_meaning'],
    sources: [],
  },
  {
    id: 'kb-dc-amt-gst',
    match_labels: ['DC AMT + GST', 'DC AMT', 'DC AMOUNT'],
    status: 'unverified',
    attention: true,
    meaning: {
      en: 'A DC amount + GST line is printed.',
      te: 'DC amount + GST లైన్ చూపబడింది.',
      hi: 'DC राशि + GST पंक्ति छपी है।',
    },
    when: {
      en: 'Show plainly with amount. Never guess.',
      te: 'మొత్తంతో స్పష్టంగా. ఊహించవద్దు.',
      hi: 'रकम के साथ साफ़। अनुमान न लगाएँ।',
    },
    allowed: ['show_printed_line'],
    not_allowed: ['guess_meaning'],
    sources: [],
  },
]

/** Normalize OCR noise toward known labels (ACD/BCD/RCD → ACD when SURCHARGES). */
export function canonicalizeLabel(raw: string): string {
  let s = normLabel(raw)
  s = s.replace(/\b[BR]CD\b/g, 'ACD') // TC-03 flicker: BCD/RCD → ACD
  s = s.replace(/\bELECTRICI DUTY\b/g, 'ELECTRICITY DUTY')
  s = s.replace(/\bCUST\.?\b(?!\s*CHARGES)/g, 'CUST CHARGES')
  if (s === 'CUST' || s === 'CUST.') s = 'CUST CHARGES'
  if (s === 'EDINT') s = 'ED INTEREST'
  return s
}

export function matchKbRecord(label: string): KbRecord | null {
  const canon = canonicalizeLabel(label)
  for (const rec of ELECTRICITY_KB) {
    for (const m of rec.match_labels) {
      if (normLabel(m) === canon) return rec
    }
  }
  // Fuzzy contains for longer labels like "ARREARS after 01-04-2023"
  for (const rec of ELECTRICITY_KB) {
    for (const m of rec.match_labels) {
      const nm = normLabel(m)
      if (nm.length >= 4 && (canon.includes(nm) || nm.includes(canon))) return rec
    }
  }
  return null
}

export function allKnownLabels(): string[] {
  return ELECTRICITY_KB.flatMap((r) => r.match_labels)
}

export function explainFromKb(
  label: string,
  amount: number | null,
  lang: GuideLang,
  ctx?: { units?: number | null; loadKw?: number | null },
): { title: string; body: string; status: KbStatus | 'unknown'; attention: boolean; lumpable: boolean } {
  const rec = matchKbRecord(label)
  const amt =
    amount != null && Number.isFinite(amount)
      ? lang === 'te'
        ? `₹${Math.round(amount * 100) / 100}`
        : `Rs ${Math.round(amount * 100) / 100}`
      : null

  if (!rec) {
    const unsure =
      lang === 'te'
        ? `“${label}”${amt ? ` (${amt})` : ''} గురించి నాకు నిశ్చయం లేదు. మీ విద్యుత్ కార్యాలయంతో చూడండి. నేను రూల్ ఊహించను.`
        : lang === 'hi'
          ? `“${label}”${amt ? ` (${amt})` : ''} के बारे में यकीन नहीं। बिजली कार्यालय से जाँचें। मैं नियम नहीं गढ़ूँगी।`
          : `I am not sure about “${label}”${amt ? ` (${amt})` : ''}. Please check with your electricity office. I will not invent a rule.`
    return { title: label, body: unsure, status: 'unknown', attention: true, lumpable: false }
  }

  const title = rec.match_labels[0] ?? label
  if (rec.status === 'unverified' || rec.status === 'disabled') {
    const plain =
      lang === 'te'
        ? `బిల్లులో “${title}”${amt ? `: ${amt}` : ''} కనిపిస్తుంది. ధృవీకరించిన వివరణ ఇంకా లేదు — ఊహించను.`
        : lang === 'hi'
          ? `बिल पर “${title}”${amt ? `: ${amt}` : ''} है। सत्यापित व्याख्या अभी नहीं — अनुमान नहीं लगाऊँगी।`
          : `The bill shows “${title}”${amt ? `: ${amt}` : ''}. A verified explanation is not available yet — I will not invent one.`
    return { title, body: plain, status: rec.status, attention: true, lumpable: false }
  }

  if (rec.status === 'partial') {
    const body =
      lang === 'te'
        ? `${rec.meaning.te}${amt ? ` బిల్లులో ${amt}.` : ''} వివరాలు ఇంకా పూర్తి కాలేదు.`
        : lang === 'hi'
          ? `${rec.meaning.hi}${amt ? ` बिल में ${amt}.` : ''} विस्तृत नियम अभी पूरे नहीं।`
          : `${rec.meaning.en}${amt ? ` Printed amount: ${amt}.` : ''} Detailed rules are not complete yet.`
    return { title, body, status: rec.status, attention: !!rec.attention, lumpable: false }
  }

  // official / secondary / structural — secondary must not quote unverified numbers
  let body = rec.meaning[lang]
  if (amt) {
    body +=
      lang === 'te' ? ` ఈ బిల్లులో ${amt}.` : lang === 'hi' ? ` इस बिल में ${amt}.` : ` This bill shows ${amt}.`
  }
  if (rec.id === 'kb-energy-charges' && ctx?.units != null) {
    body +=
      lang === 'te'
        ? ` మీరు ${ctx.units} యూనిట్లు వాడారు.`
        : lang === 'hi'
          ? ` आपने ${ctx.units} यूनिट इस्तेमाल की।`
          : ` You used ${ctx.units} units.`
  }
  if (rec.id === 'kb-fixed-charges' && ctx?.loadKw != null) {
    body +=
      lang === 'te'
        ? ` బిల్లులో లోడ్ సుమారు ${ctx.loadKw} kW.`
        : lang === 'hi'
          ? ` बिल पर लोड लगभग ${ctx.loadKw} kW.`
          : ` The bill shows about ${ctx.loadKw} kW load.`
  }
  if (rec.status === 'secondary') {
    body +=
      lang === 'te'
        ? ' (వివరాల రేట్లు ఆర్డర్ టెక్స్ట్ రీ-వెరిఫై అయ్యే వరకు చెప్పను.)'
        : lang === 'hi'
          ? ' (विस्तृत दरें ऑर्डर जाँच तक नहीं बताऊँगी।)'
          : ' (I will not quote detailed rates until re-verified against the order text.)'
  }

  return {
    title,
    body,
    status: rec.status,
    attention: !!rec.attention,
    lumpable: !!rec.lumpable && !rec.attention,
  }
}
