import { z } from 'zod'
import {
  absorbIntakeSlots,
  extractBareName,
  extractEmail,
  extractNamedIntro,
  extractPhone,
  extractPlace,
  isShortGreeting,
  isVaguePlace,
  looksLikeAddress,
  looksLikeProblem,
  nextPhase,
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
import { searchPublicWeb, type WebHit } from './search.js'
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

const COPY = {
  en: {
    hello:
      "Hi — I'm Priya, your personal agent for Telangana help (Aadhaar, ration, power, water, roads, drains). What should I call you?",
    askName: 'What should I call you?',
    askNameAgain: 'Sorry — what name should I use for you?',
    askProblem: (name: string) =>
      `Got it, ${name}. What's going on — what do you need help with?`,
    askArea: (name: string) =>
      `Thanks${name ? `, ${name}` : ''}. Which colony or landmark is this in? I need the local spot before we escalate — street / colony / nearby landmark.`,
    resume: (name: string, topic: string) =>
      `Welcome back${name ? `, ${name}` : ''}. You left an unfinished chat about "${topic}". Reply *1* to continue, or *2* for a new issue.`,
    pastCases: (name: string, lines: string) =>
      `Hi${name ? ` ${name}` : ''}. Earlier chats:\n${lines}\n\nReply with a number, or say *new*.`,
    satisfied: 'Glad that helped. This chat is closed. If the same problem gets stuck later, message again with your mobile number and I will continue from here.',
    missing: (fields: string[]) => `To record this I still need: ${fields.join(', ')}.`,
    recorded: (id: string) => `Recorded on our side. Your reference is ${id.slice(0, 8)}. Call the department number above and quote your area.`,
    confirm: 'Read the mail below. If it is right, press Send. A copy goes to your email.',
    sent: (id: string) => `Sent from our mail. You are copied, so you can see the thread. If the department replies, it comes back to us and you stay on the copy. Reference ${id.slice(0, 8)}.`,
    anythingElse: 'Is there anything else I can help you with?',
    close: (phone: { name: string; phone: string } | null, mail: { name: string; email: string } | null) => {
      const lines = [
        'You can try the official route yourself, and we can also take it up from our side — this help desk works with the local leadership team.',
      ]
      if (phone) lines.push(`Official: call ${phone.name} on ${phone.phone} and note the complaint number.`)
      if (mail) {
        lines.push(
          `Or email ${mail.name} at ${mail.email}. If you want us to send it from our desk and follow up, share your mobile and email — I will show you the draft first and copy you.`,
        )
      } else {
        lines.push(
          'If you want us to raise this with the authority on your behalf, share your mobile and email. We record it on our side, follow up, and keep you in the loop.',
        )
      }
      lines.push('Is there anything else I can help you with?')
      return lines.join(' ')
    },
    sendFailed: 'The mail could not be sent. Your details are saved. Please call the department number as well.',
    noMail: 'This department publishes a phone and website. We can still record your case on our side and follow up — share mobile and email if you want that.',
    offer: 'If you want us to escalate from our desk (party / help desk side), send your mobile, email, and area. I will show the mail before it goes, and you will be copied.',
    searchIntro: 'This is not one of the 20 problems I have a fixed script for. I looked it up. Check the official page before you act:',
    searchEmpty: 'Say which service it is, in a few words. For example: electricity, Aadhaar address, ration card, or a blocked drain. I will tell you the number to call and the steps.',
    prior: (topic: string) => `You had an earlier chat about ${topic}. If that is still stuck, say what happened at the last step.`,
  },
  te: {
    hello:
      'నమస్కారం — నేను ప్రియ, తెలంగాణ సహాయం కోసం మీ వ్యక్తిగత ఏజెంట్ (ఆధార్, రేషన్, కరెంట్, నీళ్లు, రోడ్లు, మురుగు). మిమ్మల్ని ఏమని పిలవాలి?',
    askName: 'మిమ్మల్ని ఏమని పిలవాలి?',
    askNameAgain: 'క్షమించండి — మీ పేరు ఏమిటి?',
    askProblem: (name: string) => `సరే, ${name}. ఏ సమస్యలో సహాయం కావాలి?`,
    askArea: (name: string) =>
      `ధన్యవాదాలు${name ? `, ${name}` : ''}. ఏ కాలనీ లేదా ల్యాండ్‌మార్క్? స్థానిక చిరునామా చెప్పండి — అప్పుడే ముందుకు తీసుకెళ్తాం.`,
    resume: (name: string, topic: string) =>
      `మళ్లీ స్వాగతం${name ? `, ${name}` : ''}. "${topic}" చాట్ అసంపూర్ణం. *1* కొనసాగింపు, *2* కొత్తది.`,
    pastCases: (name: string, lines: string) =>
      `నమస్కారం${name ? ` ${name}` : ''}. మునుపటి చాట్‌లు:\n${lines}\n\nనంబర్ రాయండి లేదా *new*.`,
    satisfied: 'సరిపోయిందని సంతోషం. ఈ సంభాషణ ముగిసింది. అదే సమస్య తర్వాత ఆగిపోతే మీ మొబైల్ నంబర్‌తో మళ్లీ రాయండి. అక్కడి నుంచి కొనసాగిస్తాను.',
    missing: (fields: string[]) => `నమోదు చేయడానికి ఇంకా కావాలి: ${fields.join(', ')}.`,
    recorded: (id: string) => `మా వైపు నమోదు అయింది. రిఫరెన్స్ ${id.slice(0, 8)}. పైన ఉన్న డిపార్ట్‌మెంట్ నంబర్‌కు కాల్ చేసి ప్రాంతం చెప్పండి.`,
    confirm: 'కింద ఉన్న మెయిల్ చదవండి. సరిగ్గా ఉంటే Send నొక్కండి. కాపీ మీ ఇమెయిల్‌కు వెళ్తుంది.',
    sent: (id: string) => `మా మెయిల్ నుంచి పంపాం. మీకు కాపీ వెళ్తుంది. శాఖ సమాధానం మా దగ్గరికి వస్తుంది, మీరు కాపీలో ఉంటారు. రిఫరెన్స్ ${id.slice(0, 8)}.`,
    anythingElse: 'ఇంకేమైనా కావాలా?',
    close: (phone: { name: string; phone: string } | null, mail: { name: string; email: string } | null) => {
      const lines = ['అధికారిక మార్గం మీరు కూడా తీసుకోవచ్చు; మా హెల్ప్ డెస్క్ / నాయకత్వ బృందం వైపు నుంచి కూడా తీసుకుంటాం.']
      if (phone) lines.push(`అధికారికం: ${phone.name} కు ${phone.phone} కాల్ చేసి ఫిర్యాదు నంబర్ రాసుకోండి.`)
      if (mail) {
        lines.push(
          `లేదా ${mail.email} కు రాయండి. మా వైపు నుంచి పంపి ఫాలో-అప్ చేయాలంటే మొబైల్, ఇమెయిల్ పంపండి — ముందు డ్రాఫ్ట్ చూపిస్తాం, మీకు కాపీ ఉంటుంది.`,
        )
      } else {
        lines.push('మా వైపు నమోదు చేసి అధికారుల దగ్గరికి తీసుకెళ్లాలంటే మొబైల్, ఇమెయిల్ పంపండి.')
      }
      lines.push('ఇంకేమైనా కావాలా?')
      return lines.join(' ')
    },
    sendFailed: 'మెయిల్ వెళ్లలేదు. మీ వివరాలు దాచాం. డిపార్ట్‌మెంట్ నంబర్‌కు కూడా కాల్ చేయండి.',
    noMail: 'ఈ శాఖ ఫోన్/వెబ్‌సైట్ ఇచ్చింది. మా వైపు నమోదు + ఫాలో-అప్ కావాలంటే మొబైల్, ఇమెయిల్ పంపండి.',
    offer: 'మా డెస్క్ నుంచి escalate చేయాలంటే మొబైల్, ఇమెయిల్, ప్రాంతం పంపండి. పంపే ముందు మెయిల్ చూపిస్తాం. మీకు కాపీ వెళ్తుంది.',
    searchIntro: 'దీనికి నా దగ్గర సిద్ధంగా ఉన్న 20 సమస్యల స్క్రిప్ట్ లేదు. వెతికాను. చేయడానికి ముందు అధికారిక పేజీ చూడండి:',
    searchEmpty: 'ఏ సేవో రెండు మాటల్లో చెప్పండి. ఉదాహరణ: కరెంట్, ఆధార్ చిరునామా, రేషన్ కార్డు, మురుగు బ్లాక్. నంబర్ మరియు చేయవలసిన పని చెబుతాను.',
    prior: (topic: string) => `ముందు ${topic} గురించి మాట్లాడాం. అది ఇంకా ఆగి ఉంటే చివరి దశలో ఏమైందో చెప్పండి.`,
  },
  hi: {
    hello:
      'नमस्ते — मैं प्रिया हूँ, तेलंगाना मदद के लिए आपकी निजी एजेंट (आधार, राशन, बिजली, पानी, सड़क, नाली)। आपको क्या कहूँ?',
    askName: 'आपको क्या कहूँ?',
    askNameAgain: 'माफ़ कीजिए — आपका नाम क्या है?',
    askProblem: (name: string) => `ठीक है, ${name}. किस समस्या में मदद चाहिए?`,
    askArea: (name: string) =>
      `धन्यवाद${name ? `, ${name}` : ''}। कौन सी कॉलोनी या लैंडमार्क? स्थानीय जगह बताएँ — तब आगे बढ़ाएँगे।`,
    resume: (name: string, topic: string) =>
      `वापस स्वागत है${name ? `, ${name}` : ''}। "${topic}" अधूरी थी। *1* जारी, *2* नई।`,
    pastCases: (name: string, lines: string) =>
      `नमस्ते${name ? ` ${name}` : ''}। पहले की बातें:\n${lines}\n\nनंबर लिखें या *new*।`,
    satisfied: 'ठीक हो गया, अच्छा लगा। यह बातचीत बंद हुई। वही समस्या बाद में अटक जाए तो अपना मोबाइल लिखकर फिर आएँ। वहीं से आगे बढ़ाऊँगा।',
    missing: (fields: string[]) => `दर्ज करने के लिए अभी चाहिए: ${fields.join(', ')}.`,
    recorded: (id: string) => `हमारी तरफ दर्ज हो गया। संदर्भ ${id.slice(0, 8)}। ऊपर दिए विभाग के नंबर पर कॉल करके इलाका बताएँ।`,
    confirm: 'नीचे का मेल पढ़ें। सही हो तो Send दबाएँ। प्रतिलिपि आपके ईमेल पर जाएगी।',
    sent: (id: string) => `हमारे मेल से भेज दिया। आपको प्रतिलिपि गई है। विभाग का जवाब हमारे पास आएगा, और आप प्रतिलिपि पर रहेंगे। संदर्भ ${id.slice(0, 8)}।`,
    anythingElse: 'और कुछ मदद चाहिए?',
    close: (phone: { name: string; phone: string } | null, mail: { name: string; email: string } | null) => {
      const lines = ['आधिकारिक रास्ता आप खुद भी अपना सकते हैं; हमारी हेल्प डेस्क / नेतृत्व टीम भी आपकी तरफ से आगे बढ़ा सकती है।']
      if (phone) lines.push(`आधिकारिक: ${phone.name} को ${phone.phone} पर कॉल करें और शिकायत नंबर लिख लें।`)
      if (mail) {
        lines.push(
          `या ${mail.email} पर लिखें। हम अपनी तरफ से भेजकर फॉलो-अप करें तो मोबाइल और ईमेल भेजें — पहले ड्राफ्ट दिखाएँगे, आपको प्रतिलिपि रहेगी।`,
        )
      } else {
        lines.push('हमारी तरफ दर्ज कर अधिकारियों तक ले जाना हो तो मोबाइल और ईमेल भेजें।')
      }
      lines.push('और कुछ मदद चाहिए?')
      return lines.join(' ')
    },
    sendFailed: 'मेल नहीं गया। आपका विवरण सहेजा है। विभाग के नंबर पर भी कॉल करें।',
    noMail: 'इस विभाग का फोन/वेबसाइट है। हमारी तरफ दर्ज + फॉलो-अप चाहिए तो मोबाइल और ईमेल भेजें।',
    offer: 'हमारी डेस्क से escalate करना हो तो मोबाइल, ईमेल और इलाका भेजें। भेजने से पहले मेल दिखाएँगे। आपको प्रतिलिपि जाएगी।',
    searchIntro: 'यह उन 20 समस्याओं में नहीं है जिनका मेरे पास तैयार तरीका है। मैंने खोजा। करने से पहले आधिकारिक पेज देखें:',
    searchEmpty: 'कौन सी सेवा है, दो शब्दों में बताएँ। जैसे बिजली, आधार का पता, राशन कार्ड, या बंद नाली। मैं नंबर और अगला कदम बताऊँगा।',
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
    if (memory.areas[0] && !session.contact.place) session.contact.place = memory.areas[0]
    if (args.citizenName && !session.contact.name) session.contact.name = args.citizenName
    if (args.citizenPhone && !session.contact.phone) {
      session.contact.phone = args.citizenPhone.replace(/\D/g, '').slice(-10)
    }
    if (args.citizenEmail && !session.contact.email) session.contact.email = args.citizenEmail
  }
  let memoryPrompt = memoryContextForPrompt(memory)
  if (session.contact.active_case_title) {
    memoryPrompt = `${memoryPrompt}\nFOCUSED CASE: "${session.contact.active_case_title}" (${session.contact.active_case_kind ?? 'case'} ${session.contact.active_case_id ?? ''}). Prefer answering about this case unless they clearly change topic.`.trim()
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
      session.phase = session.contact.name ? 'ask_problem' : 'ask_name'
      if (memory?.name) session.phase = 'ask_problem'
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
  absorbContact(userText, session.contact)
  absorbLadderSlots(text, session)
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

  const existing = playbookById(session.problem_id)
  const latestOnly = matchPlaybook(text)
  const problemBlob = [session.contact.problem_summary, text].filter(Boolean).join('\n')
  let playbook = latestOnly?.playbook ?? matchPlaybook(problemBlob)?.playbook ?? existing ?? null

  // Switching topics: latest message matches a different playbook → switch, don't stay stuck
  if (existing && latestOnly?.playbook && latestOnly.playbook.id !== existing.id) {
    playbook = latestOnly.playbook
    session.contact.problem_summary = text.slice(0, 500)
    session.contact.needs_area = undefined
    session.contact.close_offered = false
    session.contact.place = problemNeedsArea(text) ? undefined : session.contact.place
    session.draft = null
  } else if (existing && playbook && playbook.id !== existing.id && staysOnTopic(text, existing)) {
    playbook = existing
  }

  if (!playbook) playbook = await classifyPlaybook(session, text)
  if (playbook) session.problem_id = playbook.id
  session.phase = 'help'

  // If new problem needs area and we cleared place, ask before advice
  if (
    problemNeedsArea(session.contact.problem_summary || text, session.contact.needs_area) &&
    (!session.contact.place || isVaguePlace(session.contact.place))
  ) {
    session.phase = 'ask_area'
    const name = session.contact.name?.trim() || ''
    const line = await naturalAsk(session, lang, history, 'ask_area', COPY[lang].askArea(name))
    return replyWith(session, lang, line, playbook, [], false)
  }

  const followUp = history.filter((m) => m.role === 'user').length > 1
  const needsResearch = !playbook || followUp || /document|option|how|what|step|website|family|father|mother|otp|పత్ర|कैसे|दस्तावेज़|pan\b|aadhaar|aadhar/i.test(text)
  const hits = needsResearch ? await searchPublicWeb(text, researchFocus(playbook)) : []
  const wantsRecord = WANTS_RECORD.test(text)

  let body: string
  let draft: GuideDraft | null = null
  if (!playbook) {
    body = hits.length
      ? await phrase(session, lang, COPY[lang].searchIntro, history, hits, memoryPrompt)
      : COPY[lang].searchEmpty
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

  // Dual-path close ONLY once, and only for local department grievances (not PAN/Aadhaar self-serve)
  const shouldOfferClose =
    !wantsRecord &&
    !session.contact.close_offered &&
    !!playbook &&
    playbook.mode === 'department' &&
    !THANKS_ONLY.test(text) &&
    !ANOTHER_PROBLEM.test(text)
  if (shouldOfferClose) {
    body = `${body}\n\n${closingOffer(playbook, lang)}`
    session.contact.close_offered = true
  }

  const turn = await replyWith(session, lang, body, playbook, hits, hits.length > 0, draft)
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

function syncPhase(session: GuideSession): void {
  session.phase = nextPhase({
    name: session.contact.name,
    problem: session.contact.problem_summary || session.problem_id,
    place: session.contact.place,
    needsArea: session.contact.needs_area,
  })
}

/** Use Dify (or local heuristics) so power/road/etc. ask for area before advice. */
async function refreshNeedsAreaHint(session: GuideSession, latestText: string): Promise<void> {
  const problem = (session.contact.problem_summary || latestText || '').trim()
  if (!problem || !looksLikeProblem(problem)) return

  if (session.contact.needs_area === undefined) {
    // Local heuristic first (covers electricity even if Dify is down)
    if (problemNeedsArea(problem)) session.contact.needs_area = true
  }

  const dify = await difyIntakeClassify({
    orgId: session.organization_id,
    message: problem,
    language: session.language,
    name: session.contact.name ?? null,
  })
  if (!dify) return
  session.contact.needs_area = dify.needs_area
  if (dify.summary && !session.contact.problem_summary) {
    session.contact.problem_summary = dify.summary.slice(0, 500)
  }
}

function absorbLadderSlots(text: string, session: GuideSession): void {
  const phaseBefore = session.phase
  const slots = absorbIntakeSlots(text)
  if (slots.name && !session.contact.name) session.contact.name = slots.name
  if (slots.phone) {
    session.contact.phone = slots.phone
    session.contact.skipped_phone = false
  }
  if (slots.email) {
    session.contact.email = slots.email
    session.contact.skipped_email = false
  }

  if (!session.contact.name) {
    const bare = extractBareName(text) || extractNamedIntro(text)
    if (bare) session.contact.name = bare
  }

  // Problem: only real issues — never “list my queries” / status / greetings as the issue
  if (slots.problem && !session.contact.problem_summary && !isMetaOrNonIssue(slots.problem)) {
    session.contact.problem_summary = slots.problem
  } else if (
    (phaseBefore === 'ask_problem' || phaseBefore === 'ask_name') &&
    looksLikeProblem(text) &&
    !isMetaOrNonIssue(text) &&
    !session.contact.problem_summary
  ) {
    session.contact.problem_summary = text.slice(0, 500)
  }

  // Place: absorb soft city from "from hyderabad", or a full address when asked / volunteered
  if (slots.place) {
    if (!session.contact.place || isVaguePlace(session.contact.place) || looksLikeAddress(text)) {
      // Prefer a specific address over a vague city we already had
      if (!isVaguePlace(slots.place) || !session.contact.place) {
        session.contact.place = slots.place
      }
    }
  }

  if (phaseBefore === 'ask_area') {
    if (looksLikeAddress(text) || (text.trim().length >= 8 && !isShortGreeting(text))) {
      // In ask_area, almost any real reply is the place — don't reject long addresses as "problems"
      if (!extractPhone(text) && !extractEmail(text)) {
        session.contact.place = text.trim().slice(0, 160)
      }
    }
  }
}

/** Short natural line via LLM; falls back to a seed sentence if the model is down. */
async function naturalAsk(
  session: GuideSession,
  lang: GuideLang,
  history: GuideMessage[],
  intent: 'greet' | 'ask_name' | 'ask_problem' | 'ask_area',
  seed: string,
): Promise<string> {
  const languageName = lang === 'te' ? 'Telugu' : lang === 'hi' ? 'Hindi' : 'English'
  const name = session.contact.name ?? ''
  const problem = session.contact.problem_summary ?? ''
  const place = session.contact.place ?? ''
  const recent = history
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-6)
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.body.slice(0, 400) }))

  const goal =
    intent === 'greet'
      ? 'Greet warmly as Priya, their personal Telangana help agent. Ask only for their name. One or two short sentences.'
      : intent === 'ask_name'
        ? 'Ask only for their name, briefly and politely. One short sentence.'
        : intent === 'ask_problem'
          ? `You already know their name is ${name || '(unknown)'}. Acknowledge it naturally. Ask only what problem they need help with. Do NOT ask for address, phone, or email yet. One or two short sentences.`
          : `Name: ${name || 'unknown'}. Problem: ${problem || 'unknown'}. Soft place hint: ${place || 'none'}. Ask only for a more specific local address (colony / street / landmark). Do NOT ask phone or email. One or two short sentences.`

  const result = await llmText({
    agent: 'guide',
    promptVersion: 'guide.ladder.v1',
    orgId: session.organization_id,
    language: lang,
    system: `You are Priya, a warm personal help agent for people in Telangana (Bharosa / My Leader). Speak ${languageName}.
Sound human — not a form, not a script. Vary your wording. No bullets, no markdown, no URLs.
${goal}
If the seed below helps, paraphrase it; do not copy it word-for-word unless the model fails.`,
    messages: [...recent, { role: 'user', content: `Seed (paraphrase, do not quote): ${seed}` }],
    temperature: 0.55,
    maxTokens: 120,
  })
  const text = result.ok ? result.text.trim() : ''
  if (!text || /as an ai|i cannot|json/i.test(text)) return seed
  return text.replace(/\s+/g, ' ').slice(0, 400)
}

