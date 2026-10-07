import crypto from 'node:crypto'
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3'

// ---------------------------------------------------------------------------
// AWS SNS signature verification
// ---------------------------------------------------------------------------

export interface SnsMessage {
  Type: 'Notification' | 'SubscriptionConfirmation' | 'UnsubscribeConfirmation'
  MessageId: string
  TopicArn: string
  Message: string
  Timestamp: string
  SignatureVersion: string
  Signature: string
  SigningCertURL: string
  Subject?: string
  Token?: string
  SubscribeURL?: string
}

const certCache = new Map<string, string>()
const CERT_HOST_RE = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/

function stringToSign(m: SnsMessage): string {
  const keys =
    m.Type === 'Notification'
      ? ['Message', 'MessageId', ...(m.Subject !== undefined ? ['Subject'] : []), 'Timestamp', 'TopicArn', 'Type']
      : ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type']
  return keys.map((k) => `${k}\n${(m as unknown as Record<string, string>)[k]}\n`).join('')
}

export async function verifySnsMessage(m: SnsMessage): Promise<boolean> {
  if (process.env.SNS_SKIP_SIGNATURE_VALIDATION === 'true' && process.env.NODE_ENV !== 'production') return true
  const allowedTopics = (process.env.SNS_ALLOWED_TOPIC_ARNS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  if (allowedTopics.length && !allowedTopics.includes(m.TopicArn)) return false

  let certUrl: URL
  try {
    certUrl = new URL(m.SigningCertURL)
  } catch {
    return false
  }
  if (certUrl.protocol !== 'https:' || !CERT_HOST_RE.test(certUrl.hostname) || !certUrl.pathname.endsWith('.pem')) return false

  let pem = certCache.get(certUrl.href)
  if (!pem) {
    const res = await fetch(certUrl.href, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) return false
    pem = await res.text()
    certCache.set(certUrl.href, pem)
  }
  const algo = m.SignatureVersion === '2' ? 'RSA-SHA256' : 'RSA-SHA1'
  const verifier = crypto.createVerify(algo)
  verifier.update(stringToSign(m), 'utf8')
  return verifier.verify(pem, m.Signature, 'base64')
}

export async function confirmSnsSubscription(m: SnsMessage): Promise<boolean> {
  if (!m.SubscribeURL) return false
  const url = new URL(m.SubscribeURL)
  if (url.protocol !== 'https:' || !CERT_HOST_RE.test(url.hostname)) return false
  const res = await fetch(url.href, { signal: AbortSignal.timeout(5000) })
  return res.ok
}

// ---------------------------------------------------------------------------
// SES notifications
// ---------------------------------------------------------------------------

export interface SesDeliveryEvent {
  kind: 'delivered' | 'bounced' | 'complaint' | 'failed'
  messageId: string
  recipients: string[]
  permanent: boolean
  eventId: string
}

export function parseSesEvent(payload: Record<string, unknown>): SesDeliveryEvent | null {
  const type = String(payload.eventType ?? payload.notificationType ?? '')
  const mail = payload.mail as { messageId?: string } | undefined
  const messageId = mail?.messageId
  if (!messageId) return null
  if (type === 'Delivery') {
    const d = payload.delivery as { recipients?: string[]; timestamp?: string } | undefined
    return { kind: 'delivered', messageId, recipients: d?.recipients ?? [], permanent: false, eventId: `delivery:${messageId}:${d?.timestamp ?? ''}` }
  }
  if (type === 'Bounce') {
    const b = payload.bounce as { bounceType?: string; bouncedRecipients?: Array<{ emailAddress: string }>; feedbackId?: string } | undefined
    return {
      kind: 'bounced',
      messageId,
      recipients: (b?.bouncedRecipients ?? []).map((r) => r.emailAddress),
      permanent: b?.bounceType === 'Permanent',
      eventId: `bounce:${b?.feedbackId ?? messageId}`,
    }
  }
  if (type === 'Complaint') {
    const c = payload.complaint as { complainedRecipients?: Array<{ emailAddress: string }>; feedbackId?: string } | undefined
    return {
      kind: 'complaint',
      messageId,
      recipients: (c?.complainedRecipients ?? []).map((r) => r.emailAddress),
      permanent: false,
      eventId: `complaint:${c?.feedbackId ?? messageId}`,
    }
  }
  if (type === 'Reject' || type === 'Rendering Failure') {
    return { kind: 'failed', messageId, recipients: [], permanent: true, eventId: `reject:${messageId}` }
  }
  return null
}

export interface SesInboundEmail {
  messageId: string
  from: string
  fromName: string | null
  to: string[]
  subject: string | null
  inReplyTo: string[]
  rawMime: string | null
}

export async function parseSesInbound(payload: Record<string, unknown>): Promise<SesInboundEmail | null> {
  if (payload.notificationType !== 'Received') return null
  const mail = payload.mail as {
    messageId: string
    commonHeaders?: { from?: string[]; to?: string[]; subject?: string }
    headers?: Array<{ name: string; value: string }>
    destination?: string[]
  }
  const receipt = payload.receipt as { action?: { type?: string; encoding?: string; bucketName?: string; objectKey?: string } } | undefined

  let raw: string | null = null
  if (typeof payload.content === 'string') {
    raw = receipt?.action?.encoding === 'BASE64' ? Buffer.from(payload.content, 'base64').toString('utf8') : payload.content
  } else if (receipt?.action?.type === 'S3' && receipt.action.bucketName && receipt.action.objectKey) {
    const s3 = new S3Client({ region: process.env.AWS_SES_REGION?.trim() || process.env.AWS_REGION?.trim() })
    const obj = await s3.send(new GetObjectCommand({ Bucket: receipt.action.bucketName, Key: receipt.action.objectKey }))
    raw = obj.Body ? await obj.Body.transformToString('utf8') : null
  }

  const headers = new Map((mail.headers ?? []).map((h) => [h.name.toLowerCase(), h.value]))
  const fromHeader = mail.commonHeaders?.from?.[0] ?? headers.get('from') ?? ''
  const addr = parseAddress(fromHeader)
  const refs = [headers.get('in-reply-to'), headers.get('references')]
    .filter(Boolean)
    .join(' ')
    .match(/<[^>]+>/g) ?? []

  return {
    messageId: mail.messageId,
    from: addr.email,
    fromName: addr.name,
    to: [...(mail.destination ?? []), ...(mail.commonHeaders?.to ?? [])],
    subject: mail.commonHeaders?.subject ?? null,
    inReplyTo: refs.map((r) => r.slice(1, -1)),
    rawMime: raw,
  }
}

export function parseAddress(s: string): { email: string; name: string | null } {
  const m = s.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/)
  if (m) return { name: m[1].trim() || null, email: m[2].trim().toLowerCase() }
  return { name: null, email: s.trim().toLowerCase() }
}

