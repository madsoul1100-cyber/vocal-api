/**
 * WhatsApp reply language — detect from user text + localized status copy.
 */

export type WhatsAppLang = 'hi' | 'te' | 'en'

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
}

const COPY = {
  en: {
    stage: 'Stage',
    lastUpdate: 'Last update',
    issue: 'Issue',
    working:
      'Our team is working on this. Reply *status* anytime for an update, or describe a new problem to file another report.',
    pickerTitle: '📋 *Your tickets* — reply with a number:',
    pickerFooter: '_Or send the ticket ID (e.g. DEM-2026-00025)._',
    reportPreview: 'Your report',
    notFound: (n: string) =>
      `Ticket *${n}* was not found. Reply *status* to see your tickets.`,
    noTickets:
      "You don't have a ticket on record yet. Describe your civic issue and I'll help you file one.",
    filed: (n: string) =>
      `Registered as *${n}*.\n\nReply *status* anytime for an update. Our team will review and contact you if needed.`,
  },
  hi: {
    stage: 'स्थिति',
    lastUpdate: 'अंतिम अपडेट',
    issue: 'समस्या',
    working:
      'हमारी टीम इस पर काम कर रही है। कभी भी *status* लिखकर अपडेट पाएं, या नई समस्या बताएं।',
    pickerTitle: '📋 *आपके टिकट* — नंबर भेजकर चुनें:',
    pickerFooter: '_या टिकट नंबर भेजें (जैसे DEM-2026-00025)._',
    reportPreview: 'आपकी शिकायत',
    notFound: (n: string) =>
      `टिकट *${n}* नहीं मिला। अपने टिकट देखने के लिए *status* लिखें।`,
    noTickets:
      'अभी कोई टिकट दर्ज नहीं है। अपनी समस्या बताएं — मैं शिकायत दर्ज करने में मदद करूंगा।',
    filed: (n: string) =>
      `*${n}* के रूप में दर्ज हो गया।\n\nअपडेट के लिए कभी भी *status* लिखें। हमारी टीम समीक्षा करेगी।`,
  },
  te: {
    stage: 'స్థితి',
    lastUpdate: 'చివరి అప్‌డేట్',
    issue: 'సమస్య',
    working:
      'మా బృందం దీనిపై పని చేస్తోంది. ఎప్పుడైనా *status* అని రాయండి, లేదా కొత్త సమస్య చెప్పండి.',
    pickerTitle: '📋 *మీ టికెట్లు* — నంబర్ reply చేయండి:',
    pickerFooter: '_లేదా టికెట్ ID పంపండి (ఉదా. DEM-2026-00025)._',
    reportPreview: 'మీ ఫిర్యాదు',
    notFound: (n: string) =>
      `టికెట్ *${n}* కనుగొనబడలేదు. మీ టికెట్ల కోసం *status* అని రాయండి.`,
    noTickets:
      'ఇంకా టికెట్ లేదు. మీ సమస్య చెప్పండి — నేను ఫిర్యాదు నమోదు చేయడంలో సహాయం చేస్తాను.',
    filed: (n: string) =>
      `*${n}* గా నమోదు అయ్యింది.\n\nఅప్‌డేట్ కోసం ఎప్పుడైనా *status* అని రాయండి. మా బృందం సమీక్షిస్తుంది.`,
  },
} as const

export function detectWhatsAppLanguage(text: string): WhatsAppLang {
  const t = text.trim()
  if (!t) return 'en'
  if (/[\u0900-\u097F]/.test(t)) return 'hi'
  if (/[\u0C00-\u0C7F]/.test(t)) return 'te'
  const lower = t.toLowerCase()
  const hiRoman =
    /\b(meri|mera|mujhe|kab|tak|hai|hogi|hoga|sadak|sarak|kharab|theek|samasy|shikayat|nikal|nahi|paani|गली|सड़क)\b/i
  const teRoman =
    /\b(naa|naa|eppudu|chey|chesaru|sarak|panileedu|samasy|firyadu|emaina|రోడ్)\b/i
  if (hiRoman.test(lower)) return 'hi'
  if (teRoman.test(lower)) return 'te'
  return 'en'
}

export function normalizeStoredLanguage(code: string | null | undefined): WhatsAppLang {
  if (!code) return 'en'
  if (code.startsWith('hi')) return 'hi'
  if (code.startsWith('te')) return 'te'
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
  return COPY[lang]
}

export function formatWhatsAppDate(iso: string, lang: WhatsAppLang): string {
  const locale = lang === 'hi' ? 'hi-IN' : lang === 'te' ? 'te-IN' : 'en-IN'
  return new Date(iso).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' })
}

export function formatWhatsAppShortDate(iso: string, lang: WhatsAppLang): string {
  const locale = lang === 'hi' ? 'hi-IN' : lang === 'te' ? 'te-IN' : 'en-IN'
  return new Date(iso).toLocaleDateString(locale, { day: 'numeric', month: 'short' })
}
