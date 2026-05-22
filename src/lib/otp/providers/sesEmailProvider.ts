import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses'
import type { OtpEmailProvider, OtpSendPayload } from '@/lib/otp/types.js'

function sesClient(): SESClient | null {
  const region = process.env.AWS_REGION?.trim()
  if (!region) return null
  return new SESClient({
    region,
    credentials:
      process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
        ? {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
          }
        : undefined,
  })
}

function isConfigured(): boolean {
  const from = process.env.AWS_SES_FROM_EMAIL?.trim().toLowerCase() ?? ''
  if (!from || !process.env.AWS_REGION?.trim()) return false
  // Placeholder from .env.example — treat as not set up
  if (from.includes('yourdomain.com') || from === 'noreply@example.com') return false
  return true
}

function buildHtml(payload: OtpSendPayload): string {
  const action = payload.purpose === 'forgot_password' ? 'reset your password' : 'sign in'
  return `
    <p>Your ${payload.appName} verification code is:</p>
    <p style="font-size:24px;font-weight:bold;letter-spacing:4px">${payload.code}</p>
    <p>Use this code to ${action}. It expires in ${payload.ttlMinutes} minutes.</p>
    <p style="color:#666;font-size:12px">If you did not request this, ignore this email.</p>
  `.trim()
}

export const sesEmailProvider: OtpEmailProvider = {
  name: 'aws-ses',
  async send(to, payload) {
    if (!isConfigured()) {
      return {
        ok: false,
        provider: 'aws-ses',
        error: 'AWS SES not configured (AWS_REGION, AWS_SES_FROM_EMAIL)',
      }
    }

    const from = process.env.AWS_SES_FROM_EMAIL!.trim()
    const client = sesClient()
    if (!client) {
      return { ok: false, provider: 'aws-ses', error: 'SES client could not be created' }
    }

    const subject =
      payload.purpose === 'forgot_password'
        ? `${payload.appName} — password reset code`
        : `${payload.appName} — sign-in code`

    try {
      await client.send(
        new SendEmailCommand({
          Source: from,
          Destination: { ToAddresses: [to] },
          Message: {
            Subject: { Data: subject, Charset: 'UTF-8' },
            Body: {
              Html: { Data: buildHtml(payload), Charset: 'UTF-8' },
              Text: {
                Data: `Your ${payload.appName} verification code is ${payload.code}. Valid for ${payload.ttlMinutes} minutes.`,
                Charset: 'UTF-8',
              },
            },
          },
        }),
      )
      return { ok: true, provider: 'aws-ses' }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'SES send failed'
      console.error('[otp:aws-ses]', msg)
      return { ok: false, provider: 'aws-ses', error: msg }
    }
  },
}

export function sesEmailConfigured(): boolean {
  return isConfigured()
}
