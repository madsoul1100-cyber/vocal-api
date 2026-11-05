import { z } from 'zod'
import {
  absorbIntakeSlots,
  declinesName,
  extractEmail,
  extractNamedIntro,
  extractPhone,
  extractPlace,
  isPlaceReplyForCurrentIssue,
  isShortGreeting,
  isVaguePlace,
  looksLikeAddress,
  looksLikeProblem,
  looksOutsideTelangana,
  problemNeedsArea,
  wantsContinue,
  wantsNewIssue,
} from '@/lib/citizenIntakeLadder.js'
import { difyIntakeClassify } from '../ai/difyClient.js'
import { llmJson, llmText } from '../ai/llm.js'
import {
  enrichMemoryWithOpenClaw,
  ensureCitizenMemory,
  memoryContextForPrompt,
  memoryWelcomeLine,
  touchCitizenMemory,
  type CitizenMemoryProfile,
} from '../companion/citizenMemory.js'
import { replyToForThread, sendEmail } from '../comms/emailProvider.js'
import {
  formatHistoryReply,
  isMetaOrNonIssue,
  listCitizenHistory,
  loadFocusedCaseDetail,
  parseCaseSelection,
  wantsHistoryList,
  wantsSeeMore,
  type GuideCaseChoice,
} from './history.js'
import {
  matchPlaybook,
  PLAYBOOKS,
  playbookById,
  type GuideContact,
  type GuideLang,
  type Playbook,
} from './playbooks.js'
import { buildGuideSystemPrompt, GUIDE_PROMPT_VERSION } from './prompts.js'
import { isLifestyleOutOfScopeQuery, searchPublicWeb, type WebHit } from './search.js'
import { clipAtSentence, dropDanglingTail, groupPhoneNumbers } from './text.js'
import {
  appendGuideMessage,
  createGuideSession,
  findIncompleteGuideSession,
  listGuideMessages,
  listPriorGuideCases,
  loadGuideSession,
  previousGuideTopic,
  saveGuideSession,
  type GuideContactInfo,
  type GuideDraft,
  type GuideMessage,
  type GuideSession,
  type PriorGuideCase,
} from './store.js'

