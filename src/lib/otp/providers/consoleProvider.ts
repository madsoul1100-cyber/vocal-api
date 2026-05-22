import type { OtpEmailProvider, OtpSendPayload, OtpSmsProvider } from '@/lib/otp/types.js'

function logDelivery(channel: 'email' | 'sms', to: string, payload: OtpSendPayload) {
  const label = payload.purpose === 'forgot_password' ? 'password reset' : 'sign-in'
  console.info(
    `[otp:console] ${channel.toUpperCase()} → ${to} | ${label} | code=${payload.code} | valid ${payload.ttlMinutes}m`,
  )
}

export const consoleEmailProvider: OtpEmailProvider = {
  name: 'console',
  async send(to, payload) {
    logDelivery('email', to, payload)
    return { ok: true, provider: 'console', loggedCode: payload.code }
  },
}

export const consoleSmsProvider: OtpSmsProvider = {
  name: 'console',
  async send(to, payload) {
    logDelivery('sms', to, payload)
    return { ok: true, provider: 'console', loggedCode: payload.code }
  },
}
