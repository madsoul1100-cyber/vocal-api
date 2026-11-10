/**
 * Bridges an inbound WhatsApp message (via Telinfy) to the Bharosa guide chatbot
 * and sends the guide's reply back on WhatsApp.
 *
 *   wa number -> citizen (by phone) -> guide session (whatsapp_guide_sessions) -> handleGuideTurn -> reply
 */

import { dbQuery } from '@/lib/db.js'
import { findOrCreateCitizenByPhone } from '@/modules/bharosa/citizen/auth.js'
import { HttpError } from '@/modules/bharosa/common.js'
import { handleGuideTurn, type GuideTurn } from '@/modules/bharosa/guide/agent.js'
import type { GuideLang } from '@/modules/bharosa/guide/playbooks.js'
import { loadGuideSession } from '@/modules/bharosa/guide/store.js'
import { sendWhatsAppText, type InboundWhatsApp } from './telinfy.js'

/** Reuse the same chat if the citizen wrote within this many hours; otherwise start fresh. */
function sessionTtlHours(): number {
  const n = Number(process.env.WHATSAPP_SESSION_TTL_HOURS)
  return Number.isFinite(n) && n > 0 ? n : 12
}

function maskWa(wa: string): string {
  return wa.length > 4 ? `***${wa.slice(-4)}` : '****'
}

const RESET_RE = /^\s*(new|restart|reset|start over|menu|కొత్త|नया)\s*[.!]*\s*$/i
const CONFIRM_RE = /^\s*(send|yes|y|confirm|ok send|okay send|हाँ|हां|भेजो|भेजें|అవును|పంపు|పంపండి)\s*[.!]*\s*$/i

function detectLang(text: string): GuideLang | null {
  if (/[\u0C00-\u0C7F]/.test(text)) return 'te'
  if (/[\u0900-\u097F]/.test(text)) return 'hi'
  if (/[A-Za-z]{2,}/.test(text)) return 'en'
  return null
}

const COPY: Record<GuideLang, { media: string; error: string; draftHint: string; draftHeader: string }> = {
  en: {
    media: 'I can only read text messages here for now. Please type your problem in a few words.',
    error: 'Sorry, something went wrong on our side. Please send your message again in a moment.',
    draftHeader: 'Draft email to the department',
    draftHint: 'Reply *SEND* to email this to the department, or tell me what to change.',
  },
  te: {
    media: 'ప్రస్తుతం ఇక్కడ టెక్స్ట్ సందేశాలు మాత్రమే చదవగలను. దయచేసి మీ సమస్యను కొన్ని మాటల్లో టైప్ చేయండి.',
    error: 'క్షమించండి, మా వైపు ఏదో సమస్య వచ్చింది. కాసేపటి తర్వాత మళ్లీ సందేశం పంపండి.',
    draftHeader: 'విభాగానికి డ్రాఫ్ట్ మెయిల్',
    draftHint: 'విభాగానికి పంపాలంటే *SEND* అని రిప్లై ఇవ్వండి, లేదా ఏం మార్చాలో చెప్పండి.',
  },
  hi: {
    media: 'अभी मैं यहाँ सिर्फ़ टेक्स्ट संदेश पढ़ सकती हूँ। कृपया अपनी समस्या कुछ शब्दों में लिखें।',
    error: 'माफ़ कीजिए, हमारी तरफ़ कुछ गड़बड़ हुई। थोड़ी देर बाद फिर संदेश भेजें।',
    draftHeader: 'विभाग को ड्राफ़्ट ईमेल',
    draftHint: 'विभाग को भेजने के लिए *SEND* लिखें, या बताएँ क्या बदलना है।',
  },
}

/** Returns true the first time a provider message id is seen (webhooks are retried). */
async function claimMessage(provider: string, messageId: string, wa: string): Promise<boolean> {
  const res = await dbQuery(
    `INSERT INTO whatsapp_inbound_dedupe (provider, message_id, wa_id) VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING RETURNING message_id`,
    [provider, messageId, wa],
  )
  if (res.rows.length && Math.random() < 0.01) {
    dbQuery(`DELETE FROM whatsapp_inbound_dedupe WHERE created_at < now() - interval '14 days'`).catch(() => {})
  }
  return res.rows.length > 0
}

