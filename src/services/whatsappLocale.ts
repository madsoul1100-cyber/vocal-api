/**
 * WhatsApp language + copy — pure and mixed (Tinglish, Hinglish, etc.).
 */

/** Reply language tag — includes roman-script / code-mixed styles. */
export type WhatsAppLang = 'en' | 'hi' | 'te' | 'hi-en' | 'te-en'

const STAGE_LABELS: Record<WhatsAppLang, Record<string, string>> = {
  en: {
    to_do: 'Registered — awaiting review',
    in_progress: 'In progress',
    on_hold: 'On hold',
    closed: 'Closed',
  },
  hi: {
    to_do: 'दर्ज — समीक्षा की प्रतीक्षा',
    in_progress: 'कार्य जारी',
    on_hold: 'रुका हुआ',
    closed: 'बंद',
  },
  te: {
    to_do: 'నమోదు — సమీక్ష కోసం వేచి',
    in_progress: 'ప్రగతిలో ఉంది',
    on_hold: 'తాత్కాలికంగా ఆపివేయబడింది',
    closed: 'మూసివేయబడింది',
  },
  'hi-en': {
    to_do: 'Register ho gaya — review pending',
    in_progress: 'Kaam chal raha hai',
    on_hold: 'Ruka hua',
    closed: 'Band',
  },
  'te-en': {
    to_do: 'Register ayyindi — review pending',
    in_progress: 'Work progress lo undi',
    on_hold: 'Aapesaru',
    closed: 'Close ayyindi',
  },
}

const STATUS_COPY = {
  en: {
    stage: 'Stage',
    lastUpdate: 'Last update',
    issue: 'Issue',
    working:
      'Our team is on it — we’ll keep you updated here on WhatsApp. Reply *status* anytime, or tell me if something else comes up.',
    pickerTitle: '📋 *Your tickets* — reply with a number:',
    pickerFooter: '_Or send the ticket ID (e.g. DEM-2026-00025)._',
    reportPreview: 'Your report',
    notFound: (n: string) =>
      `Couldn’t find *${n}*. Reply *status* and I’ll show your tickets.`,
    noTickets:
      "You don't have a ticket yet — tell me what's going on in your area and we'll take it from there together.",
    filed: (n: string) =>
      `✅ Registered as *${n}*.\n\nOur team will review this and assign someone on the ground. We'll update you right here on WhatsApp. Reply *status* anytime.\n\nIf you have a photo of the problem, you can still send it — it really helps.`,
  },
  hi: {
    stage: 'स्थिति',
    lastUpdate: 'अंतिम अपडेट',
    issue: 'समस्या',
    working:
      'हमारी टीम इस पर काम कर रही है — WhatsApp पर अपडेट मिलता रहेगा। कभी भी *status* लिखें।',
    pickerTitle: '📋 *आपके टिकट* — नंबर भेजकर चुनें:',
    pickerFooter: '_या टिकट नंबर भेजें (जैसे DEM-2026-00025)._',
    reportPreview: 'आपकी शिकायत',
    notFound: (n: string) => `टिकट *${n}* नहीं मिला। *status* लिखकर अपने टिकट देखें।`,
    noTickets:
      'अभी कोई टिकट नहीं है — बताइए क्या समस्या है, मैं साथ में दर्ज करवा दूँगा।',
    filed: (n: string) =>
      `✅ *${n}* पर दर्ज हो गया।\n\nहमारी टीम देखेगी और ज़मीन पर कोई तैनात करेगी। अपडेट यहीं WhatsApp पर मिलेगा। *status* कभी भी लिखें।\n\nफोटो हो तो भेज दीजिए — बहुत मदद मिलती है।`,
  },
  te: {
    stage: 'స్థితి',
    lastUpdate: 'చివరి అప్‌డేట్',
    issue: 'సమస్య',
    working:
      'మా బృందం పని చేస్తోంది — WhatsApp లో అప్‌డేట్ ఇస్తూనే ఉంటాం. ఎప్పుడైనా *status* అని రాయండి.',
    pickerTitle: '📋 *మీ టికెట్లు* — నంబర్ reply చేయండి:',
    pickerFooter: '_లేదా టికెట్ ID పంపండి (ఉదా. DEM-2026-00025)._',
    reportPreview: 'మీ ఫిర్యాదు',
    notFound: (n: string) => `టికెట్ *${n}* కనుగొనలేదు. *status* అని రాయండి.`,
    noTickets: 'ఇంకా టికెట్ లేదు — మీ సమస్య చెప్పండి, కలిసి నమోదు చేద్దాం.',
    filed: (n: string) =>
      `✅ *${n}* గా నమోదు అయ్యింది.\n\nమా బృందం చూసి గ్రౌండ్ టీమ్ కూడా పంపుతుంది. అప్‌డేట్ ఇక్కడే WhatsApp లో వస్తుంది. *status* అని రాయండి.\n\nఫోటో ఉంటే పంపండి — చాలా ఉపయోగపడుతుంది.`,
  },
  'hi-en': {
    stage: 'Status',
    lastUpdate: 'Last update',
    issue: 'Problem',
    working:
      'Hamari team is par kaam kar rahi hai — yahin WhatsApp par update dete rahenge. Kabhi bhi *status* likho.',
    pickerTitle: '📋 *Aapke tickets* — number bhej kar choose karo:',
    pickerFooter: '_Ya ticket ID bhejo (jaise DEM-2026-00025)._',
    reportPreview: 'Aapki complaint',
    notFound: (n: string) => `Ticket *${n}* nahi mila. *status* likho apne tickets ke liye.`,
    noTickets:
      'Abhi koi ticket nahi — batao kya problem hai, saath mein register karwa dete hain.',
    filed: (n: string) =>
      `✅ *${n}* par register ho gaya.\n\nTeam dekhegi aur ground par kisi ko assign karegi. Update yahin WhatsApp par milega. *status* kabhi bhi likho.\n\nPhoto ho to bhej dena — bahut help hoti hai.`,
  },
  'te-en': {
    stage: 'Status',
    lastUpdate: 'Last update',
    issue: 'Problem',
    working:
      'Maa team work chestundi — ikkade WhatsApp lo updates istamu. Epuduaina *status* ani rayandi.',
    pickerTitle: '📋 *Mee tickets* — number reply cheyandi:',
    pickerFooter: '_Ledha ticket ID pampandi (e.g. DEM-2026-00025)._',
    reportPreview: 'Mee complaint',
    notFound: (n: string) => `Ticket *${n}* dorakaledu. *status* ani rayandi.`,
    noTickets:
      'Inka ticket ledu — em problem undo cheppandi, kalisi register cheddam.',
    filed: (n: string) =>
      `✅ *${n}* ga register ayyindi.\n\nMaa team chustundi, ground team kuda assign chestundi. Updates ikkade WhatsApp lo vastayi. *status* ani rayandi.\n\nPhoto unte pampandi — chala help avtundi.`,
  },
} as const

