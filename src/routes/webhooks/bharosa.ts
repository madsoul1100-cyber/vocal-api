import crypto from 'node:crypto'
import express, { Router } from 'express'
import { route, HttpError } from '@/modules/bharosa/common.js'
import {
  confirmSnsSubscription,
  mimeToText,
  parseAddress,
  parseSesEvent,
  parseSesInbound,
  verifySnsMessage,
  type SnsMessage,
} from '@/modules/bharosa/comms/inbound.js'
import { recordInboundReply, recordProviderEvent } from '@/modules/bharosa/comms/communications.js'
import { intakeTarget, threadKeyFromAddress } from '@/modules/bharosa/comms/emailProvider.js'
import { handleVoiceCallback, verifyVoiceCallbackToken } from '@/modules/bharosa/cases/verification.js'
import { createEmailSubmission } from '@/modules/bharosa/citizen/submissions.js'
import { dbQuery } from '@/lib/db.js'

/**
 * Bharosa provider webhooks, mounted at /webhooks/bharosa.
 *  - POST /ses           SNS topic for SES delivery/bounce/complaint events AND inbound (Received) mail
 *  - POST /inbound-email Generic JSON inbound mail (other providers / testing), shared-secret protected
 *  - POST /voice/:checkId?token=…  Automated verification call results
 */
const router = Router()

// SNS posts JSON with Content-Type text/plain.
router.post(
  '/ses',
  express.text({ type: '*/*', limit: '15mb' }),
  route(async (req, res) => {
    let msg: SnsMessage
    try {
      msg = JSON.parse(typeof req.body === 'string' ? req.body : JSON.stringify(req.body)) as SnsMessage
    } catch {
      throw new HttpError(400, 'Invalid SNS payload')
    }
    if (!(await verifySnsMessage(msg))) throw new HttpError(403, 'SNS signature verification failed')

    if (msg.Type === 'SubscriptionConfirmation') {
      res.json({ confirmed: await confirmSnsSubscription(msg) })
      return
    }
    if (msg.Type !== 'Notification') {
      res.json({ ok: true })
      return
    }

    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(msg.Message) as Record<string, unknown>
    } catch {
      res.json({ ignored: 'non-json message' })
      return
    }

    const inbound = await parseSesInbound(payload)
    if (inbound) {
      const threadKey = inbound.to.map(threadKeyFromAddress).find(Boolean) ?? null
      const text = inbound.rawMime ? mimeToText(inbound.rawMime) : { full: '', reply: '' }
      const out = await recordInboundReply({
        threadKey,
        inReplyToMessageIds: inbound.inReplyTo,
        fromEmail: inbound.from,
        fromName: inbound.fromName,
        subject: inbound.subject,
        text: text.reply || text.full,
        provider: 'ses',
        providerMessageId: inbound.messageId,
        raw: { to: inbound.to, subject: inbound.subject, full_text: text.full.slice(0, 50_000) },
      })
      if (!out.matched && !threadKey) {
        const intake = await maybeEmailIntake({
          to: inbound.to, fromEmail: inbound.from, fromName: inbound.fromName, subject: inbound.subject,
          text: text.full || text.reply, messageId: inbound.messageId,
        })
        if (intake) {
          res.json({ inbound: true, matched: false, intake })
          return
        }
      }
      res.json({ inbound: true, ...out })
      return
    }

    const ev = parseSesEvent(payload)
    if (!ev) {
      res.json({ ignored: true })
      return
    }
    const out = await recordProviderEvent({
      provider: 'ses',
      providerMessageId: ev.messageId,
      eventType: ev.kind,
      providerEventId: ev.eventId,
      bouncedRecipients: ev.recipients,
      permanent: ev.permanent,
      raw: payload,
    })
    res.json(out)
  }),
)

/** New complaint emailed to the intake address → draft submission + "finish your complaint" email. */
async function maybeEmailIntake(args: {
  to: string[]
  fromEmail: string
  fromName: string | null
  subject: string | null
  text: string
  messageId: string | null
}) {
  const target = args.to.map((a) => intakeTarget(parseAddress(a).email)).find(Boolean)
  if (!target) return null
  let orgId: string | null = null
  if (target.slug) {
    orgId = (await dbQuery<{ id: string }>(`SELECT id FROM organizations WHERE slug = $1 AND active = true`, [target.slug])).rows[0]?.id ?? null
  } else {
    orgId = process.env.ORG_ID?.trim() || null
  }
  if (!orgId) return { created: false, reason: 'unknown_org' }
  return createEmailSubmission({
    orgId, fromEmail: args.fromEmail, fromName: args.fromName, subject: args.subject, text: args.text, messageId: args.messageId,
  })
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb)
}

router.post(
  '/inbound-email',
  express.json({ limit: '5mb' }),
  route(async (req, res) => {
    const secret = process.env.BHAROSA_INBOUND_WEBHOOK_SECRET?.trim()
    const given = String(req.headers['x-bharosa-secret'] ?? '')
    if (!secret || !safeEqual(given, secret)) throw new HttpError(401, 'Invalid webhook secret')

    const b = (req.body ?? {}) as Record<string, unknown>
    const toList = (Array.isArray(b.to) ? b.to : [b.to]).filter((x): x is string => typeof x === 'string')
    const from = parseAddress(String(b.from ?? ''))
    if (!from.email) throw new HttpError(400, 'from is required')
    const refs = [b.in_reply_to, b.references]
      .filter((x): x is string => typeof x === 'string')
      .join(' ')
      .match(/<[^>]+>/g)
      ?.map((r) => r.slice(1, -1)) ?? []
    const mime = typeof b.raw_mime === 'string' ? mimeToText(b.raw_mime) : null
    const text = typeof b.text === 'string' ? b.text : mime?.reply ?? ''
    const threadKey = toList.map(threadKeyFromAddress).find(Boolean) ?? (typeof b.thread_key === 'string' ? b.thread_key : null)
    const subject = typeof b.subject === 'string' ? b.subject : null
    const messageId = typeof b.message_id === 'string' ? b.message_id : null
    const out = await recordInboundReply({
      threadKey,
      inReplyToMessageIds: refs,
      fromEmail: from.email,
      fromName: from.name,
      subject,
      text,
      provider: typeof b.provider === 'string' ? b.provider : 'generic',
      providerMessageId: messageId,
    })
    if (!out.matched && !threadKey) {
      const intake = await maybeEmailIntake({
        to: toList, fromEmail: from.email, fromName: from.name, subject, text: mime?.full || text, messageId,
      })
      if (intake) {
        res.json({ matched: false, intake })
        return
      }
    }
    res.json(out)
  }),
)

router.post(
  '/voice/:checkId',
  express.json({ limit: '2mb' }),
  route(async (req, res) => {
    const checkId = String(req.params.checkId)
    const token = String(req.query.token ?? req.headers['x-bharosa-token'] ?? '')
    if (!token || !verifyVoiceCallbackToken(checkId, token)) throw new HttpError(401, 'Invalid callback token')
    res.json(await handleVoiceCallback(checkId, (req.body ?? {}) as Record<string, unknown>))
  }),
)

export default router