async function handleIntakeLadder(
  session: GuideSession,
  lang: GuideLang,
  text: string,
  orgId: string,
  history: GuideMessage[],
): Promise<GuideTurn | null> {
  const name = session.contact.name?.trim() || ''
  const userTurns = history.filter((m) => m.role === 'user').length
  const lastAssistant = [...history].reverse().find((m) => m.role === 'assistant')?.body ?? ''
  const wasAskingName = /call you|your name|మీ పేరు|పిలవాలి|आपका नाम|क्या कहूँ|personal agent/i.test(lastAssistant)

  if (isShortGreeting(text) && userTurns <= 2) {
    const continuity = await continuityPrompt(session, lang, orgId)
    if (continuity) return replyWith(session, lang, continuity, playbookById(session.problem_id), [], false)

    if (!name) {
      session.phase = 'ask_name'
      const line = await naturalAsk(session, lang, history, 'greet', COPY[lang].hello)
      return replyWith(session, lang, line, null, [], false)
    }
    if (!session.contact.problem_summary && !session.problem_id) {
      session.phase = 'ask_problem'
      const line = await naturalAsk(session, lang, history, 'ask_problem', COPY[lang].askProblem(name))
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

  // Just got a name (no problem yet) → ask for the problem, never jump to area.
  if (name && !session.contact.problem_summary && !session.problem_id && !looksLikeProblem(text)) {
    session.phase = 'ask_problem'
    const seed = wasAskingName || userTurns <= 2 ? COPY[lang].askProblem(name) : COPY[lang].askProblem(name)
    const line = await naturalAsk(session, lang, history, 'ask_problem', seed)
    return replyWith(session, lang, line, null, [], false)
  }

  syncPhase(session)

  if (session.phase === 'ask_name') {
    if (isShortGreeting(text)) {
      const line = await naturalAsk(session, lang, history, 'greet', COPY[lang].hello)
      return replyWith(session, lang, line, null, [], false)
    }
    if (!session.contact.name) {
      const line = await naturalAsk(session, lang, history, 'ask_name', COPY[lang].askNameAgain)
      return replyWith(session, lang, line, null, [], false)
    }
    session.phase = 'ask_problem'
    const line = await naturalAsk(session, lang, history, 'ask_problem', COPY[lang].askProblem(session.contact.name))
    return replyWith(session, lang, line, null, [], false)
  }

  if (session.phase === 'ask_problem') {
    if (!session.contact.problem_summary && !session.problem_id) {
      const line = await naturalAsk(session, lang, history, 'ask_problem', COPY[lang].askProblem(name || 'there'))
      return replyWith(session, lang, line, null, [], false)
    }
    // Problem known — only ask area when this issue type needs a local spot
    if (
      problemNeedsArea(session.contact.problem_summary, session.contact.needs_area) &&
      (!session.contact.place || isVaguePlace(session.contact.place))
    ) {
      session.phase = 'ask_area'
      const line = await naturalAsk(session, lang, history, 'ask_area', COPY[lang].askArea(name))
      return replyWith(session, lang, line, null, [], false)
    }
    session.phase = 'help'
    return null
  }

  if (session.phase === 'ask_area') {
    if (!session.contact.place || isVaguePlace(session.contact.place)) {
      if (session.contact.place && isVaguePlace(session.contact.place)) session.contact.place = undefined
      const line = await naturalAsk(session, lang, history, 'ask_area', COPY[lang].askArea(name || ''))
      return replyWith(session, lang, line, null, [], false)
    }
    session.phase = 'help'
  }

  return null
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
    session.phase = session.contact.name ? 'ask_problem' : 'ask_name'
    const body = session.contact.name
      ? COPY[lang].askProblem(session.contact.name)
      : COPY[lang].askName
    return replyWith(session, lang, body, null, [], false)
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
  if (existing.id.startsWith('aadhaar') && /aadhaar|aadhar|uid|otp|document|proof|family|father|mother|parent|option|step|website|app|myaadhaar|ఆధార్|आधार|పత్ర|दस्तावेज़|परिवार/i.test(text)) {
    return true
  }
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
  return phrase(session, lang, voiceFacts(playbook, lang), history, hits, memoryPrompt)
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
): Promise<string> {
  const languageName = lang === 'te' ? 'Telugu' : lang === 'hi' ? 'Hindi' : 'English'
  const recent = history
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-8)
    .map((m) => ({ role: m.role, content: m.body.slice(0, 700) }))
  const research = hits.length
    ? hits.map((hit) => `${hit.title}. ${hit.snippet}`).join(' ')
    : 'No extra page was found. Answer from the FACTS.'
  const result = await llmText({
    agent: 'guide',
    promptVersion: 'guide.answer.v5',
    orgId: session.organization_id,
    language: lang,
    system: `You are Priya, personal help agent for Bharosa / My Leader in Telangana. Speak ${languageName}, warmly and plainly.
Citizen name: ${session.contact.name ?? 'unknown'}. Area: ${session.contact.place ?? 'not given yet'}.
Answer ONLY the citizen's latest message. If they changed topic, drop the previous issue completely — do not mention electricity, power cuts, TSSPDCL, or the old problem unless they asked about it again.
Do not append a fixed closing about Help Desk / leadership / share mobile and email — that is added separately when needed.
Give a direct useful answer from FACTS and RESEARCH (3–6 sentences). Official steps and site names are fine; no raw URLs, no bullets, no markdown.
Do not ask for Aadhaar number, PAN number, OTP, or bank details.
${memoryPrompt ? `\n${memoryPrompt}\n` : ''}
FACTS:
${facts}
RESEARCH:
${research}`,
    messages: recent,
    temperature: 0.2,
    maxTokens: 500,
  })
  const latestUser = [...history].reverse().find((m) => m.role === 'user')?.body ?? ''
  return spokenAnswer(result.ok ? result.text : facts, facts, latestUser)
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

function spokenAnswer(raw: string, facts: string, latestUser = ''): string {
  const clean = raw.replace(/https?:\/\/\S+/g, ' ').replace(/[*#_`]/g, ' ').replace(/\s+/g, ' ').trim()
  if (/do not have a telangana script|tell me the district|what you already tried|tell me your name|what is your name|your email address|send me your mobile|మీ పేరు చెప్పండి|अपना नाम बता|जिला बता|cannot resolve|i am an ai|as an ai/i.test(clean)) {
    return firstSentences(withoutHelpline(facts), 8)
  }
  const parts = clean.split(/(?<=[.!?।])\s+/).map((part) => part.trim()).filter((part) => part.length > 8)
  const body = /^(please\s+)?(call|email|mail|phone)\b/i.test(parts[0] ?? '') && parts.length > 1 ? parts.slice(1) : parts
  const answer = dropHelpline(body.slice(0, 8).join(' ').slice(0, 1600), latestUser)
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
  return parts.slice(0, count).join(' ').slice(0, 1600)
}

function closingOffer(playbook: Playbook | null, lang: GuideLang): string {
  if (!playbook) return COPY[lang].anythingElse
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
  const name = extractNamedIntro(text) || extractBareName(text)
  if (name && !contact.name) contact.name = name
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
  return picked.replace(/\s{2,}/g, ' ').trim().slice(0, 700)
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
  await appendGuideMessage(session.id, 'assistant', text)
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
    contacts: resolved?.contacts ?? [],
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