/** Conversational intake lines when OpenRouter is down (mirror user's mix). */
const INTAKE_COPY = {
  en: {
    greeting:
      "Hey! I'm here to help you report civic problems — roads, drainage, water, garbage — straight to your local team. What's been bothering you in your area? Feel free to type in English or mix languages however you like.",
    askIssue:
      "Tell me what's going on — even a few words is fine. If you can, send a photo of the problem too; it helps our team a lot.",
    ackIssueAskLocation: (preview: string) =>
      `I hear you — sounds really frustrating. "${preview}"\n\nWhich area is this in? (colony, landmark, or pin code). A photo on WhatsApp helps too if you have one.`,
    askLocationOnly:
      'Thanks for sharing the place. What problem should we report there — road, drainage, water, something else?',
    confirmSubmit: (issue: string, location: string) =>
      `Got it:\n• ${issue.slice(0, 200)}\n• ${location}\n\nReply *yes* when you're ready and I'll register this. Our team will pick it up and update you here. You can still send a photo before or after.`,
    readyOneField: (issue: string) =>
      `Understood — "${issue.slice(0, 120)}${issue.length > 120 ? '…' : ''}". Where exactly is this? And if you have a photo, send it on WhatsApp — really helps.`,
  },
  hi: {
    greeting:
      'नमस्ते! मैं आपकी सिविक समस्याएँ (सड़क, नाली, पानी) आपकी टीम तक पहुँचाने में मदद करता/करती हूँ। बताइए, क्या परेशानी है?',
    askIssue:
      'अपनी समस्या बताइए — थोड़ा भी लिखें चलेगा। हो सके तो फोटो भी भेज दीजिए।',
    ackIssueAskLocation: (preview: string) =>
      `समझ गया/गई, यह वाकई परेशान करने वाली बात है — "${preview}"\n\nयह कहाँ है? (इलाका, लैंडमार्क या पिन कोड). फोटो भेज सकें तो और अच्छा।`,
    askLocationOnly:
      'जगह के लिए धन्यवाद। वहाँ क्या समस्या दर्ज करें — सड़क, नाली, पानी?',
    confirmSubmit: (issue: string, location: string) =>
      `ठीक है:\n• ${issue.slice(0, 200)}\n• ${location}\n\nतैयार हों तो *yes* लिखें — दर्ज कर दूँगा/दूँगी। टीम देखेगी और यहीं अपडेट मिलेगा।`,
    readyOneField: (issue: string) =>
      `समझ गया — "${issue.slice(0, 120)}". कहाँ है यह? फोटो हो तो भेज दीजिए।`,
  },
  te: {
    greeting:
      'నమస్కారం! రోడ్లు, డ్రైనేజీ, నీరు, చెత్త — మీ సమస్యను స్థానిక బృందానికి చేర్చడంలో సహాయం చేస్తాను. మీ ఏరియాలో ఏమి జరుగుతోంది?',
    askIssue:
      'మీ సమస్య చెప్పండి — కొద్దిగా రాసినా సరిపోతుంది. ఫోటో ఉంటే పంపండి.',
    ackIssueAskLocation: (preview: string) =>
      `అర్థమైంది, ఇది నిజంగా బాధిస్తుంది — "${preview}"\n\nఎక్కడ? (కాలనీ, ల్యాండ్‌మార్క్ లేదా పిన్). ఫోటో ఉంటే పంపితే బాగుంటుంది.`,
    askLocationOnly:
      'ప్రాంతం కోసం ధన్యవాదాలు. అక్కడ ఏ సమస్య నమోదు చేయాలి — రోడ్, డ్రైనేజీ, నీరు?',
    confirmSubmit: (issue: string, location: string) =>
      `సరే:\n• ${issue.slice(0, 200)}\n• ${location}\n\nసిద్ధమైతే *yes* అని రాయండి — నమోదు చేస్తాను. బృందం చూసి ఇక్కడే అప్‌డేట్ ఇస్తుంది.`,
    readyOneField: (issue: string) =>
      `అర్థమైంది — "${issue.slice(0, 120)}". ఎక్కడ? ఫోటో ఉంటే పంపండి.`,
  },
  'hi-en': {
    greeting:
      'Namaste! Main aapki civic problems — road, drainage, paani — local team tak pahunchane mein help karta hoon. Kya problem hai aapke area mein? Hindi, English, mix — jaisa aapko easy ho likho.',
    askIssue:
      'Problem batao — thoda bhi likho chalega. Photo ho to WhatsApp par bhej dena, team ko bahut help milti hai.',
    ackIssueAskLocation: (preview: string) =>
      `Samajh gaya, yeh sach mein pareshan karne wali baat hai — "${preview}"\n\nKahan hai? (area, landmark ya pin). Photo bhej sakte ho to aur achha.`,
    askLocationOnly:
      'Location ke liye thanks. Wahan kya register karein — road, drainage, paani?',
    confirmSubmit: (issue: string, location: string) =>
      `Theek hai:\n• ${issue.slice(0, 200)}\n• ${location}\n\nReady ho to *yes* likho — register kar dunga. Team dekhegi, yahin WhatsApp par update milega.`,
    readyOneField: (issue: string) =>
      `Samjha — "${issue.slice(0, 120)}". Exactly kahan? Photo ho to bhej dena.`,
  },
  'te-en': {
    greeting:
      'Namaskaram! Roads, drainage, water, garbage — mee problem ni local team ki help chestanu. Mee area lo em avtundi? Telugu, English, mix — ela comfortable unte ala rayandi.',
    askIssue:
      'Problem cheppandi — konchem kuda saripothundi. Photo unte WhatsApp lo pampandi, team ki chala help avtundi.',
    ackIssueAskLocation: (preview: string) =>
      `Ardam ayyindi, idi nijanga baadistundi — "${preview}"\n\nEkkada? (colony, landmark leda pin). Photo pampite inka clear ga untundi.`,
    askLocationOnly:
      'Location ki thanks. Akkada em register cheyyali — road, drainage, water?',
    confirmSubmit: (issue: string, location: string) =>
      `Sare:\n• ${issue.slice(0, 200)}\n• ${location}\n\nReady aithe *yes* ani rayandi — register chesta. Team chusi ikkade WhatsApp lo update istaru.`,
    readyOneField: (issue: string) =>
      `Ardam ayyindi — "${issue.slice(0, 120)}". Ekkada exactly? Photo unte pampandi.`,
  },
} as const

