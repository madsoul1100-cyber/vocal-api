import { z } from 'zod'
import { llmJson, llmText } from '../ai/llm.js'
import { replyToForThread, sendEmail } from '../comms/emailProvider.js'
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
  listGuideMessages,
  loadGuideSession,
  previousGuideTopic,
  saveGuideSession,
  type GuideContactInfo,
  type GuideDraft,
  type GuideMessage,
  type GuideSession,
} from './store.js'

const SATISFIED = /\b(this helped|that helped|solved|i'm good|im good|close (the )?(chat|this)|no more questions)\b|పరిష్కారమైంది|సరిపోయింది|ఇంకా అవసరం లేదు|हो गया|सुलझ गया|बस इतना ही/i
const WANTS_RECORD = /e-?mail the|send (a |the )?mail|raise (it|this) (on|with)|record (it|this)|note (it|this) (here|down)|on your side|ఇమెయిల్ పంప|మీ వైపు నమోదు|ईमेल भेज|आपकी तरफ दर्ज/i

const COPY = {
  en: {
    hello: 'Tell me the problem in your own words. I can guide you for Aadhaar, PAN, voter ID, ration card, power, water, roads, drains, and garbage in Telangana.',
    satisfied: 'Glad that helped. This chat is closed. If the same problem gets stuck later, message again with your mobile number and I will continue from here.',
    missing: (fields: string[]) => `To record this I still need: ${fields.join(', ')}.`,
    recorded: (id: string) => `Recorded on our side. Your reference is ${id.slice(0, 8)}. Call the department number above and quote your area.`,
    confirm: 'Read the mail below. If it is right, press Send. A copy goes to your email.',
    sent: (id: string) => `Sent from our mail. You are copied, so you can see the thread. If the department replies, it comes back to us and you stay on the copy. Reference ${id.slice(0, 8)}.`,
    anythingElse: 'Is there anything else I can help you with?',
    close: (phone: { name: string; phone: string } | null, mail: { name: string; email: string } | null) => {
      const lines = ['That is the way to get this done.']
      if (phone) lines.push(`You can call ${phone.name} on ${phone.phone} yourself.`)
      if (mail) {
        lines.push(`You can also email ${mail.name} at ${mail.email} yourself. Or I can send it from our mail and copy you. Their reply comes back to us, and you are on the copy, so you can see where it goes. If you want that, send your name, mobile, and email.`)
      } else {
        lines.push('This office publishes a phone and a website. I will not invent a complaint email.')
      }
      lines.push('Is there anything else I can help you with?')
      return lines.join(' ')
    },
    sendFailed: 'The mail could not be sent. Your details are saved. Please call the department number as well.',
    noMail: 'This department has a phone and a website in our directory, not a complaint email. The official record is the complaint number they give you on that call or site.',
    offer: 'If you want us to email the department, send your name, mobile, email, and the area. I will show you the mail before it goes, and you will be copied.',
    searchIntro: 'This is not one of the 20 problems I have a fixed script for. I looked it up. Check the official page before you act:',
    searchEmpty: 'Say which service it is, in a few words. For example: electricity, Aadhaar address, ration card, or a blocked drain. I will tell you the number to call and the steps.',
    prior: (topic: string) => `You had an earlier chat about ${topic}. If that is still stuck, say what happened at the last step.`,
  },
  te: {
    hello: 'మీ సమస్య మీ మాటల్లో చెప్పండి. ఆధార్, పాన్, ఓటరు ఐడీ, రేషన్ కార్డు, కరెంట్, నీళ్లు, రోడ్లు, మురుగు, చెత్త — తెలంగాణకు నేను దారి చూపిస్తాను.',
    satisfied: 'సరిపోయిందని సంతోషం. ఈ సంభాషణ ముగిసింది. అదే సమస్య తర్వాత ఆగిపోతే మీ మొబైల్ నంబర్‌తో మళ్లీ రాయండి. అక్కడి నుంచి కొనసాగిస్తాను.',
    missing: (fields: string[]) => `నమోదు చేయడానికి ఇంకా కావాలి: ${fields.join(', ')}.`,
    recorded: (id: string) => `మా వైపు నమోదు అయింది. రిఫరెన్స్ ${id.slice(0, 8)}. పైన ఉన్న డిపార్ట్‌మెంట్ నంబర్‌కు కాల్ చేసి ప్రాంతం చెప్పండి.`,
    confirm: 'కింద ఉన్న మెయిల్ చదవండి. సరిగ్గా ఉంటే Send నొక్కండి. కాపీ మీ ఇమెయిల్‌కు వెళ్తుంది.',
    sent: (id: string) => `మా మెయిల్ నుంచి పంపాం. మీకు కాపీ వెళ్తుంది. శాఖ సమాధానం మా దగ్గరికి వస్తుంది, మీరు కాపీలో ఉంటారు. రిఫరెన్స్ ${id.slice(0, 8)}.`,
    anythingElse: 'ఇంకేమైనా కావాలా?',
    close: (phone: { name: string; phone: string } | null, mail: { name: string; email: string } | null) => {
      const lines = ['ఇది పరిష్కారం.']
      if (phone) lines.push(`మీరే ${phone.name} కు ${phone.phone} కు కాల్ చేయవచ్చు.`)
      if (mail) lines.push(`మీరే ${mail.email} కు రాయవచ్చు. లేదా మేము మా మెయిల్ నుంచి పంపి మీకు కాపీ పెడతాం. సమాధానం మా దగ్గరికి వస్తుంది, మీరు కాపీలో చూడవచ్చు. కావాలంటే పేరు, మొబైల్, ఇమెయిల్ పంపండి.`)
      else lines.push('ఈ కార్యాలయం ఫోన్ మరియు వెబ్‌సైట్ ప్రచురించింది. ఫిర్యాదు ఇమెయిల్ నేను కల్పించను.')
      lines.push('ఇంకేమైనా కావాలా?')
      return lines.join(' ')
    },
    sendFailed: 'మెయిల్ వెళ్లలేదు. మీ వివరాలు దాచాం. డిపార్ట్‌మెంట్ నంబర్‌కు కూడా కాల్ చేయండి.',
    noMail: 'ఈ శాఖకు మా డైరెక్టరీలో ఫోన్ మరియు వెబ్‌సైట్ ఉన్నాయి, ఫిర్యాదు ఇమెయిల్ లేదు. అధికార రికార్డు వారు కాల్ లేదా సైట్‌లో ఇచ్చే ఫిర్యాదు నంబర్.',
    offer: 'మేము శాఖకు ఇమెయిల్ చేయాలంటే పేరు, మొబైల్, ఇమెయిల్, ప్రాంతం పంపండి. పంపే ముందు మెయిల్ చూపిస్తాం. మీకు కాపీ వెళ్తుంది.',
    searchIntro: 'దీనికి నా దగ్గర సిద్ధంగా ఉన్న 20 సమస్యల స్క్రిప్ట్ లేదు. వెతికాను. చేయడానికి ముందు అధికారిక పేజీ చూడండి:',
    searchEmpty: 'ఏ సేవో రెండు మాటల్లో చెప్పండి. ఉదాహరణ: కరెంట్, ఆధార్ చిరునామా, రేషన్ కార్డు, మురుగు బ్లాక్. నంబర్ మరియు చేయవలసిన పని చెబుతాను.',
    prior: (topic: string) => `ముందు ${topic} గురించి మాట్లాడాం. అది ఇంకా ఆగి ఉంటే చివరి దశలో ఏమైందో చెప్పండి.`,
  },
  hi: {
    hello: 'समस्या अपने शब्दों में बताइए। आधार, पैन, वोटर आईडी, राशन कार्ड, बिजली, पानी, सड़क, नाली और कचरा — तेलंगाना के लिए मैं रास्ता बताता हूँ।',
    satisfied: 'ठीक हो गया, अच्छा लगा। यह बातचीत बंद हुई। वही समस्या बाद में अटक जाए तो अपना मोबाइल लिखकर फिर आएँ। वहीं से आगे बढ़ाऊँगा।',
    missing: (fields: string[]) => `दर्ज करने के लिए अभी चाहिए: ${fields.join(', ')}.`,
    recorded: (id: string) => `हमारी तरफ दर्ज हो गया। संदर्भ ${id.slice(0, 8)}। ऊपर दिए विभाग के नंबर पर कॉल करके इलाका बताएँ।`,
    confirm: 'नीचे का मेल पढ़ें। सही हो तो Send दबाएँ। प्रतिलिपि आपके ईमेल पर जाएगी।',
    sent: (id: string) => `हमारे मेल से भेज दिया। आपको प्रतिलिपि गई है। विभाग का जवाब हमारे पास आएगा, और आप प्रतिलिपि पर रहेंगे। संदर्भ ${id.slice(0, 8)}।`,
    anythingElse: 'और कुछ मदद चाहिए?',
    close: (phone: { name: string; phone: string } | null, mail: { name: string; email: string } | null) => {
      const lines = ['यही तरीका है।']
      if (phone) lines.push(`आप खुद ${phone.name} को ${phone.phone} पर कॉल कर सकते हैं।`)
      if (mail) lines.push(`आप खुद ${mail.email} पर लिख सकते हैं। या मैं हमारे मेल से भेजकर आपको प्रतिलिपि दूँगा। जवाब हमारे पास आएगा, और आप प्रतिलिपि पर देख सकते हैं। चाहिए तो नाम, मोबाइल और ईमेल भेजें।`)
      else lines.push('इस कार्यालय ने फोन और वेबसाइट छापी है। शिकायत ईमेल मैं बनाऊँगा नहीं।')
      lines.push('और कुछ मदद चाहिए?')
      return lines.join(' ')
    },
    sendFailed: 'मेल नहीं गया। आपका विवरण सहेजा है। विभाग के नंबर पर भी कॉल करें।',
    noMail: 'इस विभाग का हमारे पास फोन और वेबसाइट है, शिकायत ईमेल नहीं। आधिकारिक रिकॉर्ड वही शिकायत नंबर है जो वे कॉल या साइट पर देते हैं।',
    offer: 'हम विभाग को ईमेल करें तो नाम, मोबाइल, ईमेल और इलाका भेजें। भेजने से पहले मेल दिखाएँगे। आपको प्रतिलिपि जाएगी।',
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
}

export async function handleGuideTurn(args: {
  orgId: string
  sessionId: string | null
  language: GuideLang | null
  message: string | null
  confirmSend: boolean
}): Promise<GuideTurn> {
  const session = args.sessionId
    ? await loadGuideSession(args.orgId, args.sessionId)
    : await createGuideSession(args.orgId, args.language ?? 'te')
  if (!session) {
    const created = await createGuideSession(args.orgId, args.language ?? 'te')
    return replyWith(created, args.language ?? 'te', COPY[args.language ?? 'te'].hello, null, [], false)
  }
  if (args.language) session.language = args.language

  if (args.confirmSend) {
    return confirmDepartmentEmail(session)
  }

  const text = (args.message ?? '').trim()
  if (!text) {
    const messages = await listGuideMessages(session.id)
    if (!messages.length) {
      await appendGuideMessage(session.id, 'assistant', COPY[session.language].hello)
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
  const prior = session.contact.phone ? await previousGuideTopic(args.orgId, session.contact.phone, session.id) : null

  if (SATISFIED.test(text) && history.filter((m) => m.role === 'assistant').length > 0) {
    session.status = 'satisfied'
    return replyWith(session, lang, [prior ? COPY[lang].prior(prior) : '', COPY[lang].satisfied].filter(Boolean).join('\n\n'), playbookById(session.problem_id), [], false)
  }

  const existing = playbookById(session.problem_id)
  const latest = matchPlaybook(text)
  let playbook = latest?.playbook ?? matchPlaybook(userText)?.playbook ?? existing ?? null
  if (existing && playbook && playbook.id !== existing.id && staysOnTopic(text, existing)) playbook = existing
  if (!playbook) playbook = await classifyPlaybook(session, text)
  if (playbook) session.problem_id = playbook.id

  const followUp = history.filter((m) => m.role === 'user').length > 1
  const needsResearch = !playbook || followUp || /document|option|how|what|step|website|family|father|mother|otp|పత్ర|कैसे|दस्तावेज़/i.test(text)
  const hits = needsResearch ? await searchPublicWeb(text, researchFocus(playbook)) : []
  const wantsRecord = WANTS_RECORD.test(text)

  let body: string
  let draft: GuideDraft | null = null
  if (!playbook) {
    body = hits.length
      ? await phrase(session, lang, COPY[lang].searchIntro, history, hits)
      : COPY[lang].searchEmpty
  } else if (wantsRecord && playbook.mode === 'department') {
    const mailTo = departmentEmail(playbook)
    const required = mailTo ? ['name', 'phone', 'email', 'place'] : ['name', 'phone', 'place']
    const missing = required.filter((key) => !session.contact[key as keyof GuideContactInfo])
    const steps = await answerDirect(session, lang, playbook, history, hits)
    if (missing.length) {
      const one = missing[0]
      body = `${steps}\n\n${COPY[lang].missing([FIELD_LABEL[lang][one]])}`
      if (!mailTo) body += `\n\n${COPY[lang].noMail}`
    } else if (mailTo) {
      draft = buildDraft(playbook, session, mailTo)
      session.draft = draft
      body = `${steps}\n\n${COPY[lang].confirm}`
    } else {
      session.status = 'raised'
      body = `${steps}\n\n${COPY[lang].noMail}\n\n${COPY[lang].recorded(session.id)}`
      draft = null
    }
  } else {
    body = await answerDirect(session, lang, playbook, history, hits)
  }

  if (prior && !body.includes(prior)) body = `${COPY[lang].prior(prior)}\n\n${body}`
  if (!wantsRecord) body = `${body}\n\n${closingOffer(playbook, lang)}`
  return replyWith(session, lang, body, playbook, hits, hits.length > 0, draft)
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
  const result = await llmJson({
    agent: 'guide',
    promptVersion: 'guide.classify.v1',
    orgId: session.organization_id,
    language: session.language,
    system: `Choose the one Telangana help topic that matches the citizen, or null if none fit. Do not ask them for more data.`,
    user: JSON.stringify({
      message: text,
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
): Promise<string> {
  return phrase(session, lang, voiceFacts(playbook, lang), history, hits)
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
    promptVersion: 'guide.answer.v3',
    orgId: session.organization_id,
    language: lang,
    system: `You are Priya, the My Leader guide for people in Telangana. Speak ${languageName}, plainly.
The person is talking to you so they can finish this here. Answer the question they just asked. Do not send them away to a phone call or an email.
First sentence: say what they are trying to do, in their words.
Then give the steps. If they say they already see two options, or they mention a document, an electricity bill, or a father or mother Aadhaar, explain both of those options in this reply before you mention any other menu. Do not answer that question by only saying to go back.
Follow the FACTS for every tap. The family path is: enter the parent's Aadhaar number, choose the relation, face authentication, pay the ₹75 shown, then the parent opens their own Aadhaar app, Services, Family Member Request, enters the SRN, and approves. Do not say the parent confirms by OTP.
A document path uses a proof in the person's own name: an electricity, water, gas, landline, or post-paid mobile bill not older than 3 months, or a passport, voter ID, or ration card. They upload it, type the same address, check the preview, do face authentication, pay ₹75, and save the SRN.
Use RESEARCH only to fill a gap the FACTS do not cover. Ignore a page that only says to call.
Do not mention 1947 or any helpline in this reply.
Do not ask them to repeat the problem, or for their name, mobile, email, district, Aadhaar number, PAN, OTP, or bank details.
Six to eight sentences. No bullets, no markdown, no URLs.
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
  const email = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)
  if (email) contact.email = email[0].toLowerCase()
  const phone = text.match(/(?:\+?91[\s-]?)?[6-9]\d{9}/)
  if (phone) contact.phone = phone[0].replace(/\D/g, '').slice(-10)
  const name = text.match(/(?:my name is|నా పేరు|मेरा नाम)\s+([\p{L}][\p{L} .]{1,40})/iu)
  if (name) contact.name = name[1].trim()
  const place = text.match(/(?:place is|area is|location is|ప్రాంతం|ఊరు|इलाका|जगह)\s*[:\-]?\s*([\p{L}\d][\p{L}\d .,-]{2,60})/iu)
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
): Promise<GuideTurn> {
  if (draft !== undefined) session.draft = draft
  session.language = lang
  await appendGuideMessage(session.id, 'assistant', text)
  await saveGuideSession(session)
  return snapshot(session, playbook, hits, searched)
}

async function snapshot(session: GuideSession, playbook: Playbook | null, _hits: WebHit[], searched: boolean): Promise<GuideTurn> {
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
  }
}
