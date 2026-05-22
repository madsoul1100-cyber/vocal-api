import { getTwilioClient } from '@/lib/twilio.js'
import type { OtpSendPayload, OtpSmsProvider } from '@/lib/otp/types.js'

function isConfigured(): boolean {
  return !!(process.env.TWILIO_ACCOUNT_SID?.trim() && process.env.TWILIO_AUTH_TOKEN?.trim() && process.env.TWILIO_SMS_FROM?.trim())
}

export const twilioSmsProvider: OtpSmsProvider = {
  name: 'twilio-sms',
  async send(to, payload) {
    if (!isConfigured()) {
      return {
        ok: false,
        provider: 'twilio-sms',
        error: 'Twilio SMS not configured (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_SMS_FROM)',
      }
    }

    const client = getTwilioClient()
    if (!client) {
      return { ok: false, provider: 'twilio-sms', error: 'Twilio client unavailable' }
    }

    const from = process.env.TWILIO_SMS_FROM!.trim()
    const action = payload.purpose === 'forgot_password' ? 'reset your password' : 'sign in'

    try {
      await client.messages.create({
        from,
        to,
        body: `${payload.appName}: Your verification code is ${payload.code}. Use it to ${action}. Expires in ${payload.ttlMinutes} minutes.`,
      })
      return { ok: true, provider: 'twilio-sms' }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Twilio SMS failed'
      console.error('[otp:twilio-sms]', msg)
      return { ok: false, provider: 'twilio-sms', error: msg }
    }
  },
}

export function twilioSmsConfigured(): boolean {
  return isConfigured()
}