// ---------------------------------------------------------------------------
// Minimal MIME → plain text
// ---------------------------------------------------------------------------

function splitHeaderBody(raw: string): { headers: Map<string, string>; body: string } {
  const idx = raw.search(/\r?\n\r?\n/)
  const head = idx >= 0 ? raw.slice(0, idx) : raw
  const body = idx >= 0 ? raw.slice(idx).replace(/^\r?\n\r?\n/, '') : ''
  const headers = new Map<string, string>()
  const unfolded = head.replace(/\r?\n[ \t]+/g, ' ')
  for (const line of unfolded.split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i > 0) headers.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim())
  }
  return { headers, body }
}

function param(header: string | undefined, name: string): string | null {
  if (!header) return null
  const m = header.match(new RegExp(`${name}\\s*=\\s*"?([^";]+)"?`, 'i'))
  return m ? m[1] : null
}

function decodeBody(body: string, encoding: string | undefined, charset: string | null): string {
  const enc = (encoding ?? '').toLowerCase()
  let bytes: Buffer
  if (enc === 'base64') {
    bytes = Buffer.from(body.replace(/\s+/g, ''), 'base64')
  } else if (enc === 'quoted-printable') {
    const qp = body.replace(/=\r?\n/g, '')
    const arr: number[] = []
    for (let i = 0; i < qp.length; i++) {
      if (qp[i] === '=' && /^[0-9A-F]{2}$/i.test(qp.slice(i + 1, i + 3))) {
        arr.push(parseInt(qp.slice(i + 1, i + 3), 16))
        i += 2
      } else {
        arr.push(qp.charCodeAt(i) & 0xff)
      }
    }
    bytes = Buffer.from(arr)
  } else {
    return body
  }
  try {
    return new TextDecoder(charset ?? 'utf-8').decode(bytes)
  } catch {
    return bytes.toString('utf8')
  }
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function extractText(raw: string, depth = 0): { text: string | null; html: string | null } {
  const { headers, body } = splitHeaderBody(raw)
  const ct = headers.get('content-type') ?? 'text/plain'
  const lower = ct.toLowerCase()
  if (lower.startsWith('multipart/') && depth < 5) {
    const boundary = param(ct, 'boundary')
    if (!boundary) return { text: body, html: null }
    const parts = body.split(new RegExp(`--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?\\s*`))
    let text: string | null = null
    let html: string | null = null
    for (const p of parts) {
      if (!p.trim()) continue
      const r = extractText(p, depth + 1)
      text = text ?? r.text
      html = html ?? r.html
    }
    return { text, html }
  }
  const disposition = headers.get('content-disposition') ?? ''
  if (/attachment/i.test(disposition)) return { text: null, html: null }
  const decoded = decodeBody(body, headers.get('content-transfer-encoding'), param(ct, 'charset'))
  if (lower.startsWith('text/html')) return { text: null, html: decoded }
  if (lower.startsWith('text/')) return { text: decoded, html: null }
  return { text: null, html: null }
}

/** Remove quoted history ("On … wrote:", "> …", forwarded headers). */
export function stripQuotedReply(text: string): string {
  const lines = text.split(/\r?\n/)
  const out: string[] = []
  for (const line of lines) {
    if (/^\s*On .{5,200}wrote:\s*$/i.test(line)) break
    if (/^-{2,}\s*Original Message\s*-{2,}/i.test(line)) break
    if (/^\s*From:\s.+/i.test(line) && out.length > 0 && out[out.length - 1].trim() === '') break
    if (/^\s*>/.test(line)) continue
    out.push(line)
  }
  return out.join('\n').trim()
}

export function mimeToText(raw: string): { full: string; reply: string } {
  const { text, html } = extractText(raw)
  const full = (text ?? (html ? htmlToText(html) : '')).trim()
  return { full, reply: stripQuotedReply(full) || full }
}
