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
      `Got it:\n• ${issue.slice(0, 200)}\n• ${location}\n\nReply *yes* when you're ready and I'll register this. Our team will pick it up and update you here.`,
    readyOneField: (issue: string) =>
      `Understood — "${issue.slice(0, 120)}${issue.length > 120 ? '…' : ''}". Where exactly is this? And if you have a photo, send it on WhatsApp — really helps.`,
    askSpecificLocation: (hint?: string) =>
      hint
        ? `"${hint}" helps, but our team needs a pinpoint — colony name, street/gali, house or shop number, or landmark near the spot (e.g. "near Charminar, Hussaini Alam, H.No 12").`
        : 'Which exact spot is this? Please share colony, street/gali, house or shop number, or a nearby landmark — not just the city name.',
    askPhoto:
      'Please send a photo of the problem here on WhatsApp — it helps our ground team verify and act faster. You can send more than one. When done (or if you cannot), reply *skip*.',
    askPhotoReminder:
      'Still waiting on a photo if you can — send it here on WhatsApp, then reply *yes* to register. Reply *skip* if not possible.',
    askPhotoNow:
      'Yes — please send your photo(s) here on WhatsApp now. I will attach them to your report. When you are done sending, reply *yes* to register (or *skip* if you have no photo).',
    photoReceivedAck:
      'Thanks — got your photo. That will help the ground team.',
    photoAttachedToTicket: (ticketNumber: string) =>
      `Thanks — your photo is now saved on ticket *${ticketNumber}*. The ground team can use it.`,
    askDuration: (issuePreview: string) =>
      `Thanks for explaining. About "${issuePreview.slice(0, 80)}…" — how long has this been going on?`,
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
    askSpecificLocation: (hint?: string) =>
      hint
        ? `"${hint}" से अंदाज़ा लगा, लेकिन टीम को सही जगह चाहिए — कॉलोनी, गली, मकान/दुकान नंबर, या नज़दीकी लैंडमार्क बताइए।`
        : 'ठीक जगह कहाँ है? कॉलोनी, गली, मकान नंबर या पास का लैंडमार्क लिखिए — सिर्फ शहर का नाम काफी नहीं।',
    askPhoto:
      'कृपया समस्या की फोटो यहीं WhatsApp पर भेज दीजिए — ग्राउंड टीम को verify करने में मदद मिलती है। एक से ज़्यादा भेज सकते हैं। हो जाए तो *yes* लिखें, नहीं तो *skip*।',
    askPhotoReminder:
      'फोटो भेज सकें तो यहीं WhatsApp पर भेज दीजिए, फिर *yes* लिखें। नहीं तो *skip* — फिर भी शिकायत दर्ज करेंगे।',
    askPhotoNow:
      'हाँ — अभी अपनी फोटो यहीं WhatsApp पर भेज दीजिए, मैं रिपोर्ट में जोड़ दूँगा/दूँगी। भेजने के बाद *yes* लिखें (या *skip* अगर फोटो नहीं है)।',
    photoReceivedAck: 'धन्यवाद — फोटो मिल गई। ग्राउंड टीम को इससे मदद मिलेगी।',
    photoAttachedToTicket: (ticketNumber: string) =>
      `धन्यवाद — फोटो टिकट *${ticketNumber}* में सेव हो गई। ग्राउंड टीम इसे देख सकती है।`,
    askDuration: (issuePreview: string) =>
      `"${issuePreview.slice(0, 80)}…" — यह कब से चल रहा है?`,
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
    askSpecificLocation: (hint?: string) =>
      hint
        ? `"${hint}" కాస్త సహాయం — కానీ బృందానికి ఖచ్చితమైన చిరునామా కావాలి: కాలనీ, గలి, ఇల్లు/షాప్ నంబర్, లేదా దగ్గరి ల్యాండ్‌మార్క్.`
        : 'ఖచ్చితంగా ఎక్కడ? కాలనీ, గలి, ఇల్లు నంబర్ లేదా పక్కన ల్యాండ్‌మార్క్ చెప్పండి — సిటీ పేరు మాత్రం సరిపోదు.',
    askPhoto:
      'దయచేసి సమస్య ఫోటో ఇక్కడే WhatsApp లో పంపండి — గ్రౌండ్ బృందానికి verify చేయడానికి సహాయం. ఒకటికంటే ఎక్కువ పంపవచ్చు. అయితే *yes* రాయండి, లేకపోతే *skip*.',
    askPhotoReminder:
      'ఫోటో పంపగలిగితే ఇప్పుడు పంపండి, తర్వాత *yes* రాయండి. లేకపోతే *skip* — ఫిర్యాదు నమోదు చేస్తాం.',
    askPhotoNow:
      'అవును — ఇప్పుడు మీ ఫోటో(లు) ఇక్కడే WhatsApp లో పంపండి. నేను రిపోర్ట్‌లో జోడిస్తాను. పంపిన తర్వాత *yes* రాయండి (లేకపోతే *skip*).',
    photoReceivedAck: 'ధన్యవాదాలు — ఫోటో వచ్చింది. గ్రౌండ్ బృందానికి ఇది సహాయపడుతుంది.',
    photoAttachedToTicket: (ticketNumber: string) =>
      `ధన్యవాదాలు — ఫోటో టికెట్ *${ticketNumber}* లో సేవ్ అయింది. గ్రౌండ్ బృందం చూడగలదు.`,
    askDuration: (issuePreview: string) =>
      `"${issuePreview.slice(0, 80)}…" — ఇది ఎప్పటి నుంచి ఉంది?`,
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
      `Theek hai:\n• ${issue.slice(0, 200)}\n• ${location}\n\nSab clear hai. Ready ho to *yes* likho — register kar dunga. Team dekhegi, yahin WhatsApp par update milega.`,
    readyOneField: (issue: string) =>
      `Samjha — "${issue.slice(0, 120)}". Exactly kahan? Photo ho to bhej dena.`,
    askSpecificLocation: (hint?: string) =>
      hint
        ? `"${hint}" thoda idea mila, par team ko exact jagah chahiye — colony, gali, house/shop number, ya paas ka landmark (jaise Charminar ke paas, Hussaini Alam, H.No 12).`
        : 'Exact spot kahan hai? Colony, gali, makan/dukan number ya nazdeek landmark batao — sirf city name kaafi nahi.',
    askPhoto:
      'Please problem ki photo yahin WhatsApp par bhej do — ground team ko verify karne mein bahut help milti hai. Ek se zyada bhej sakte ho. Ho jaye to *yes* likho, warna *skip*.',
    askPhotoReminder:
      'Photo bhej sakte ho to abhi WhatsApp par bhej do, phir *yes* likho. Nahi to *skip* — phir bhi register karenge.',
    askPhotoNow:
      'Haan — abhi apni photo(s) yahin WhatsApp par bhej do, main report mein attach kar dunga. Bhejne ke baad *yes* likho (ya *skip* agar photo nahi hai).',
    photoReceivedAck: 'Shukriya — photo mil gayi. Ground team ko isse help milegi.',
    photoAttachedToTicket: (ticketNumber: string) =>
      `Shukriya — photo ticket *${ticketNumber}* par save ho gayi. Ground team dekh sakti hai.`,
    askDuration: (issuePreview: string) =>
      `"${issuePreview.slice(0, 80)}…" — yeh kab se chal raha hai?`,
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
    askSpecificLocation: (hint?: string) =>
      hint
        ? `"${hint}" konchem help — kani team ki exact address kavali: colony, gali, inti/shop number, leda daggara landmark.`
        : 'Exact ekkada? Colony, gali, house number leda pakkana landmark cheppandi — city peru matrame saripodu.',
    askPhoto:
      'Dayachesi problem photo ikkade WhatsApp lo pampandi — ground team verify cheyadaniki help. Okatinundi ekkuva pampochu. Aithe *yes* rayandi, lekapothe *skip*.',
    askPhotoReminder:
      'Photo pampagaligite ippudu pampandi, tarvata *yes* rayandi. Lekapothe *skip* — complaint register chestam.',
    askPhotoNow:
      'Avunu — ippudu mee photo(s) ikkade WhatsApp lo pampandi. Report lo attach chestanu. Pampina tarvata *yes* rayandi (leda *skip*).',
    photoReceivedAck: 'Dhanyavadalu — photo vachindi. Ground team ki help avtundi.',
    photoAttachedToTicket: (ticketNumber: string) =>
      `Dhanyavadalu — photo ticket *${ticketNumber}* lo save ayyindi. Ground team chudagaladu.`,
    askDuration: (issuePreview: string) =>
      `"${issuePreview.slice(0, 80)}…" — eppati nunchi idi undi?`,
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
