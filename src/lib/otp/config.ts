import type { OtpChannel, OtpDeliveryMode } from '@/lib/otp/types.js'

export function otpAppName(): string {
  return process.env.OTP_APP_NAME?.trim() || 'Vocal'
}

export function otpTtlMinutes(): number {
  const n = parseInt(process.env.OTP_TTL_MINUTES ?? '10', 10)
  return Number.isFinite(n) && n > 0 ? n : 10
}

/**
 * console — log codes (local / CI / staging without SMS/SES credentials)
 * live    — AWS SES (email) + Twilio SMS
 *
 * Default: console in development, live otherwise. Override with OTP_DELIVERY_MODE.
 */
export function resolveOtpDeliveryMode(): OtpDeliveryMode {
  const raw = process.env.OTP_DELIVERY_MODE?.trim().toLowerCase()
  if (raw === 'console' || raw === 'test' || raw === 'mock') return 'console'
  if (raw === 'live' || raw === 'production' || raw === 'prod') return 'live'
  if (process.env.NODE_ENV === 'development') return 'console'
  return 'live'
}

/** sms_first | email_first — which channel to try first when both are available */
export function otpChannelPreference(): 'sms_first' | 'email_first' {
  const raw = process.env.OTP_CHANNEL_PREFERENCE?.trim().toLowerCase()
  return raw === 'email_first' ? 'email_first' : 'sms_first'
}

/**
 * Which channels to use. Comma-separated: sms, email (default both).
 * Example: OTP_CHANNELS=sms — Twilio only, skip SES entirely.
 */
export function otpEnabledChannels(): OtpChannel[] {
  const raw = process.env.OTP_CHANNELS?.trim().toLowerCase()
  if (raw) {
    const parts = raw.split(',').map((p) => p.trim())
    const channels: OtpChannel[] = []
    if (parts.includes('sms')) channels.push('sms')
    if (parts.includes('email')) channels.push('email')
    if (channels.length) return channels
  }
  if (process.env.OTP_EMAIL_ENABLED === 'false') return ['sms']
  if (process.env.OTP_SMS_ENABLED === 'false') return ['email']
  return ['sms', 'email']
}

export function exposeDevOtpInApi(): boolean {
  if (process.env.OTP_EXPOSE_DEV_CODE === 'false') return false
  return resolveOtpDeliveryMode() === 'console' || process.env.OTP_EXPOSE_DEV_CODE === 'true'
}