const TE_ROMAN =
  /\b(nenu|naa|naaku|meeru|undhi|undi|ledu|ledhu|chey|cheyy|chesaru|eppudu|ela|emiti|em|problem|road|panileedu|baga|help|sare|ikkada|akkada|pamp|photo|foto|water|drainage|garbage)\b/i
const HI_ROMAN =
  /\b(meri|mera|mujhe|aap|kab|tak|hai|hogi|hoga|sadak|sarak|kharab|theek|samasy|shikayat|nikal|nahi|paani|batao|btao|problem|road|photo|foto)\b/i
const EN_MARKERS = /\b(the|when|will|please|what|how|is|are|my|your|road|water|help|status|yes|no)\b/i

export function detectWhatsAppLanguage(text: string): WhatsAppLang {
  const t = text.trim()
  if (!t) return 'en'

  const hasDevanagari = /[\u0900-\u097F]/.test(t)
  const hasTeluguScript = /[\u0C00-\u0C7F]/.test(t)
  const hasLatin = /[a-z]/i.test(t)
  const lower = t.toLowerCase()

  if (hasTeluguScript && hasLatin && !hasDevanagari) return 'te-en'
  if (hasDevanagari && hasLatin && !hasTeluguScript) return 'hi-en'
  if (hasTeluguScript) return 'te'
  if (hasDevanagari) return 'hi'

  const teHit = TE_ROMAN.test(lower)
  const hiHit = HI_ROMAN.test(lower)
  const enHit = EN_MARKERS.test(lower)

  if (teHit && (enHit || !hiHit)) return 'te-en'
  if (hiHit && (enHit || !teHit)) return 'hi-en'
  if (teHit) return 'te-en'
  if (hiHit) return 'hi-en'
  return 'en'
}

