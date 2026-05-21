/**
 * Twilio client + webhook signature validation.
 */

import twilio from 'twilio'

const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID ?? ''
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN ?? ''

let _client: ReturnType<typeof twilio> | null = null

export function getTwilioClient(): ReturnType<typeof twilio> | null {
  if (!ACCOUNT_SID || !AUTH_TOKEN) return null
  if (!_client) _client = twilio(ACCOUNT_SID, AUTH_TOKEN)
  return _client
}

export function getWhatsAppFrom(): string | null {
  const from = process.env.TWILIO_WHATSAPP_FROM?.trim()
  if (!from) return null
  return from.startsWith('whatsapp:') ? from : `whatsapp:${from}`
}

/** `whatsapp:+919876543210` → `+919876543210` (channel_user_id) */
export function parseWhatsAppUserId(from: string): string {
  const s = from.trim()
  if (s.startsWith('whatsapp:')) return s.slice('whatsapp:'.length)
  return s
}

/** E.164 or digits → `whatsapp:+...` for outbound To */
export function toWhatsAppAddress(channelUserId: string): string {
  const id = channelUserId.trim()
  if (id.startsWith('whatsapp:')) return id
  const phone = id.startsWith('+') ? id : `+${id.replace(/\D/g, '')}`
  return `whatsapp:${phone}`
}

/**
 * Validate X-Twilio-Signature on inbound webhooks.
 * Set TWILIO_SKIP_SIGNATURE_VALIDATION=true only for local tunnel debugging.
 */
export function validateTwilioWebhook(args: {
  signature: string | undefined
  url: string
  params: Record<string, string>
}): boolean {
  if (process.env.TWILIO_SKIP_SIGNATURE_VALIDATION === 'true') return true
  if (!AUTH_TOKEN) return false
  if (!args.signature) return false
  return twilio.validateRequest(AUTH_TOKEN, args.signature, args.url, args.params)
}

/** Flatten Twilio form body to string params for signature check. */
export function twilioParamsFromBody(body: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined || v === null) continue
    out[k] = String(v)
  }
  return out
}
