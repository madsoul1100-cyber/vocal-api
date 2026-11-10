import crypto from 'node:crypto'
import express, { Router, type Request } from 'express'
import { handleWhatsAppInbound } from '@/modules/bharosa/whatsapp/guideBridge.js'
import { parseTelinfyFailures, parseTelinfyInbound } from '@/modules/bharosa/whatsapp/telinfy.js'

/**
 * Telinfy WhatsApp webhook, mounted at /webhooks/telinfy.
 *
 *   POST /webhooks/telinfy/whatsapp?token=<TELINFY_WEBHOOK_TOKEN>
 *
 * Telinfy has no signature header, so the URL carries a shared secret. We always answer 200
 * quickly (Telinfy/Meta retry otherwise) and run the chatbot in the background.
 */
const router = Router()
router.use(express.json({ limit: '2mb' }))

function tokenOk(req: Request): boolean {
  const expected = (process.env.TELINFY_WEBHOOK_TOKEN ?? '').trim()
  if (!expected) return process.env.NODE_ENV === 'development' // never open in production
  const given =
    (typeof req.query.token === 'string' ? req.query.token : '') ||
    (typeof req.headers['x-webhook-token'] === 'string' ? req.headers['x-webhook-token'] : '')
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

// Per-number queue: messages from one citizen are handled strictly in order.
const queues = new Map<string, Promise<void>>()
function enqueue(wa: string, job: () => Promise<void>): void {
  const prev = queues.get(wa) ?? Promise.resolve()
  const next = prev.then(job).catch((err) => console.error('[telinfy] job failed', err))
  queues.set(wa, next)
  next.finally(() => {
    if (queues.get(wa) === next) queues.delete(wa)
  })
}

router.get('/whatsapp', (req, res) => {
  // Meta-style verification handshake (if Telinfy/Meta ever asks for it) + simple health check.
  const challenge = req.query['hub.challenge']
  if (req.query['hub.mode'] === 'subscribe' && typeof challenge === 'string') {
    const expected = (process.env.TELINFY_WEBHOOK_TOKEN ?? '').trim()
    if (expected && req.query['hub.verify_token'] === expected) {
      res.status(200).send(challenge)
      return
    }
    res.status(403).send('forbidden')
    return
  }
  res.json({ ok: true, service: 'telinfy-whatsapp-webhook' })
})

router.post('/whatsapp', (req, res) => {
  if (!tokenOk(req)) {
    res.status(403).json({ error: 'forbidden' })
    return
  }
  // Acknowledge first — never make Telinfy wait on the chatbot.
  res.status(200).json({ ok: true })

  const orgId = process.env.ORG_ID
  if (!orgId) {
    console.error('[telinfy] ORG_ID not set — dropping inbound message')
    return
  }

  for (const f of parseTelinfyFailures(req.body)) {
    console.warn(`[telinfy] delivery failed to ***${f.recipient.slice(-4)} code=${f.code} ${f.title}`)
  }

  for (const msg of parseTelinfyInbound(req.body)) {
    enqueue(msg.from, () => handleWhatsAppInbound({ orgId, msg }))
  }
})

export default router
