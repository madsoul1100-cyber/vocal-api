import {
  exposeDevOtpInApi,
  otpAppName,
  otpChannelPreference,
  otpTtlMinutes,
  resolveOtpDeliveryMode,
} from '@/lib/otp/config.js'
import { consoleEmailProvider, consoleSmsProvider } from '@/lib/otp/providers/consoleProvider.js'
import { sesEmailProvider, sesEmailConfigured } from '@/lib/otp/providers/sesEmailProvider.js'
import { twilioSmsProvider, twilioSmsConfigured } from '@/lib/otp/providers/twilioSmsProvider.js'
import type {
  OtpChannel,
  OtpDeliveryStatus,
  OtpPurpose,
  OtpSendPayload,
} from '@/lib/otp/types.js'

function buildPayload(code: string, purpose: OtpPurpose): OtpSendPayload {
  return {
    code,
    purpose,
    appName: otpAppName(),
    ttlMinutes: otpTtlMinutes(),
  }
}

function emailProvider() {
  return resolveOtpDeliveryMode() === 'console' ? consoleEmailProvider : sesEmailProvider
}

function smsProvider() {
  return resolveOtpDeliveryMode() === 'console' ? consoleSmsProvider : twilioSmsProvider
}

export function getOtpDeliveryStatus(): OtpDeliveryStatus {
  const mode = resolveOtpDeliveryMode()
  if (mode === 'console') {
    return {
      mode,
      email: { provider: 'console', configured: true },
      sms: { provider: 'console', configured: true },
    }
  }
  return {
    mode,
    email: { provider: 'aws-ses', configured: sesEmailConfigured() },
    sms: { provider: 'twilio-sms', configured: twilioSmsConfigured() },
  }
}

export interface DeliverOtpResult {
  channel: OtpChannel
  destination: string
  provider: string
  dev_code?: string
}

/**
 * Send OTP via configured third-party providers.
 * Tries primary channel first (sms or email per OTP_CHANNEL_PREFERENCE), then fallback.
 */
export async function deliverStaffOtp(args: {
  code: string
  purpose: OtpPurpose
  email: string
  phone: string
}): Promise<{ ok: true; result: DeliverOtpResult } | { ok: false; error: string }> {
  const payload = buildPayload(args.code, args.purpose)
  const preference = otpChannelPreference()

  const attempts: Array<{ channel: OtpChannel; destination: string }> =
    preference === 'email_first'
      ? [
          { channel: 'email', destination: args.email },
          { channel: 'sms', destination: args.phone },
        ]
      : [
          { channel: 'sms', destination: args.phone },
          { channel: 'email', destination: args.email },
        ]

  const errors: string[] = []
  let devCode: string | undefined

  for (const { channel, destination } of attempts) {
    const outcome =
      channel === 'email'
        ? await emailProvider().send(destination, payload)
        : await smsProvider().send(destination, payload)

    if (outcome.ok) {
      if (outcome.loggedCode && exposeDevOtpInApi()) {
        devCode = outcome.loggedCode
      }
      return {
        ok: true,
        result: {
          channel,
          destination,
          provider: outcome.provider,
          ...(devCode ? { dev_code: devCode } : {}),
        },
      }
    }
    errors.push(`${channel} (${outcome.provider}): ${outcome.error}`)
  }

  const status = getOtpDeliveryStatus()
  return {
    ok: false,
    error: `Could not send verification code. Mode=${status.mode}. ${errors.join('; ')}`,
  }
}
