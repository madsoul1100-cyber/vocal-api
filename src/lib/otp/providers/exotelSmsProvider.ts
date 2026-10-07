import type { OtpSendPayload, OtpSmsProvider } from '@/lib/otp/types.js'

/**
 * Exotel SMS (India, DLT-compliant).
 *
 * TRAI DLT: the rendered body must match the registered template character for
 * character, with `{#var#}` slots filled. Set EXOTEL_OTP_TEMPLATE to the exact
 * registered text using {code}, {app}, {ttl} placeholders.
 */

function cfg() {
  return {
    sid: process.env.EXOTEL_SID?.trim() ?? '',
    apiKey: process.env.EXOTEL_API_KEY?.trim() ?? '',
    apiToken: process.env.EXOTEL_API_TOKEN?.trim() ?? '',
    subdomain: process.env.EXOTEL_SUBDOMAIN?.trim() || 'api.exotel.com',
    senderId: process.env.EXOTEL_SENDER_ID?.trim() ?? '',
    dltEntityId: process.env.EXOTEL_DLT_ENTITY_ID?.trim() ?? '',
    otpTemplateId: process.env.EXOTEL_DLT_OTP_TEMPLATE_ID?.trim() ?? '',
    otpTemplate:
      process.env.EXOTEL_OTP_TEMPLATE?.trim() ||
      '{code} is your {app} verification code. It is valid for {ttl} minutes. Do not share it with anyone.',
    statusCallback: process.env.EXOTEL_SMS_STATUS_CALLBACK_URL?.trim() ?? '',
  }
}

export function exotelSmsConfigured(): boolean {
  const c = cfg()
  return !!(c.sid && c.apiKey && c.apiToken && c.senderId && c.dltEntityId && c.otpTemplateId)
}

export function renderExotelOtpBody(payload: OtpSendPayload): string {
  return cfg()
    .otpTemplate.replaceAll('{code}', payload.code)
    .replaceAll('{app}', payload.appName)
    .replaceAll('{ttl}', String(payload.ttlMinutes))
}

export async function sendExotelSms(args: {
  to: string
  body: string
  dltTemplateId: string
  priority?: 'normal' | 'high'
}): Promise<{ ok: true; sid: string | null } | { ok: false; error: string }> {
  const c = cfg()
  if (!c.sid || !c.apiKey || !c.apiToken || !c.senderId || !c.dltEntityId) {
    return { ok: false, error: 'Exotel not configured (EXOTEL_SID, EXOTEL_API_KEY, EXOTEL_API_TOKEN, EXOTEL_SENDER_ID, EXOTEL_DLT_ENTITY_ID)' }
  }
  const form = new URLSearchParams({
    From: c.senderId,
    To: args.to,
    Body: args.body,
    DltEntityId: c.dltEntityId,
    DltTemplateId: args.dltTemplateId,
    Priority: args.priority ?? 'normal',
  })
  if (c.statusCallback) form.set('StatusCallback', c.statusCallback)

  const auth = Buffer.from(`${c.apiKey}:${c.apiToken}`).toString('base64')
  try {
    const res = await fetch(`https://${c.subdomain}/v1/Accounts/${encodeURIComponent(c.sid)}/Sms/send.json`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      signal: AbortSignal.timeout(15_000),
    })
    const text = await res.text()
    if (!res.ok) return { ok: false, error: `Exotel ${res.status}: ${text.slice(0, 300)}` }
    let sid: string | null = null
    try {
      sid = (JSON.parse(text) as { SMSMessage?: { Sid?: string } }).SMSMessage?.Sid ?? null
    } catch {
      /* non-JSON success body */
    }
    return { ok: true, sid }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Exotel request failed' }
  }
}

export const exotelSmsProvider: OtpSmsProvider = {
  name: 'exotel-sms',
  async send(to, payload) {
    if (!exotelSmsConfigured()) {
      return {
        ok: false,
        provider: 'exotel-sms',
        error: 'Exotel SMS not configured (EXOTEL_* and EXOTEL_DLT_OTP_TEMPLATE_ID required)',
      }
    }
    const result = await sendExotelSms({
      to,
      body: renderExotelOtpBody(payload),
      dltTemplateId: cfg().otpTemplateId,
      priority: 'high',
    })
    if (!result.ok) {
      console.error('[otp:exotel-sms]', result.error)
      return { ok: false, provider: 'exotel-sms', error: result.error }
    }
    return { ok: true, provider: 'exotel-sms' }
  },
}