export function normalizeStoredLanguage(code: string | null | undefined): WhatsAppLang {
  if (!code) return 'en'
  const c = code.toLowerCase().replace(/[^a-z\-]/g, '')
  if (c.startsWith('te-en') || c === 'telatn' || c.includes('tinglish')) return 'te-en'
  if (c.startsWith('hi-en') || c.includes('hinglish')) return 'hi-en'
  if (c.startsWith('te')) return 'te'
  if (c.startsWith('hi')) return 'hi'
  return 'en'
}

/** Prefer language from the latest user message; fall back to conversation memory. */
export function resolveReplyLanguage(userText: string, storedLanguage?: string | null): WhatsAppLang {
  const trimmed = userText.trim()
  if (trimmed.length >= 2) return detectWhatsAppLanguage(trimmed)
  return normalizeStoredLanguage(storedLanguage)
}

export function stageLabel(stage: string, lang: WhatsAppLang): string {
  return STAGE_LABELS[lang][stage] ?? STAGE_LABELS.en[stage] ?? stage
}

export function statusCopy(lang: WhatsAppLang) {
  return STATUS_COPY[lang] ?? STATUS_COPY.en
}

export function intakeCopy(lang: WhatsAppLang) {
  return INTAKE_COPY[lang] ?? INTAKE_COPY.en
}

export function formatWhatsAppDate(iso: string, lang: WhatsAppLang): string {
  const locale =
    lang === 'hi' || lang === 'hi-en'
      ? 'hi-IN'
      : lang === 'te' || lang === 'te-en'
        ? 'te-IN'
        : 'en-IN'
  return new Date(iso).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' })
}

export function formatWhatsAppShortDate(iso: string, lang: WhatsAppLang): string {
  const locale =
    lang === 'hi' || lang === 'hi-en'
      ? 'hi-IN'
      : lang === 'te' || lang === 'te-en'
        ? 'te-IN'
        : 'en-IN'
  return new Date(iso).toLocaleDateString(locale, { day: 'numeric', month: 'short' })
}