async function activeSessionId(orgId: string, wa: string): Promise<{ id: string; hasDraft: boolean } | null> {
  const res = await dbQuery<{ session_id: string; last_inbound_at: string }>(
    `SELECT session_id, last_inbound_at FROM whatsapp_guide_sessions WHERE organization_id = $1 AND wa_id = $2`,
    [orgId, wa],
  )
  const row = res.rows[0]
  if (!row) return null
  const ageMs = Date.now() - new Date(row.last_inbound_at).getTime()
  if (ageMs > sessionTtlHours() * 3_600_000) return null
  const session = await loadGuideSession(orgId, row.session_id)
  if (!session || session.status !== 'open') return null
  return { id: session.id, hasDraft: !!session.draft }
}

async function bindSession(orgId: string, wa: string, sessionId: string): Promise<void> {
  await dbQuery(
    `INSERT INTO whatsapp_guide_sessions (organization_id, wa_id, session_id, last_inbound_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (organization_id, wa_id)
     DO UPDATE SET session_id = EXCLUDED.session_id, last_inbound_at = now()`,
    [orgId, wa, sessionId],
  )
}

function formatReply(turn: GuideTurn): string {
  let text = turn.reply.replace(/\*\*(.+?)\*\*/g, '*$1*').trim()
  if (turn.draft && turn.status !== 'raised') {
    const c = COPY[turn.language]
    text += `\n\n— ${c.draftHeader} —\nTo: ${turn.draft.to}\nSubject: ${turn.draft.subject}\n\n${turn.draft.body}\n\n${c.draftHint}`
  }
  return text
}

export async function handleWhatsAppInbound(args: { orgId: string; msg: InboundWhatsApp }): Promise<void> {
  const { orgId, msg } = args
  const wa = msg.from
  const tag = `[whatsapp:guide] ${maskWa(wa)}`

  if (!(await claimMessage('telinfy', msg.messageId, wa))) {
    console.log(`${tag} duplicate ${msg.messageId} ignored`)
    return
  }

  let lang: GuideLang = detectLang(msg.text) ?? 'en'
  try {
    // Media we can't read and no caption -> ask for text.
    if (!msg.text) {
      await sendWhatsAppText(wa, COPY[lang].media)
      return
    }

    const citizen = await findOrCreateCitizenByPhone({
      orgId,
      phoneRaw: wa,
      displayName: msg.name,
      channel: 'whatsapp',
    })

    const reset = RESET_RE.test(msg.text)
    const existing = reset ? null : await activeSessionId(orgId, wa)
    const confirm = !!existing?.hasDraft && CONFIRM_RE.test(msg.text)

    const turn = await handleGuideTurn({
      orgId,
      sessionId: existing?.id ?? null,
      // Language is only chosen when a session starts; afterwards the guide follows the citizen's script.
      language: existing ? null : (detectLang(msg.text) ?? (citizen.preferred_language as GuideLang) ?? 'te'),
      message: reset || confirm ? null : msg.text,
      confirmSend: confirm,
      citizenId: citizen.id,
      citizenName: citizen.display_name ?? msg.name,
      citizenPhone: citizen.phone_e164 ?? `+${wa}`,
      citizenEmail: citizen.email,
    })
    lang = turn.language

    await bindSession(orgId, wa, turn.session_id)

    const sent = await sendWhatsAppText(wa, formatReply(turn))
    if (!sent.ok) {
      console.error(`${tag} send failed: ${sent.error}`)
    } else {
      console.log(`${tag} replied (${sent.provider}) session=${turn.session_id.slice(0, 8)}`)
    }
  } catch (err) {
    if (err instanceof HttpError && err.status === 403) {
      console.warn(`${tag} blocked citizen — no reply`)
      return
    }
    console.error(`${tag} handler failed`, err)
    await sendWhatsAppText(wa, COPY[lang].error).catch(() => {})
  }
}