const SATISFIED = /\b(this helped|that helped|solved|i'm good|im good|close (the )?(chat|this)|no more questions)\b|పరిష్కారమైంది|సరిపోయింది|ఇంకా అవసరం లేదు|हो गया|सुलझ गया|बस इतना ही/i
const THANKS_ONLY =
  /^(thanks|thank you|thx|tysm|ok thanks|okay thanks|धन्यवाद|ధన్యవాదాలు|शुक्रिया)\s*[!.]*$/i
const ANOTHER_PROBLEM =
  /\b(one more|another|new problem|other problem|different problem|next problem|also have|i have (a |one )?more|stuck to old|why you still|change (the )?topic|something else)\b|మరో సమస్య|ఇంకో సమస్య|दूसरी समस्या|और (एक )?समस्या/i
const WANTS_RECORD =
  /e-?mail the|send (a |the )?mail|raise (it|this|complaint|a complaint)|record (it|this)|note (it|this) (here|down)|on your side|you (will |can )?raise|please raise|better authority|ఇమెయిల్ పంప|మీ వైపు నమోదు|ईमेल भेज|आपकी तरफ दर्ज|शिकायत दर्ज/i

/** Truly unrelated to citizen / local Telangana help — hard divert (LLM alone is too soft). */
const OFF_TOPIC =
  /\b(python|javascript|java|c\+\+|golang|rust|sql query|leetcode|hackerrank|write (me )?(code|a function|an essay)|debug (this|my) code|solve (this )?(math|equation|integral)|calculus|homework|stock tip|crypto trade|medical diagnos|prescribe)\b/i

/**
 * Boundary replies (Rule 6): one or two warm sentences, what Bharosa does once, the closest
 * useful pointer. No capability lists, no scolding, no chatbot comparisons.
 */
function offTopicReply(lang: GuideLang, name: string): string {
  const who = name ? `, ${name}` : ''
  if (lang === 'te') {
    return `ఇది నా పరిధిలో లేదు${who}. కానీ కరెంట్, నీళ్లు, రోడ్లు, రేషన్, ఆధార్ లాంటి తెలంగాణ ప్రభుత్వ సేవల్లో ఏదైనా ఆగిపోతే చెప్పండి, సరైన నంబర్ ఇస్తాను.`
  }
  if (lang === 'hi') {
    return `यह मेरे दायरे से बाहर है${who}। बिजली, पानी, सड़क, राशन, आधार जैसी तेलंगाना की सरकारी सेवा में कुछ अटका हो तो बताइए, सही नंबर दूँगी।`
  }
  return `That one is outside what I do${who}. If anything with Telangana public services is stuck, like power, water, roads, ration or Aadhaar, tell me and I will give you the right number.`
}

/** Movies, salons, personal fights, lifestyle — one warm line and one useful pointer. */
function civicScopeRedirect(lang: GuideLang, name: string): string {
  const who = name ? `, ${name}` : ''
  if (lang === 'te') {
    return `దాని గురించి నేను సహాయం చేయలేను${who}. తెలంగాణ ప్రభుత్వ సేవల్లో ఏదైనా సమస్య ఉంటే చెప్పండి, అది చూద్దాం.`
  }
  if (lang === 'hi') {
    return `इसमें मैं मदद नहीं कर पाऊँगी${who}। तेलंगाना की सरकारी सेवाओं में कोई समस्या हो तो बताइए, वह देखते हैं।`
  }
  return `I can't help with that one${who}. If something with a Telangana public service is stuck, tell me and we will sort it out.`
}

function outsideTelanganaReply(lang: GuideLang, name: string): string {
  const who = name ? `, ${name}` : ''
  if (lang === 'te') {
    return `నేను తెలంగాణ లోని సమస్యలకే సహాయం చేయగలను${who}. వేరే రాష్ట్రం అయితే అక్కడి అధికారిక హెల్ప్‌లైన్ చూడండి. తెలంగాణలో ఉంటే ప్రాంతం చెప్పండి.`
  }
  if (lang === 'hi') {
    return `मैं सिर्फ़ तेलंगाना की समस्याओं में मदद कर सकती हूँ${who}। दूसरे राज्य के लिए वहाँ की आधिकारिक हेल्पलाइन देखें। तेलंगाना में हैं तो इलाका बताइए।`
  }
  return `I can only help with problems in Telangana${who}. For another state, please use that state's official helpline. If you are in Telangana, tell me the area and we will start.`
}

const COPY = {
  en: {
    hello:
      "Hi, I'm Priya. I help with Telangana public services: power, water, drains, roads, ration cards, Aadhaar, pensions and certificates. What's the issue?",
    askProblem: (name: string) =>
      name ? `Got it, ${name}. What's the issue?` : "What's the issue? Tell me what's happening and where.",
    resume: (name: string, topic: string) =>
      `Welcome back${name ? `, ${name}` : ''}. You left an unfinished chat about "${topic}". Reply *1* to continue, or *2* for a new issue.`,
    pastCases: (name: string, lines: string) =>
      `Hi${name ? ` ${name}` : ''}. Earlier chats:\n${lines}\n\nReply with a number, or say *new*.`,
    satisfied: 'Glad that helped. This chat is closed. If the same problem gets stuck later, message again with your mobile number and I will continue from here.',
    missing: (fields: string[]) => `To record this I still need: ${fields.join(', ')}.`,
    recorded: (id: string) => `Recorded on our side. Your reference is ${id.slice(0, 8)}. Call the department number above and quote your area.`,
    confirm: 'Read the mail below. If it is right, press Send. A copy goes to your email.',
    sent: (id: string) => `Sent from our mail. You are copied, so you can see the thread. If the department replies, it comes back to us and you stay on the copy. Reference ${id.slice(0, 8)}.`,
    close: (phone: { name: string; phone: string } | null, mail: { name: string; email: string } | null) => {
      // Shown once per conversation (never repeated), and never ends with a stock "anything else?".
      const lines = ['If it stays stuck, our help desk can also take it up with the authority.']
      if (phone) lines.push(`Call ${phone.name} on ${phone.phone} first and note the complaint number.`)
      lines.push(
        mail
          ? 'To have us send it and follow up, share your mobile and email. I will show you the draft before anything goes out.'
          : 'To have us record it and follow up, share your mobile and email.',
      )
      return lines.join(' ')
    },
    sendFailed: 'The mail could not be sent. Your details are saved. Please call the department number as well.',
    noMail: 'This department publishes a phone and website. We can still record your case on our side and follow up — share mobile and email if you want that.',
    offer: 'If you want us to escalate from our desk (party / help desk side), send your mobile, email, and area. I will show the mail before it goes, and you will be copied.',
    searchIntro:
      'Official / public web snippets are listed under RESEARCH. Answer from them and the verified reference data. Give the official route first.',
    searchEmpty:
      'No extra page was found. Give the best verified official next step you know. If the message is too vague to act on, ask one short question about which public problem it is.',
    prior: (topic: string) => `You had an earlier chat about ${topic}. If that is still stuck, say what happened at the last step.`,
  },
  te: {
    hello:
      'నమస్కారం, నేను ప్రియ. తెలంగాణ ప్రభుత్వ సేవల్లో సహాయం చేస్తాను: కరెంట్, నీళ్లు, మురుగు, రోడ్లు, రేషన్ కార్డు, ఆధార్, పెన్షన్, సర్టిఫికెట్లు. మీ సమస్య ఏమిటి?',
    askProblem: (name: string) =>
      name ? `సరే, ${name} గారు. ఏ సమస్యలో సహాయం కావాలి?` : 'మీ సమస్య ఏమిటి? ఏం జరుగుతోందో, ఎక్కడో చెప్పండి.',
    resume: (name: string, topic: string) =>
      `మళ్లీ స్వాగతం${name ? `, ${name}` : ''}. "${topic}" చాట్ అసంపూర్ణం. *1* కొనసాగింపు, *2* కొత్తది.`,
    pastCases: (name: string, lines: string) =>
      `నమస్కారం${name ? ` ${name}` : ''}. మునుపటి చాట్‌లు:\n${lines}\n\nనంబర్ రాయండి లేదా *new*.`,
    satisfied: 'సరిపోయిందని సంతోషం. ఈ సంభాషణ ముగిసింది. అదే సమస్య తర్వాత ఆగిపోతే మీ మొబైల్ నంబర్‌తో మళ్లీ రాయండి. అక్కడి నుంచి కొనసాగిస్తాను.',
    missing: (fields: string[]) => `నమోదు చేయడానికి ఇంకా కావాలి: ${fields.join(', ')}.`,
    recorded: (id: string) => `మా వైపు నమోదు అయింది. రిఫరెన్స్ ${id.slice(0, 8)}. పైన ఉన్న డిపార్ట్‌మెంట్ నంబర్‌కు కాల్ చేసి ప్రాంతం చెప్పండి.`,
    confirm: 'కింద ఉన్న మెయిల్ చదవండి. సరిగ్గా ఉంటే Send నొక్కండి. కాపీ మీ ఇమెయిల్‌కు వెళ్తుంది.',
    sent: (id: string) => `మా మెయిల్ నుంచి పంపాం. మీకు కాపీ వెళ్తుంది. శాఖ సమాధానం మా దగ్గరికి వస్తుంది, మీరు కాపీలో ఉంటారు. రిఫరెన్స్ ${id.slice(0, 8)}.`,
    close: (phone: { name: string; phone: string } | null, mail: { name: string; email: string } | null) => {
      const lines = ['అది ఆగిపోతే మా హెల్ప్ డెస్క్ కూడా అధికారుల దగ్గరికి తీసుకెళ్తుంది.']
      if (phone) lines.push(`ముందు ${phone.name} కు ${phone.phone} కాల్ చేసి ఫిర్యాదు నంబర్ రాసుకోండి.`)
      lines.push(
        mail
          ? 'మేమే పంపి ఫాలో-అప్ చేయాలంటే మొబైల్, ఇమెయిల్ పంపండి. పంపే ముందు డ్రాఫ్ట్ చూపిస్తాను.'
          : 'మేము నమోదు చేసి ఫాలో-అప్ చేయాలంటే మొబైల్, ఇమెయిల్ పంపండి.',
      )
      return lines.join(' ')
    },
    sendFailed: 'మెయిల్ వెళ్లలేదు. మీ వివరాలు దాచాం. డిపార్ట్‌మెంట్ నంబర్‌కు కూడా కాల్ చేయండి.',
    noMail: 'ఈ శాఖ ఫోన్/వెబ్‌సైట్ ఇచ్చింది. మా వైపు నమోదు + ఫాలో-అప్ కావాలంటే మొబైల్, ఇమెయిల్ పంపండి.',
    offer: 'మా డెస్క్ నుంచి escalate చేయాలంటే మొబైల్, ఇమెయిల్, ప్రాంతం పంపండి. పంపే ముందు మెయిల్ చూపిస్తాం. మీకు కాపీ వెళ్తుంది.',
    searchIntro:
      'RESEARCH లో అధికారిక / పబ్లిక్ సమాచారం ఉంది. దాని ఆధారంగా, ధృవీకరించిన సమాచారంతో సమాధానం ఇవ్వండి. ముందు అధికారిక మార్గం చెప్పండి.',
    searchEmpty:
      'అదనపు సమాచారం దొరకలేదు. మీకు తెలిసిన ధృవీకరించిన అధికారిక స్టెప్ చెప్పండి. సందేశం చాలా అస్పష్టంగా ఉంటే ఏ ప్రభుత్వ సమస్య అని ఒక చిన్న ప్రశ్న అడగండి.',
    prior: (topic: string) => `ముందు ${topic} గురించి మాట్లాడాం. అది ఇంకా ఆగి ఉంటే చివరి దశలో ఏమైందో చెప్పండి.`,
  },
  hi: {
    hello:
      'नमस्ते, मैं प्रिया हूँ। मैं तेलंगाना की सरकारी सेवाओं में मदद करती हूँ: बिजली, पानी, नाली, सड़क, राशन कार्ड, आधार, पेंशन, प्रमाण पत्र। आपकी समस्या क्या है?',
    askProblem: (name: string) =>
      name ? `ठीक है, ${name} जी। किस समस्या में मदद चाहिए?` : 'आपकी समस्या क्या है? क्या हो रहा है और कहाँ, बताइए।',
    resume: (name: string, topic: string) =>
      `वापस स्वागत है${name ? `, ${name}` : ''}। "${topic}" अधूरी थी। *1* जारी, *2* नई।`,
    pastCases: (name: string, lines: string) =>
      `नमस्ते${name ? ` ${name}` : ''}। पहले की बातें:\n${lines}\n\nनंबर लिखें या *new*।`,
    satisfied: 'ठीक हो गया, अच्छा लगा। यह बातचीत बंद हुई। वही समस्या बाद में अटक जाए तो अपना मोबाइल लिखकर फिर आएँ। वहीं से आगे बढ़ाऊँगा।',
    missing: (fields: string[]) => `दर्ज करने के लिए अभी चाहिए: ${fields.join(', ')}.`,
    recorded: (id: string) => `हमारी तरफ दर्ज हो गया। संदर्भ ${id.slice(0, 8)}। ऊपर दिए विभाग के नंबर पर कॉल करके इलाका बताएँ।`,
    confirm: 'नीचे का मेल पढ़ें। सही हो तो Send दबाएँ। प्रतिलिपि आपके ईमेल पर जाएगी।',
    sent: (id: string) => `हमारे मेल से भेज दिया। आपको प्रतिलिपि गई है। विभाग का जवाब हमारे पास आएगा, और आप प्रतिलिपि पर रहेंगे। संदर्भ ${id.slice(0, 8)}।`,
    close: (phone: { name: string; phone: string } | null, mail: { name: string; email: string } | null) => {
      const lines = ['अटक जाए तो हमारी हेल्प डेस्क भी अधिकारियों तक ले जा सकती है।']
      if (phone) lines.push(`पहले ${phone.name} को ${phone.phone} पर कॉल करें और शिकायत नंबर लिख लें।`)
      lines.push(
        mail
          ? 'हम भेजकर फॉलो-अप करें तो मोबाइल और ईमेल भेजें। भेजने से पहले ड्राफ्ट दिखाऊँगी।'
          : 'हम दर्ज करके फॉलो-अप करें तो मोबाइल और ईमेल भेजें।',
      )
      return lines.join(' ')
    },
    sendFailed: 'मेल नहीं गया। आपका विवरण सहेजा है। विभाग के नंबर पर भी कॉल करें।',
    noMail: 'इस विभाग का फोन/वेबसाइट है। हमारी तरफ दर्ज + फॉलो-अप चाहिए तो मोबाइल और ईमेल भेजें।',
    offer: 'हमारी डेस्क से escalate करना हो तो मोबाइल, ईमेल और इलाका भेजें। भेजने से पहले मेल दिखाएँगे। आपको प्रतिलिपि जाएगी।',
    searchIntro:
      'RESEARCH में आधिकारिक / सार्वजनिक जानकारी है। उसी और सत्यापित जानकारी से जवाब दें। पहले आधिकारिक रास्ता बताएँ।',
    searchEmpty:
      'अतिरिक्त जानकारी नहीं मिली। जो सत्यापित आधिकारिक कदम आपको पता हो वह बताएँ। संदेश बहुत अस्पष्ट हो तो कौन सी सरकारी समस्या है, एक छोटा सवाल पूछें।',
    prior: (topic: string) => `पहले ${topic} पर बात हुई थी। वही अभी भी अटका है तो आखिरी कदम पर क्या हुआ बताएँ।`,
  },
} as const

const FIELD_LABEL: Record<GuideLang, Record<string, string>> = {
  en: { name: 'your name', phone: 'your mobile number', email: 'your email', place: 'the area or village' },
  te: { name: 'మీ పేరు', phone: 'మీ మొబైల్ నంబర్', email: 'మీ ఇమెయిల్', place: 'ప్రాంతం లేదా ఊరు' },
  hi: { name: 'आपका नाम', phone: 'आपका मोबाइल', email: 'आपका ईमेल', place: 'इलाका या गाँव' },
}

export interface GuideTurn {
  session_id: string
  language: GuideLang
  reply: string
  /** Short version of the latest reply, safe to read aloud. URLs stay on screen. */
  spoken: string
  status: GuideSession['status']
  problem: { id: string; title: string; mode: Playbook['mode'] } | null
  contacts: GuideContact[]
  draft: GuideDraft | null
  searched: boolean
  messages: GuideMessage[]
  /** Clickable previous cases (logged-in). */
  case_choices?: GuideCaseChoice[]
  focused_case?: { kind: string; id: string; title: string; status: string } | null
}

export async function handleGuideTurn(args: {
  orgId: string
  sessionId: string | null
  language: GuideLang | null
  message: string | null
  confirmSend: boolean
  /** Logged-in citizen — enables persistent memory + OpenClaw enrichment. */
  citizenId?: string | null
  citizenName?: string | null
  citizenPhone?: string | null
  citizenEmail?: string | null
}): Promise<GuideTurn> {
  const session = args.sessionId
    ? await loadGuideSession(args.orgId, args.sessionId)
    : await createGuideSession(args.orgId, args.language ?? 'te', args.citizenId)
  if (!session) {
    const created = await createGuideSession(args.orgId, args.language ?? 'te', args.citizenId)
    return replyWith(created, args.language ?? 'te', COPY[args.language ?? 'te'].hello, null, [], false)
  }
  if (args.language) session.language = args.language
  if (args.citizenId && !session.citizen_id) session.citizen_id = args.citizenId

  let memory: CitizenMemoryProfile | null = null
  if (session.citizen_id) {
    const ensured = await ensureCitizenMemory(args.orgId, session.citizen_id, {
      name: args.citizenName ?? undefined,
      phone: args.citizenPhone?.replace(/\D/g, '').slice(-10) || undefined,
      email: args.citizenEmail ?? undefined,
      preferred_language: session.language,
    })
    memory = await enrichMemoryWithOpenClaw(
      ensured.profile,
      args.message ?? '',
      session.citizen_id,
    )
    // Prefill known slots so we don't re-ask logged-in users
    if (memory.name && !session.contact.name) session.contact.name = memory.name
    if (memory.phone && !session.contact.phone) session.contact.phone = memory.phone
    if (memory.email && !session.contact.email) session.contact.email = memory.email
    // Only seed Telangana places; never re-apply after citizen starts a fresh problem
    if (!session.contact.place && !session.contact.block_memory_place) {
      const tgArea = memory.areas.find((area) => area && !looksOutsideTelangana(area))
      if (tgArea) session.contact.place = tgArea
    }
    // Drop a stale out-of-state place stuck on the session
    if (session.contact.place && looksOutsideTelangana(session.contact.place)) {
      session.contact.place = undefined
    }
    if (args.citizenName && !session.contact.name) session.contact.name = args.citizenName
    if (args.citizenPhone && !session.contact.phone) {
      session.contact.phone = args.citizenPhone.replace(/\D/g, '').slice(-10)
    }
    if (args.citizenEmail && !session.contact.email) session.contact.email = args.citizenEmail
  }
  let memoryPrompt = memoryContextForPrompt(memory)
  if (session.contact.active_case_title) {
    memoryPrompt = `${memoryPrompt}\nFOCUSED CASE: "${session.contact.active_case_title}" (${session.contact.active_case_kind ?? 'case'} ${session.contact.active_case_id ?? ''}). Prefer answering about this case unless they clearly change topic. Ignore non-Telangana locations in old case text.`.trim()
  }

  syncPhase(session)

  if (args.confirmSend) {
    return confirmDepartmentEmail(session)
  }

  const text = (args.message ?? '').trim()
  if (!text) {
    const messages = await listGuideMessages(session.id)
    if (!messages.length) {
      if (session.citizen_id) {
        const listed = await offerCaseHistory(session, session.language, 0)
        if (listed) return listed
      }
      const welcome =
        (memory ? memoryWelcomeLine(memory, session.language) : null) || COPY[session.language].hello
      await appendGuideMessage(session.id, 'assistant', welcome)
      session.phase = 'ask_problem'
      await saveGuideSession(session)
    }
    return snapshot(session, null, [], false)
  }

  const detected = detectLanguage(text)
  if (detected) session.language = detected
  const lang = session.language
  await appendGuideMessage(session.id, 'user', text.slice(0, 4000))

  const history = await listGuideMessages(session.id)
  const userText = history.filter((m) => m.role === 'user').map((m) => m.body).join('\n')
  const lastAssistantBody = [...history].reverse().find((m) => m.role === 'assistant')?.body ?? ''
  absorbContact(userText, session.contact)
  absorbLadderSlots(text, session, askedForPlace(lastAssistantBody))
  if (declinesName(text)) session.contact.name_declined = true
  await refreshNeedsAreaHint(session, text)
  syncPhase(session)

  const prior = session.contact.phone ? await previousGuideTopic(args.orgId, session.contact.phone, session.id) : null

  // Logged-in: list / pick previous cases (tickets + guide memory)
  if (session.citizen_id) {
    const caseTurn = await handleCaseHistoryTurn(session, lang, text)
    if (caseTurn) return caseTurn
  }

  if (SATISFIED.test(text) && history.filter((m) => m.role === 'assistant').length > 0) {
    session.status = 'satisfied'
    session.phase = 'help'
    return replyWith(session, lang, [prior ? COPY[lang].prior(prior) : '', COPY[lang].satisfied].filter(Boolean).join('\n\n'), playbookById(session.problem_id), [], false)
  }

  // Hard divert: lifestyle/personal (movies, salons, fights) OR coding/math — stay in civic circle
  if (isLifestyleOutOfScopeQuery(text)) {
    if (isLifestyleOutOfScopeQuery(session.contact.problem_summary || '')) {
      session.contact.problem_summary = undefined
      session.contact.needs_area = undefined
      session.problem_id = null
      session.contact.close_offered = false
    }
    session.phase = session.contact.name ? 'ask_problem' : session.phase
    return replyWith(session, lang, civicScopeRedirect(lang, session.contact.name?.trim() || ''), null, [], false)
  }
  if (OFF_TOPIC.test(text)) {
    return replyWith(
      session,
      lang,
      offTopicReply(lang, session.contact.name?.trim() || ''),
      playbookById(session.problem_id),
      [],
      false,
    )
  }

  // Outside Telangana → scope reply (do not give GHMC / TG advice for Punjab etc.)
  if (looksOutsideTelangana(text) || looksOutsideTelangana(session.contact.place)) {
    // If they just corrected INTO Telangana in this message, keep going
    if (looksOutsideTelangana(text)) {
      if (session.contact.place && looksOutsideTelangana(session.contact.place)) {
        session.contact.place = undefined
      }
      const turn = await replyWith(
        session,
        lang,
        outsideTelanganaReply(lang, session.contact.name?.trim() || ''),
        playbookById(session.problem_id),
        [],
        false,
      )
      return turn
    }
    // Stale out-of-state place on file — clear and ask for TG area instead of advising wrong city
    session.contact.place = undefined
  }

  // Short thanks — no dual-path boilerplate
  if (THANKS_ONLY.test(text)) {
    const nm = session.contact.name?.trim()
    const bye =
      lang === 'te'
        ? `సరే${nm ? ` ${nm}` : ''}, సహాయం అయిందని సంతోషం. ఇంకో సమస్య ఉంటే చెప్పండి.`
        : lang === 'hi'
          ? `ठीक है${nm ? ` ${nm}` : ''}, मदद लगने पर खुशी हुई। और कोई समस्या हो तो बताइए।`
          : `You’re welcome${nm ? `, ${nm}` : ''}. If anything else comes up, just tell me.`
    const turn = await replyWith(session, lang, bye, playbookById(session.problem_id), [], false)
    await rememberGuideTurn(session, { event: 'satisfied', language: lang })
    return turn
  }

  // User wants a new / different problem — drop old topic
  if (ANOTHER_PROBLEM.test(text) || wantsNewIssue(text)) {
    resetCurrentProblem(session)
    session.phase = 'ask_problem'
    const name = session.contact.name?.trim() || ''
    const ask =
      lang === 'te'
        ? `సరే${name ? `, ${name}` : ''}. పాతది పక్కన పెడదాం. కొత్త సమస్య ఏమిటి?`
        : lang === 'hi'
          ? `ठीक है${name ? `, ${name}` : ''}। पुरानी बात छोड़ते हैं। नई समस्या क्या है?`
          : `Got it${name ? `, ${name}` : ''}. Leaving the previous issue. What’s the new problem?`
    // Meta-only ("one more problem") → ask. Same message already has the new issue (e.g. PAN) → answer it.
    const stripped = text
      .replace(ANOTHER_PROBLEM, ' ')
      .replace(/\b(please|can you|give me answer|i want to|why|still|stuck|old problem)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    const hasNewProblem =
      looksLikeProblem(stripped) ||
      !!matchPlaybook(text)?.playbook ||
      /\b(pan|aadhaar|aadhar|ration|passport|voter|water|drain|road|sewer)\b/i.test(text)
    if (!hasNewProblem) {
      return replyWith(session, lang, ask, null, [], false)
    }
    session.contact.problem_summary = stripped.slice(0, 500) || text.slice(0, 500)
  }

  // Light ladder: name → problem → (area only if the problem needs it) → help.
  const ladderReply = await handleIntakeLadder(session, lang, text, args.orgId, history)
  if (ladderReply) return ladderReply

  // Lifestyle leftover on file (e.g. earlier movie ask) — clear and redirect once
  if (isLifestyleOutOfScopeQuery(session.contact.problem_summary || '')) {
    session.contact.problem_summary = undefined
    session.contact.needs_area = undefined
    session.problem_id = null
    session.contact.close_offered = false
    session.phase = 'ask_problem'
    return replyWith(session, lang, civicScopeRedirect(lang, session.contact.name?.trim() || ''), null, [], false)
  }

  const existing = playbookById(session.problem_id)
  // Place-only replies ("Road No. 4, KPHB" / "Power Welfare Society") must not rematch civic topics
  const placeReply =
    isPlaceReplyForCurrentIssue(text) ||
    (looksLikeAddress(text) && !looksLikeProblem(text.replace(/\b(rd|road|society|colony|nagar|phase)\b/gi, ' ')))
  const skipCivicRematch = placeReply
  const latestOnly = skipCivicRematch ? null : matchPlaybook(text)
  const problemBlob = [session.contact.problem_summary, text].filter(Boolean).join('\n')
  let playbook: Playbook | null =
    latestOnly?.playbook ??
    (skipCivicRematch && existing ? existing : null) ??
    (skipCivicRematch ? null : matchPlaybook(problemBlob)?.playbook) ??
    existing ??
    null

  // Switching topics: latest message matches a different playbook → switch, don't stay stuck
  if (existing && latestOnly?.playbook && latestOnly.playbook.id !== existing.id && !skipCivicRematch) {
    playbook = latestOnly.playbook
    session.contact.problem_summary = text.slice(0, 500)
    session.contact.needs_area = undefined
    session.contact.close_offered = false
    session.contact.place = problemNeedsArea(text) ? undefined : session.contact.place
    session.draft = null
  } else if (existing && playbook && playbook.id !== existing.id && (skipCivicRematch || staysOnTopic(text, existing))) {
    playbook = existing
  }

  if (!playbook && !skipCivicRematch) {
    playbook = await classifyPlaybook(session, text)
  }
  if (playbook) session.problem_id = playbook.id
  session.phase = 'help'

  // Help first (Rule 1): the area is asked AFTER the useful answer, inside the same reply,
  // never instead of it. The model sees "Area on file" and asks one short question if it helps.

  const followUp = history.filter((m) => m.role === 'user').length > 1
  const needsResearch =
    !playbook ||
    followUp ||
    /document|option|how|what|step|website|family|father|mother|otp|pin\s*code|pincode|postal|పత్ర|कैसे|दस्तावेज़|pan\b|aadhaar|aadhar/i.test(
      text,
    )
  const researchQuery = [session.contact.problem_summary, session.contact.place, text]
    .filter(Boolean)
    .join(' ')
    .slice(0, 180)
  // Civic / official search only — no salon/movie DuckDuckGo fan-out (saves credits + stays on mission)
  const hits = needsResearch ? await searchPublicWeb(researchQuery || text, researchFocus(playbook)) : []
  const wantsRecord = WANTS_RECORD.test(text)

  let body: string
  let draft: GuideDraft | null = null
  if (!playbook) {
    // Open civic help only — never ChatGPT-style lifestyle answers
    body = await answerOpen(session, lang, history, hits, memoryPrompt, text)
  } else if (wantsRecord && playbook.mode === 'department') {
    const mailTo = departmentEmail(playbook)
    const required = mailTo ? ['name', 'phone', 'email', 'place'] : ['name', 'phone', 'place']
    const missing = required.filter((key) => !session.contact[key as keyof GuideContactInfo])
    if (missing.length) {
      const one = missing[0]!
      body =
        lang === 'te'
          ? `సరే, మా వైపు నమోదు చేస్తాం. ఇంకా కావాలి: ${FIELD_LABEL[lang][one]}.`
          : lang === 'hi'
            ? `ठीक है, हम अपनी तरफ दर्ज करेंगे। अभी चाहिए: ${FIELD_LABEL[lang][one]}.`
            : `Okay — we’ll raise this from our desk. I still need ${FIELD_LABEL[lang][one]}.`
      if (!mailTo && one !== 'email') body += `\n\n${COPY[lang].noMail}`
    } else if (mailTo) {
      draft = buildDraft(playbook, session, mailTo)
      session.draft = draft
      body = `${COPY[lang].confirm}`
    } else {
      session.status = 'raised'
      body = `${COPY[lang].noMail}\n\n${COPY[lang].recorded(session.id)}`
      draft = null
    }
  } else {
    body = await answerDirect(session, lang, playbook, history, hits, memoryPrompt)
  }

  // Dual-path close ONLY once, only for real civic department grievances
  const shouldOfferClose =
    !wantsRecord &&
    !session.contact.close_offered &&
    !session.contact.desk_offered &&
    !!playbook &&
    playbook.mode === 'department' &&
    !THANKS_ONLY.test(text) &&
    !ANOTHER_PROBLEM.test(text)
  if (shouldOfferClose) {
    const offer = closingOffer(playbook, lang)
    if (offer) body = `${body}\n\n${offer}`
    session.contact.close_offered = true
    session.contact.desk_offered = true
  }

  // Show contact chips only when this reply is actually about that playbook's topic.
  const chipsRelevant =
    !!playbook &&
    (!existing ||
      existing.id !== playbook.id ||
      !!latestOnly?.playbook ||
      placeReply ||
      staysOnTopic(text, playbook))
  const turn = await replyWith(session, lang, body, chipsRelevant ? playbook : null, hits, hits.length > 0, draft)
  await rememberGuideTurn(session, {
    event: wantsRecord
      ? 'wants_desk'
      : ANOTHER_PROBLEM.test(text)
        ? 'topic_switch'
        : session.status === 'raised'
          ? 'raised'
          : session.status === 'satisfied'
            ? 'satisfied'
            : session.contact.place
              ? 'area_given'
              : 'problem_mentioned',
    language: lang,
  })
  return turn
}

function resetCurrentProblem(session: GuideSession): void {
  session.problem_id = null
  session.contact.problem_summary = undefined
  session.contact.needs_area = undefined
  session.contact.close_offered = false
  session.contact.place = undefined
  session.contact.block_memory_place = true
  session.draft = null
  session.contact.active_case_id = undefined
  session.contact.active_case_kind = undefined
  session.contact.active_case_title = undefined
}

async function offerCaseHistory(
  session: GuideSession,
  lang: GuideLang,
  offset: number,
): Promise<GuideTurn | null> {
  if (!session.citizen_id) return null
  const { items, total } = await listCitizenHistory({
    orgId: session.organization_id,
    citizenId: session.citizen_id,
    sessionId: session.id,
    lang,
    limit: 3,
    offset,
  })
  if (!items.length && offset === 0) return null
  const name = session.contact.name?.trim() || ''
  const { text, choices } = formatHistoryReply({ lang, name, items, total, offset })
  session.contact.case_list_offset = offset
  session.contact.case_choice_snapshot = choices
    .filter((c) => c.kind !== 'action')
    .map((c) => ({
      key: c.key,
      kind: c.kind,
      id: c.id,
      title: c.title,
      status: c.status,
    }))
  session.phase = 'ask_problem'
  return replyWith(session, lang, text, null, [], false, null, choices)
}

async function handleCaseHistoryTurn(
  session: GuideSession,
  lang: GuideLang,
  text: string,
): Promise<GuideTurn | null> {
  if (!session.citizen_id) return null

  const snapshotChoices: GuideCaseChoice[] = (session.contact.case_choice_snapshot ?? []).map((c) => ({
    key: c.key,
    kind: c.kind as GuideCaseChoice['kind'],
    id: c.id,
    title: c.title,
    status: c.status,
  }))

  // See more
  if (wantsSeeMore(text) || /^__case:action:see_more$/i.test(text.trim())) {
    const nextOffset = (session.contact.case_list_offset ?? 0) + 3
    const listed = await offerCaseHistory(session, lang, nextOffset)
    if (listed) return listed
    const none =
      lang === 'te'
        ? 'ఇంకా పాత కేసులు లేవు. కొత్త సమస్య చెప్పండి.'
        : lang === 'hi'
          ? 'और पुराने केस नहीं। नई समस्या बताइए।'
          : 'No more older cases. Tell me a new problem.'
    return replyWith(session, lang, none, null, [], false)
  }

  // New problem action
  if (/^__case:action:new_issue$/i.test(text.trim()) || (/^new$/i.test(text.trim()) && snapshotChoices.length)) {
    resetCurrentProblem(session)
    session.contact.case_choice_snapshot = undefined
    session.contact.case_list_offset = undefined
    session.phase = 'ask_problem'
    const ask =
      lang === 'te'
        ? 'సరే — కొత్త సమస్య ఏమిటి?'
        : lang === 'hi'
          ? 'ठीक है — नई समस्या क्या है?'
          : 'Okay — what’s the new problem?'
    return replyWith(session, lang, ask, null, [], false)
  }

  // Pick a case from last list (or __case: token)
  const picked =
    parseCaseSelection(text, snapshotChoices) ||
    (snapshotChoices.length ? parseCaseSelection(text, snapshotChoices) : null)
  if (picked && picked.kind !== 'action') {
    const detail = await loadFocusedCaseDetail({
      orgId: session.organization_id,
      citizenId: session.citizen_id,
      choice: picked,
      lang,
    })
    session.contact.active_case_kind = picked.kind
    session.contact.active_case_id = picked.id
    session.contact.active_case_title = detail.title
    session.contact.problem_summary = detail.title.slice(0, 500)
    session.contact.close_offered = false
    session.phase = 'help'
    if (picked.kind === 'guide') {
      // Keep chatting in current session but reuse problem context
    }
    await rememberGuideTurn(session, { event: 'problem_mentioned', language: lang })
    return replyWith(session, lang, detail.summary, playbookById(session.problem_id), [], false, null, undefined, {
      kind: picked.kind,
      id: picked.id,
      title: detail.title,
      status: detail.status,
    })
  }

  // Hi / previous queries → show top 3
  const userTurns = (await listGuideMessages(session.id)).filter((m) => m.role === 'user').length
  if (wantsHistoryList(text) || (isShortGreeting(text) && userTurns <= 2)) {
    const listed = await offerCaseHistory(session, lang, 0)
    if (listed) return listed
    // No history — fall through to normal ladder (but greet warmly)
    if (isShortGreeting(text) && session.contact.name) {
      const hi =
        lang === 'te'
          ? `నమస్కారం, ${session.contact.name}. ఏ సహాయం కావాలి?`
          : lang === 'hi'
            ? `नमस्ते, ${session.contact.name}। किसमें मदद चाहिए?`
            : `Hi, ${session.contact.name}. What do you need help with?`
      session.phase = 'ask_problem'
      return replyWith(session, lang, hi, null, [], false)
    }
  }

  return null
}

/**
 * Guide phases are only "waiting for a problem" and "helping". The name is optional and the
 * area is asked after the answer, so neither gates help (test log findings 1, 2 and 6).
 */
function syncPhase(session: GuideSession): void {
  const hasProblem = !!(session.contact.problem_summary?.trim() || session.problem_id)
  session.phase = hasProblem ? 'help' : 'ask_problem'
}

/** Use Dify (or local heuristics) so power/road/etc. ask for area before advice. */
async function refreshNeedsAreaHint(session: GuideSession, latestText: string): Promise<void> {
  const problem = (session.contact.problem_summary || latestText || '').trim()
  if (!problem || !looksLikeProblem(problem)) return

  // Local civic heuristic wins; Dify may only turn area ON, never clear a local need
  if (problemNeedsArea(problem)) {
    session.contact.needs_area = true
  }

  const dify = await difyIntakeClassify({
    orgId: session.organization_id,
    message: problem,
    language: session.language,
    name: session.contact.name ?? null,
  })
  if (!dify) return
  if (dify.needs_area) session.contact.needs_area = true
  else if (session.contact.needs_area !== true) session.contact.needs_area = dify.needs_area
  if (dify.summary && !session.contact.problem_summary) {
    session.contact.problem_summary = dify.summary.slice(0, 500)
  }
}

function absorbLadderSlots(text: string, session: GuideSession, placeWasAsked = false): void {
  const phaseBefore = session.phase
  const slots = absorbIntakeSlots(text)
  // Names only from an explicit intro ("my name is Ravi"). A bare short reply such as "ok" or
  // "thanks" must never become the name, and a stated name is never replaced by a guess.
  const intro = extractNamedIntro(text)
  if (intro) session.contact.name = intro
  if (slots.phone) {
    session.contact.phone = slots.phone
    session.contact.skipped_phone = false
  }
  if (slots.email) {
    session.contact.email = slots.email
    session.contact.skipped_email = false
  }

  // Problem: only real issues — never “list my queries” / status / greetings as the issue
  if (slots.problem && !session.contact.problem_summary && !isMetaOrNonIssue(slots.problem)) {
    session.contact.problem_summary = slots.problem
  } else if (
    phaseBefore === 'ask_problem' &&
    looksLikeProblem(text) &&
    !isMetaOrNonIssue(text) &&
    !session.contact.problem_summary
  ) {
    session.contact.problem_summary = text.slice(0, 500)
  }

  // Place: absorb soft city from "from hyderabad", or a full address when asked / volunteered
  if (slots.place) {
    if (looksOutsideTelangana(slots.place)) {
      // Keep out-of-state text visible to the outside-TG gate; don't lock GHMC advice to it
      session.contact.place = slots.place
    } else if (!session.contact.place || isVaguePlace(session.contact.place) || looksLikeAddress(text) || looksOutsideTelangana(session.contact.place || '')) {
      // Prefer a specific Telangana address; overwrite stale out-of-state memory places
      if (!isVaguePlace(slots.place) || !session.contact.place || looksOutsideTelangana(session.contact.place || '')) {
        session.contact.place = slots.place
        session.contact.block_memory_place = true
      }
    }
  }

  if (placeWasAsked) {
    if (looksLikeAddress(text) || (text.trim().length >= 4 && text.trim().length <= 120 && !isShortGreeting(text) && !looksLikeProblem(text))) {
      // We just asked for the colony / landmark, so a short non-problem reply is the place.
      if (!extractPhone(text) && !extractEmail(text)) {
        session.contact.place = text.trim().slice(0, 160)
      }
    }
  }
}

/** True when the assistant's last message asked the citizen for a colony / landmark. */
function askedForPlace(lastAssistant: string): boolean {
  const tail = lastAssistant.slice(-220)
  return (
    /[?？]/.test(tail) &&
    /(colony|landmark|which area|what area|street|locality|village|మీ ప్రాంతం|ఏ ప్రాంతం|కాలనీ|ల్యాండ్‌?మార్క్|ఏ ఊరు|कॉलोनी|लैंडमार्क|इलाका|गाँव)/i.test(tail)
  )
}

/** Greeting-only or name-only messages carry no problem yet; everything else gets an answer. */
function isMinimalMessage(text: string): boolean {
  const t = text.trim()
  if (!t) return true
  if (/[?？]/.test(t)) return false
  return t.split(/\s+/).filter(Boolean).length <= 2
}

/**
 * Light intake. No name gate and no area gate: the citizen gets help in the same reply.
 *  - greeting → short scope line + invitation to describe the problem
 *  - name-only / one-word message with no problem yet → ask for the problem
 *  - everything else → fall through to the answer pipeline
 */
async function handleIntakeLadder(
  session: GuideSession,
  lang: GuideLang,
  text: string,
  orgId: string,
  history: GuideMessage[],
): Promise<GuideTurn | null> {
  const name = session.contact.name?.trim() || ''
  const userTurns = history.filter((m) => m.role === 'user').length
  const hasProblem = !!(session.contact.problem_summary || session.problem_id)

  if (isShortGreeting(text) && userTurns <= 2) {
    const continuity = await continuityPrompt(session, lang, orgId)
    if (continuity) return replyWith(session, lang, continuity, playbookById(session.problem_id), [], false)
    if (!hasProblem) {
      session.phase = 'ask_problem'
      const line = name ? COPY[lang].askProblem(name) : COPY[lang].hello
      return replyWith(session, lang, line, null, [], false)
    }
  }

  // Continuity menu (1/2 / continue / new) — skip if they already named the new problem in this message
  const continuityOnly =
    wantsContinue(text) ||
    /^[1-5]$/.test(text.trim()) ||
    (wantsNewIssue(text) && !looksLikeProblem(text) && !matchPlaybook(text))
  if (session.contact.phone && continuityOnly) {
    const handled = await handleContinuityChoice(session, lang, orgId, text)
    if (handled) return handled
  }

  syncPhase(session)

  if (!hasProblem && !looksLikeProblem(text) && (isMinimalMessage(text) || extractNamedIntro(text))) {
    session.phase = 'ask_problem'
    return replyWith(session, lang, COPY[lang].askProblem(name), null, [], false)
  }

  // Lock the playbook as soon as the problem is known so contacts and facts follow the topic.
  await lockPlaybookFromProblem(session)
  return null
}

/** Match + persist playbook from problem_summary so area turns still expose problem.id. */
async function lockPlaybookFromProblem(session: GuideSession): Promise<Playbook | null> {
  const blob = (session.contact.problem_summary || '').trim()
  // Lifestyle leftovers must not lock a civic playbook
  if (blob && isLifestyleOutOfScopeQuery(blob)) {
    session.problem_id = null
    return null
  }
  const existing = playbookById(session.problem_id)
  if (existing) return existing
  if (!blob) return null
  let playbook = matchPlaybook(blob)?.playbook ?? null
  if (!playbook) playbook = await classifyPlaybook(session, blob)
  if (playbook) session.problem_id = playbook.id
  return playbook
}

async function continuityPrompt(session: GuideSession, lang: GuideLang, orgId: string): Promise<string | null> {
  const phone = session.contact.phone
  if (!phone) {
    // Same browser session left mid-ladder
    if (
      session.contact.name &&
      (session.contact.problem_summary || session.problem_id) &&
      (!session.contact.place || session.phase !== 'help')
    ) {
      const topic = session.contact.problem_summary?.slice(0, 50) || session.problem_id || 'your issue'
      return COPY[lang].resume(session.contact.name, topic)
    }
    return null
  }

  const incomplete = await findIncompleteGuideSession(orgId, phone, session.id)
  if (incomplete && !session.contact.problem_summary && !session.problem_id) {
    return COPY[lang].resume(session.contact.name ?? '', incomplete.summary)
  }

  const priors = await listPriorGuideCases(orgId, phone, session.id, 5)
  if (priors.length >= 1 && !session.contact.problem_summary && !session.problem_id) {
    return formatPastCases(lang, session.contact.name ?? '', priors)
  }
  return null
}

function formatPastCases(lang: GuideLang, name: string, cases: PriorGuideCase[]): string {
  const lines = cases.map((c, i) => `${i + 1}. ${c.summary} (${c.status}, ${c.updated_at})`).join('\n')
  return COPY[lang].pastCases(name, lines)
}

async function handleContinuityChoice(
  session: GuideSession,
  lang: GuideLang,
  orgId: string,
  text: string,
): Promise<GuideTurn | null> {
  const phone = session.contact.phone
  if (!phone) return null

  if (wantsNewIssue(text) || text.trim() === '2') {
    resetCurrentProblem(session)
    session.phase = 'ask_problem'
    return replyWith(session, lang, COPY[lang].askProblem(session.contact.name ?? ''), null, [], false)
  }

  const incomplete = await findIncompleteGuideSession(orgId, phone, session.id)
  const priors = await listPriorGuideCases(orgId, phone, session.id, 5)
  const pickN = parseInt(text.trim(), 10)

  if (wantsContinue(text) || text.trim() === '1') {
    if (incomplete) {
      const other = await loadGuideSession(orgId, incomplete.id)
      if (other) {
        // Point the client at the unfinished session by returning its id.
        return replyWith(
          other,
          lang,
          lang === 'te'
            ? `సరే, అక్కడి నుంచి కొనసాగిద్దాం. ${other.contact.problem_summary ? `మీ సమస్య: ${other.contact.problem_summary.slice(0, 80)}.` : ''} ఇంకా ఏమి చెప్పాలి?`
            : lang === 'hi'
              ? `ठीक है, वहीं से जारी रखते हैं। ${other.contact.problem_summary ? `समस्या: ${other.contact.problem_summary.slice(0, 80)}.` : ''} आगे क्या बताना है?`
              : `Okay, continuing from there. ${other.contact.problem_summary ? `Your issue: ${other.contact.problem_summary.slice(0, 80)}.` : ''} What else do you need?`,
          playbookById(other.problem_id),
          [],
          false,
        )
      }
    }
  }

  if (Number.isFinite(pickN) && pickN >= 1 && pickN <= priors.length) {
    const chosen = priors[pickN - 1]
    const other = await loadGuideSession(orgId, chosen.id)
    if (other) {
      return replyWith(
        other,
        lang,
        lang === 'te'
          ? `ఈ చాట్ తెరిచాను: ${chosen.summary}. ఇప్పుడు ఏమి కావాలి?`
          : lang === 'hi'
            ? `यह बात खोल दी: ${chosen.summary}. अब क्या चाहिए?`
            : `Opened that chat: ${chosen.summary}. What do you need now?`,
        playbookById(other.problem_id),
        [],
        false,
      )
    }
  }

  return null
}

async function confirmDepartmentEmail(session: GuideSession): Promise<GuideTurn> {
  const lang = session.language
  const playbook = playbookById(session.problem_id)
  if (!session.draft || !session.contact.email) {
    return replyWith(session, lang, COPY[lang].missing(['email'].map((key) => FIELD_LABEL[lang][key])), playbook, [], false)
  }
  const threadKey = session.id.replace(/-/g, '').slice(0, 12)
  const result = await sendEmail({
    to: [session.draft.to],
    cc: [session.contact.email],
    subject: session.draft.subject,
    text: session.draft.body,
    replyTo: replyToForThread(threadKey) ?? session.contact.email,
    tags: { source: 'guide', session: session.id.slice(0, 8) },
  })
  session.status = 'raised'
  const text = result.ok ? COPY[lang].sent(session.id) : `${COPY[lang].sendFailed} (${result.error})`
  return replyWith(session, lang, text, playbook, [], false, result.ok ? null : session.draft)
}

async function classifyPlaybook(session: GuideSession, text: string): Promise<Playbook | null> {
  // Phase 1: optional Dify intake (Chatflow / workflow).
  const dify = await difyIntakeClassify({
    orgId: session.organization_id,
    message: text,
    language: session.language,
    name: session.contact.name ?? null,
  })
  if (dify) {
    session.contact.needs_area = dify.needs_area
  }
  if (dify?.category && dify.confidence >= 0.55) {
    const byId = playbookById(dify.category)
    if (byId) return byId
    const fuzzy = PLAYBOOKS.find(
      (p) =>
        p.id === dify.category ||
        p.id.includes(dify.category!.toLowerCase()) ||
        p.titles.en.toLowerCase().includes(dify.category!.toLowerCase()) ||
        p.keywords.some((k) => k.toLowerCase() === dify.category!.toLowerCase() || k.toLowerCase().includes(dify.category!.toLowerCase())),
    )
    if (fuzzy) return fuzzy
    // Map common Dify slugs → playbooks
    const slug = dify.category.toLowerCase()
    const mapped =
      (slug.includes('power') || slug.includes('electric') ? playbookById('power_outage') || PLAYBOOKS.find((p) => p.id.startsWith('power')) : null) ||
      (slug.includes('sewer') || slug.includes('drain') ? PLAYBOOKS.find((p) => /drain|sewer|sewage/i.test(p.id + p.keywords.join(' '))) : null) ||
      (slug.includes('water') ? PLAYBOOKS.find((p) => p.id.includes('water')) : null) ||
      (slug.includes('garbage') ? PLAYBOOKS.find((p) => /garbage|solid/i.test(p.id)) : null) ||
      (slug.includes('aadhaar') || slug.includes('aadhar') ? PLAYBOOKS.find((p) => p.id.startsWith('aadhaar')) : null)
    if (mapped) return mapped
  }

  const result = await llmJson({
    agent: 'guide',
    promptVersion: 'guide.classify.v2',
    orgId: session.organization_id,
    language: session.language,
    system: `Choose the one Telangana help topic that matches the citizen, or null if none fit. Do not ask them for more data.`,
    user: JSON.stringify({
      message: text,
      dify_hint: dify,
      topics: PLAYBOOKS.map((p) => ({ id: p.id, title: p.titles.en })),
    }),
    schema: z.object({
      playbook_id: z.string().nullable(),
      confidence: z.number().min(0).max(1),
    }),
    temperature: 0,
    maxTokens: 200,
  })
  if (!result.ok || result.data.confidence < 0.45) return null
  return playbookById(result.data.playbook_id)
}

function staysOnTopic(text: string, existing: Playbook): boolean {
  if (isPlaceReplyForCurrentIssue(text)) return true
  if (existing.id.startsWith('aadhaar') && /aadhaar|aadhar|uid|otp|document|proof|family|father|mother|parent|option|step|website|app|myaadhaar|ఆధార్|आधार|పత్ర|दस्तावेज़|परिवार/i.test(text)) {
    return true
  }
  if (existing.id.startsWith('power') && /1912|outage|bill|meter|tgspdcl|tgnpdcl|కరెంట్|बिजली/i.test(text)) return true
  if (existing.id === 'sewer' && /drain|sewer|overflow|మురుగు|नाली/i.test(text)) return true
  if (existing.id === 'streetlight' && /light|lamp|దీపం|लाइट/i.test(text)) return true
  if (existing.id === 'manhole' && /manhole|మ్యాన్|मैनहोल/i.test(text)) return true
  const title = existing.titles.en.split(' ').filter((word) => word.length > 4)
  return title.some((word) => text.toLowerCase().includes(word.toLowerCase()))
}

function researchFocus(playbook: Playbook | null): string {
  if (!playbook) return 'Telangana official'
  if (playbook.id.startsWith('aadhaar')) return 'UIDAI official myAadhaar'
  if (playbook.id.startsWith('power')) return 'TGSPDCL TGNPDCL official'
  return 'Telangana official'
}

async function answerDirect(
  session: GuideSession,
  lang: GuideLang,
  playbook: Playbook,
  history: GuideMessage[],
  hits: WebHit[],
  memoryPrompt = '',
): Promise<string> {
  return phrase(session, lang, voiceFacts(playbook, lang), history, hits, memoryPrompt, 'playbook', '', playbook.mode === 'department')
}

/** No fixed playbook — civic open help only: clarify public problems or redirect lifestyle. */
async function answerOpen(
  session: GuideSession,
  lang: GuideLang,
  history: GuideMessage[],
  hits: WebHit[],
  memoryPrompt: string,
  latestText: string,
): Promise<string> {
  if (isLifestyleOutOfScopeQuery(latestText)) {
    return civicScopeRedirect(lang, session.contact.name?.trim() || '')
  }
  const seed = hits.length ? COPY[lang].searchIntro : COPY[lang].searchEmpty
  const fallback =
    lang === 'te'
      ? 'అర్థమైంది. మీ పబ్లిక్ సమస్యను కొంచెం స్పష్టం చెప్పండి — ఆధార్ / కరెంట్ / నీళ్లు / రోడ్డు లాంటివి, ఏ ప్రాంతం, సరిగ్గా ఏమి జరుగుతోంది? అప్పుడు అధికారిక స్టెప్ చెబుతాను.'
      : lang === 'hi'
        ? 'समझ गई। अपनी सार्वजनिक समस्या थोड़ा साफ़ बताइए — आधार / बिजली / पानी / सड़क जैसी, कौन सा इलाका, ठीक क्या दिक्कत है? फिर आधिकारिक कदम बताऊँगी।'
        : 'Got it. Tell me the public problem a bit more clearly — for example Aadhaar, power, water, or roads — which area, and what exactly is going wrong? Then I will give the official next step.'
  const text = await phrase(session, lang, seed, history, hits, memoryPrompt, 'open', latestText)
  if (!text || /say which service|which service it is|కొన్ని మాటల్లో|कौन सी सेवा|20 problems|fixed script/i.test(text)) {
    return fallback
  }
  return text
}

function voiceFacts(playbook: Playbook, lang: GuideLang): string {
  const steps = playbook.steps[lang].filter((step) => !asksForIdentity(step))
  return `${playbook.titles[lang]}. ${steps.join(' ')}`.replace(/\s+/g, ' ').trim()
}

function asksForIdentity(step: string): boolean {
  return /name and mobile|your name|మీ పేరు|పేరు, మొబైల్|आपका नाम|नाम और मोबाइल|नाम, मोबाइल/i.test(step)
}

async function phrase(
  session: GuideSession,
  lang: GuideLang,
  facts: string,
  history: GuideMessage[],
  hits: WebHit[] = [],
  memoryPrompt = '',
  mode: 'playbook' | 'open' = 'playbook',
  latestText = '',
  keepHelpline = false,
): Promise<string> {
  const languageName = lang === 'te' ? 'Telugu' : lang === 'hi' ? 'Hindi' : 'English'
  const recent = history
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-12)
    .map((m) => ({ role: m.role, content: m.body.slice(0, 700) }))
  const research = hits.length
    ? hits.map((hit, i) => `${i + 1}. ${hit.title} — ${hit.snippet} (${hit.url})`).join('\n')
    : ''
  const task =
    mode === 'open'
      ? `No fixed playbook matches. Answer the citizen's latest message with the best verified official next step (department, helpline or portal from the reference data). If the message is too vague to act on, ask ONE short question about which public problem it is. If it is outside Telangana public services, follow the boundaries rule: one or two warm sentences and the closest useful pointer. If another state is mentioned, say you only cover Telangana. Use short paragraphs. Do not invent shop lists, showtimes or prices.`
      : `Answer the latest message from the GUIDANCE FACTS and RESEARCH. Give 2 to 6 short sentences. If they changed topic, drop the previous issue completely and do not mention it unless they raise it again. If the latest message is a short local follow-up (pin code, spelling of the area, which office, landmark), answer THAT directly and do not paste the whole complaint script again. Do not advise using out-of-state places from the chat history.`

  const result = await llmText({
    agent: 'guide',
    promptVersion: `${GUIDE_PROMPT_VERSION}.${mode}`,
    orgId: session.organization_id,
    language: lang,
    system: buildGuideSystemPrompt({
      languageName,
      name: session.contact.name,
      nameDeclined: session.contact.name_declined,
      place: session.contact.place,
      problem: session.contact.problem_summary,
      memory: memoryPrompt,
      facts,
      research,
      task,
    }),
    messages: recent,
    temperature: mode === 'open' ? 0.3 : 0.2,
    // Telugu is token-heavy; the old 500/700 limits cut replies mid-word.
    maxTokens: mode === 'open' ? 1400 : 1200,
    // No live web-search tool here — DuckDuckGo snippets already in RESEARCH when needed
    enableWebSearch: false,
  })
  const latestUser =
    latestText || [...history].reverse().find((m) => m.role === 'user')?.body || ''
  // A reply cut by the token limit must never reach the citizen mid-word.
  const modelText = result.ok ? (result.truncated ? dropDanglingTail(result.text) : result.text) : ''
  const raw = modelText.length >= 20 ? modelText : facts
  if (mode === 'open') {
    return clipAtSentence(stripAccidentalDeskCta(preserveChatFormatting(raw)), 3200) || facts
  }
  return spokenAnswer(raw, facts, latestUser, keepHelpline)
}

/** Keep paragraphs / numbered lists readable in the chat UI (do not flatten to one line). */
function preserveChatFormatting(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Safety net: models sometimes paste civic dual-path copy into movie/salon answers. */
function stripAccidentalDeskCta(text: string): string {
  const cut = text.search(
    /\n+(You can try the official route|we can also take it up from our side|this help desk works with the local leadership|If you want us to raise this with the authority|share your mobile and email\. We record it|Official:\s*call\s+TGSPDCL|call TGSPDCL \(southern power)/i,
  )
  if (cut > 80) return text.slice(0, cut).trim()
  return text
    .replace(/\s*You can try the official route yourself[\s\S]*$/i, '')
    .replace(/\s*If you want us to raise this with the authority[\s\S]*$/i, '')
    .trim()
}

async function rememberGuideTurn(
  session: GuideSession,
  args: { event: Parameters<typeof touchCitizenMemory>[0]['event']; language: GuideLang },
): Promise<void> {
  if (!session.citizen_id) return
  // Never persist meta chat lines (“list previous queries”) as an issue in memory
  const summary = session.contact.problem_summary
  const realSummary =
    summary && !isMetaOrNonIssue(summary) ? summary : session.problem_id ? summary : null
  if (
    (args.event === 'problem_mentioned' || args.event === 'topic_switch') &&
    !session.problem_id &&
    !realSummary
  ) {
    return
  }
  try {
    await touchCitizenMemory({
      orgId: session.organization_id,
      citizenId: session.citizen_id,
      sessionId: session.id,
      event: args.event,
      language: args.language,
      name: session.contact.name,
      phone: session.contact.phone,
      email: session.contact.email,
      place: session.contact.place,
      problemId: session.problem_id,
      problemSummary: realSummary,
      status:
        session.status === 'raised' || session.status === 'satisfied' ? session.status : 'open',
    })
  } catch (err) {
    console.warn('[guide] memory touch failed', err instanceof Error ? err.message : err)
  }
}

function spokenAnswer(raw: string, facts: string, latestUser = '', keepHelpline = false): string {
  const clean = raw.replace(/https?:\/\/\S+/g, ' ').replace(/[*#_`]/g, ' ').replace(/\s+/g, ' ').trim()
  if (/do not have a telangana script|tell me the district|what you already tried|tell me your name|what is your name|your email address|send me your mobile|మీ పేరు చెప్పండి|अपना नाम बता|जिला बता|cannot resolve|i am an ai|as an ai/i.test(clean)) {
    return firstSentences(withoutHelpline(facts), 8)
  }
  const parts = clean.split(/(?<=[.!?।])\s+/).map((part) => part.trim()).filter((part) => part.length > 8)
  const body = /^(please\s+)?(call|email|mail|phone)\b/i.test(parts[0] ?? '') && parts.length > 1 ? parts.slice(1) : parts
  const joined = clipAtSentence(body.slice(0, 8).join(' '), 1600)
  const answer = keepHelpline ? joined : dropHelpline(joined, latestUser)
  if (/^(please\s+)?(call|email)\b/i.test(answer)) return firstSentences(withoutHelpline(facts), 8)
  return answer || firstSentences(withoutHelpline(facts), 8)
}

function dropHelpline(text: string, latestUser: string): string {
  const asked = /step|option|document|family|father|mother|website|how|what|otp|పత్ర|कैसे|दस्तावेज़/i.test(latestUser)
  if (!asked) return text
  const kept = text
    .split(/(?<=[.!?।])\s+/)
    .filter((part) => !/\b(call|phone|helpline|1947)\b/i.test(part) || /without calling|do not call|not a phone/i.test(part))
  return kept.join(' ').trim() || text
}

function withoutHelpline(text: string): string {
  return text
    .split(/(?<=[.!?।])\s+/)
    .filter((part) => !/^(for help call|call |please call|1947 is only|సహాయం|मदद के लिए)/i.test(part.trim()))
    .join(' ')
}

function firstSentences(text: string, count: number): string {
  const parts = text.split(/(?<=[.!?।])\s+/).map((part) => part.trim()).filter((part) => part.length > 8)
  return clipAtSentence(parts.slice(0, count).join(' '), 1600)
}

function closingOffer(playbook: Playbook | null, lang: GuideLang): string {
  if (!playbook) return ''
  const phone = playbook.contacts.find((contact) => contact.phone)
  const mail = playbook.contacts.find((contact) => contact.email)
  return COPY[lang].close(
    phone?.phone ? { name: phone.name, phone: phone.phone } : null,
    mail?.email ? { name: mail.name, email: mail.email } : null,
  )
}

function departmentEmail(playbook: Playbook): string | null {
  return playbook.contacts.find((c) => c.email)?.email ?? null
}

function buildDraft(playbook: Playbook, session: GuideSession, to: string): GuideDraft {
  const c = session.contact
  const subject = `Citizen grievance: ${playbook.titles.en} — ${c.place ?? 'Telangana'}`
  const body = [
    'Respected sir or madam,',
    '',
    `A citizen asked My Leader to forward this ${playbook.titles.en.toLowerCase()} problem.`,
    `Name: ${c.name}`,
    `Mobile: ${c.phone}`,
    `Email: ${c.email}`,
    `Place: ${c.place}`,
    '',
    'Please register this and reply to this email with the complaint or petition number.',
    'The citizen is copied. A reply comes back to My Leader, and the citizen can see that copy.',
    '',
    `Reference: ${session.id}`,
    '',
    'My Leader help desk',
  ].join('\n')
  return { to, subject, body }
}

function absorbContact(text: string, contact: GuideContactInfo): void {
  const email = extractEmail(text)
  if (email) {
    contact.email = email
    contact.skipped_email = false
  }
  const phone = extractPhone(text)
  if (phone) {
    contact.phone = phone
    contact.skipped_phone = false
  }
  const name = extractNamedIntro(text)
  if (name) contact.name = name
  const place = text.match(/(?:place is|area is|location is|address is|ప్రాంతం|ఊరు|इलाका|जगह)\s*[:\-]?\s*([\p{L}\d][\p{L}\d .,-]{2,60})/iu)
  if (place && !contact.place) contact.place = place[1].trim().slice(0, 80)
}

/** Drop links and list markup so text-to-speech reads the steps, not the URLs. */
export function toSpoken(text: string): string {
  const lines = text
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[•*]/g, ' ')
    .split('\n')
    .map((line) => line.replace(/^\s*\d+\.\s*/, '').replace(/\s+/g, ' ').replace(/:\s*$/, '').trim())
    .filter((line) => line.length > 8 && !/^—/.test(line))
  const picked = lines.slice(0, 4).join(' ')
  return clipAtSentence(picked.replace(/\s{2,}/g, ' ').trim(), 700)
}

function detectLanguage(text: string): GuideLang | null {
  if (/[\u0C00-\u0C7F]/.test(text)) return 'te'
  if (/[\u0900-\u097F]/.test(text)) return 'hi'
  return null
}

async function replyWith(
  session: GuideSession,
  lang: GuideLang,
  text: string,
  playbook: Playbook | null,
  hits: WebHit[],
  searched: boolean,
  draft?: GuideDraft | null,
  caseChoices?: GuideCaseChoice[],
  focusedCase?: GuideTurn['focused_case'],
): Promise<GuideTurn> {
  if (draft !== undefined) session.draft = draft
  session.language = lang
  // Group toll-free numbers (1800 425 00333) so they read and speak well.
  await appendGuideMessage(session.id, 'assistant', groupPhoneNumbers(text))
  await saveGuideSession(session)
  return snapshot(session, playbook, hits, searched, caseChoices, focusedCase)
}

async function snapshot(
  session: GuideSession,
  playbook: Playbook | null,
  _hits: WebHit[],
  searched: boolean,
  caseChoices?: GuideCaseChoice[],
  focusedCase?: GuideTurn['focused_case'],
): Promise<GuideTurn> {
  const messages = await listGuideMessages(session.id)
  const resolved = playbook ?? playbookById(session.problem_id)
  return {
    session_id: session.id,
    language: session.language,
    reply: messages.filter((m) => m.role === 'assistant').at(-1)?.body ?? '',
    spoken: toSpoken(messages.filter((m) => m.role === 'assistant').at(-1)?.body ?? ''),
    status: session.status,
    problem: resolved ? { id: resolved.id, title: resolved.titles[session.language], mode: resolved.mode } : null,
    // Contacts belong to the answer that was just given. Only the playbook passed in for THIS reply
    // is shown; never fall back to the session's old topic (stale source chips, finding 8).
    contacts: playbook?.contacts ?? [],
    draft: session.draft,
    searched,
    messages,
    case_choices: caseChoices,
    focused_case:
      focusedCase ??
      (session.contact.active_case_id
        ? {
            kind: session.contact.active_case_kind ?? 'memory',
            id: session.contact.active_case_id,
            title: session.contact.active_case_title ?? '',
            status: 'open',
          }
        : null),
  }
}
