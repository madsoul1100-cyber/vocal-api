import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses'

export interface OutboundEmail {
  to: string[]
  cc?: string[]
  subject: string
  text: string
  html?: string
  replyTo?: string | null
  fromName?: string | null
  tags?: Record<string, string>
}

export type SendEmailResult =
  | { ok: true; provider: string; messageId: string }
  | { ok: false; provider: string; error: string; permanent: boolean }

export function emailDeliveryMode(): 'console' | 'live' {
  const raw = process.env.EMAIL_DELIVERY_MODE?.trim().toLowerCase()
  if (raw === 'live') return 'live'
  if (raw === 'console') return 'console'
  return process.env.NODE_ENV === 'development' ? 'console' : 'live'
}

function fromAddress(): string {
  return process.env.BHAROSA_EMAIL_FROM?.trim() || process.env.AWS_SES_FROM_EMAIL?.trim() || ''
}

export function inboundDomain(): string | null {
  return process.env.BHAROSA_INBOUND_EMAIL_DOMAIN?.trim() || null
}

/** case+<threadKey>@<inbound domain> — SES receipt rule routes these to the inbound webhook. */
export function replyToForThread(threadKey: string): string | null {
  const domain = inboundDomain()
  if (!domain) return null
  const local = process.env.BHAROSA_INBOUND_EMAIL_LOCAL?.trim() || 'case'
  return `${local}+${threadKey}@${domain}`
}

export function threadKeyFromAddress(address: string): string | null {
  const m = address.toLowerCase().match(/\+([a-z0-9]{6,40})@/)
  return m ? m[1] : null
}

/**
 * Citizen intake address: `<local>@<inbound domain>` for the default org, or
 * `<local>-<org-slug>@<inbound domain>` for a specific tenant.
 */
export function intakeTarget(address: string): { slug: string | null } | null {
  const domain = inboundDomain()?.toLowerCase()
  const local = (process.env.BHAROSA_INTAKE_EMAIL_LOCAL?.trim() || 'complaints').toLowerCase()
  const m = address.trim().toLowerCase().match(/^([^@\s]+)@([^@\s]+)$/)
  if (!m || (domain && m[2] !== domain)) return null
  if (m[1] === local) return { slug: null }
  if (m[1].startsWith(`${local}-`)) return { slug: m[1].slice(local.length + 1) || null }
  return null
}

function sesClient(): SESClient {
  const region = process.env.AWS_SES_REGION?.trim() || process.env.AWS_REGION?.trim()
  return new SESClient({
    region,
    credentials:
      process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
        ? { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY }
        : undefined,
  })
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function textToHtml(text: string): string {
  return `<div style="font-family:Arial,'Noto Sans Telugu',sans-serif;font-size:14px;line-height:1.6;color:#111">${escapeHtml(text)
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, '<br/>')}</p>`)
    .join('')}</div>`
}

export async function sendEmail(msg: OutboundEmail): Promise<SendEmailResult> {
  if (emailDeliveryMode() === 'console') {
    const messageId = `console-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    console.info(
      `[bharosa:email:console] to=${msg.to.join(',')} cc=${(msg.cc ?? []).join(',')} replyTo=${msg.replyTo ?? '-'}\n  subject: ${msg.subject}\n  ${msg.text.slice(0, 400).replace(/\n/g, '\n  ')}`,
    )
    return { ok: true, provider: 'console', messageId }
  }

  const from = fromAddress()
  if (!from) return { ok: false, provider: 'aws-ses', error: 'BHAROSA_EMAIL_FROM / AWS_SES_FROM_EMAIL not set', permanent: true }
  const source = msg.fromName ? `"${msg.fromName.replace(/"/g, '')}" <${from}>` : from

  try {
    const out = await sesClient().send(
      new SendEmailCommand({
        Source: source,
        Destination: { ToAddresses: msg.to, CcAddresses: msg.cc?.length ? msg.cc : undefined },
        ReplyToAddresses: msg.replyTo ? [msg.replyTo] : undefined,
        ConfigurationSetName: process.env.SES_CONFIGURATION_SET?.trim() || undefined,
        Tags: msg.tags
          ? Object.entries(msg.tags).map(([Name, Value]) => ({ Name, Value: Value.replace(/[^A-Za-z0-9_\-.@]/g, '_').slice(0, 255) }))
          : undefined,
        Message: {
          Subject: { Data: msg.subject, Charset: 'UTF-8' },
          Body: {
            Text: { Data: msg.text, Charset: 'UTF-8' },
            Html: { Data: msg.html ?? textToHtml(msg.text), Charset: 'UTF-8' },
          },
        },
      }),
    )
    return { ok: true, provider: 'aws-ses', messageId: out.MessageId ?? '' }
  } catch (err) {
    const name = (err as { name?: string }).name ?? ''
    const message = err instanceof Error ? err.message : 'SES send failed'
    const permanent = ['MessageRejected', 'MailFromDomainNotVerifiedException', 'ConfigurationSetDoesNotExistException'].includes(name)
    return { ok: false, provider: 'aws-ses', error: `${name}: ${message}`, permanent }
  }
}
