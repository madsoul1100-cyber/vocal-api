/**
 * Telinfy WhatsApp Business API client + inbound payload parser.
 *
 * Docs: https://telinfy.ai/developer  and  https://telinfy-cloud.readme.io
 *
 *  - Free-text reply (inside the 24h customer-service window):
 *      POST {TELINFY_TEXT_URL}   header `Api-Key`   body {to, type:"text", text:{previewUrl, body}}
 *  - Template message (business-initiated / after 24h):
 *      POST {TELINFY_BASE_URL}/whatsapp/messages   header `x-api-key`   body {phoneNumber, template}
 *  - Inbound: Telinfy POSTs a Meta-format payload to our webhook (entry[].changes[].value.messages[]).
 */

export type SendResult =
  | { ok: true; provider: 'telinfy' | 'console'; messageId: string }
  | { ok: false; provider: 'telinfy'; error: string }

const DEFAULT_BASE_URL = 'https://hub.telinfy.com/unified/developer/api/v1'
const DEFAULT_TEXT_URL = 'https://api.telinfy.net/gaca/whatsapp/message/direct'
const WA_TEXT_LIMIT = 4000 // WhatsApp hard limit is 4096

function apiKey(): string {
  return (process.env.TELINFY_API_KEY ?? '').trim()
}

export function telinfyConfigured(): boolean {
  return apiKey().length > 0
}

/** Digits only, with country code (default India for bare 10-digit numbers). */
export function toWaDigits(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  return digits.length === 10 ? `91${digits}` : digits
}

/** Split long replies on paragraph/line boundaries so each part fits in one WhatsApp message. */
export function splitForWhatsApp(text: string, limit = WA_TEXT_LIMIT): string[] {
  const clean = text.trim()
  if (clean.length <= limit) return [clean]
  const parts: string[] = []
  let rest = clean
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n\n', limit)
    if (cut < limit * 0.5) cut = rest.lastIndexOf('\n', limit)
    if (cut < limit * 0.5) cut = rest.lastIndexOf(' ', limit)
    if (cut < 1) cut = limit
    parts.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest) parts.push(rest)
  return parts
}

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<{ ok: boolean; status: number; json: Record<string, unknown> | null; text: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const text = await res.text()
    let json: Record<string, unknown> | null = null
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : null
    } catch {
      json = null
    }
    return { ok: res.ok, status: res.status, json, text }
  } finally {
    clearTimeout(timer)
  }
}

function pickMessageId(json: Record<string, unknown> | null): string {
  if (!json) return `telinfy-${Date.now()}`
  const data = (json.data && typeof json.data === 'object' ? json.data : {}) as Record<string, unknown>
  const candidate =
    json.messageId ?? json.message_id ?? json.id ?? json.jobId ?? data.messageId ?? data.jobId ?? data.id
  return candidate !== undefined && candidate !== null ? String(candidate) : `telinfy-${Date.now()}`
}

async function sendOneText(to: string, body: string): Promise<SendResult> {
  if (!telinfyConfigured()) {
    if (process.env.NODE_ENV === 'development') {
      console.info(`[bharosa:whatsapp:console] to=${to}\n  ${body.replace(/\n/g, '\n  ')}`)
      return { ok: true, provider: 'console', messageId: `console-${Date.now()}` }
    }
    return { ok: false, provider: 'telinfy', error: 'TELINFY_API_KEY not configured' }
  }
  const url = (process.env.TELINFY_TEXT_URL ?? DEFAULT_TEXT_URL).trim()
  const headerName = (process.env.TELINFY_TEXT_AUTH_HEADER ?? 'Api-Key').trim()
  try {
    const r = await postJson(
      url,
      { [headerName]: apiKey() },
      { to: `+${toWaDigits(to)}`, type: 'text', text: { previewUrl: true, body } },
    )
    if (!r.ok || r.json?.success === false) {
      return { ok: false, provider: 'telinfy', error: `HTTP ${r.status}: ${r.text.slice(0, 300)}` }
    }
    return { ok: true, provider: 'telinfy', messageId: pickMessageId(r.json) }
  } catch (err) {
    return { ok: false, provider: 'telinfy', error: err instanceof Error ? err.message : 'send failed' }
  }
}

/** Free-text reply. Only deliverable inside the 24h window after the user's last message. */
export async function sendWhatsAppText(to: string, text: string): Promise<SendResult> {
  let last: SendResult = { ok: true, provider: 'console', messageId: '' }
  for (const part of splitForWhatsApp(text)) {
    last = await sendOneText(to, part)
    if (!last.ok) return last
  }
  return last
}

/** Approved template (use for business-initiated messages or outside the 24h window). */
export async function sendWhatsAppTemplate(args: {
  to: string
  name: string
  languageCode?: string
  bodyParams?: string[]
}): Promise<SendResult> {
  if (!telinfyConfigured()) {
    return { ok: false, provider: 'telinfy', error: 'TELINFY_API_KEY not configured' }
  }
  const base = (process.env.TELINFY_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
  const components = args.bodyParams?.length
    ? [{ type: 'body', parameters: args.bodyParams.map((text) => ({ type: 'text', text })) }]
    : undefined
  try {
    const r = await postJson(
      `${base}/whatsapp/messages`,
      { 'x-api-key': apiKey() },
      {
        phoneNumber: toWaDigits(args.to),
        template: {
          name: args.name,
          language: { code: args.languageCode ?? 'en' },
          ...(components ? { components } : {}),
        },
      },
    )
    if (!r.ok || r.json?.success === false) {
      return { ok: false, provider: 'telinfy', error: `HTTP ${r.status}: ${r.text.slice(0, 300)}` }
    }
    return { ok: true, provider: 'telinfy', messageId: pickMessageId(r.json) }
  } catch (err) {
    return { ok: false, provider: 'telinfy', error: err instanceof Error ? err.message : 'send failed' }
  }
}

// ---------------------------------------------------------------------------
// Inbound parsing
// ---------------------------------------------------------------------------

export interface InboundWhatsApp {
  messageId: string
  /** Digits only, e.g. 919876543210 */
  from: string
  name: string | null
  kind: 'text' | 'interactive' | 'location' | 'media' | 'unsupported'
  /** Text we feed to the chatbot ('' for media we can't read). */
  text: string
  /** Original provider type (image, audio, ...) for logging / friendly replies. */
  providerType: string
}

type Obj = Record<string, unknown>
const asObj = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {})
const asStr = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '')

function parseOne(msg: Obj, profileName: string | null): InboundWhatsApp | null {
  const messageId = asStr(msg.id)
  const from = asStr(msg.from).replace(/\D/g, '')
  if (!messageId || !from) return null
  const type = asStr(msg.type) || 'unsupported'
  const base = { messageId, from, name: profileName, providerType: type }

  if (type === 'text') {
    return { ...base, kind: 'text', text: asStr(asObj(msg.text).body).trim() }
  }
  if (type === 'interactive') {
    const inter = asObj(msg.interactive)
    const reply = asObj(inter.button_reply ?? inter.list_reply)
    return { ...base, kind: 'interactive', text: (asStr(reply.title) || asStr(reply.id)).trim() }
  }
  if (type === 'button') {
    const b = asObj(msg.button)
    return { ...base, kind: 'interactive', text: (asStr(b.text) || asStr(b.payload)).trim() }
  }
  if (type === 'location') {
    const loc = asObj(msg.location)
    const bits = [asStr(loc.name), asStr(loc.address)].filter(Boolean).join(', ')
    const coords = `${asStr(loc.latitude)}, ${asStr(loc.longitude)}`
    return { ...base, kind: 'location', text: `My location: ${bits ? `${bits} (${coords})` : coords}` }
  }
  if (['image', 'video', 'audio', 'document', 'sticker'].includes(type)) {
    const caption = asStr(asObj(msg[type]).caption).trim()
    return { ...base, kind: 'media', text: caption }
  }
  return { ...base, kind: 'unsupported', text: '' }
}

/** Extract inbound user messages from a Meta-format webhook body (status/DLR events yield []). */
export function parseTelinfyInbound(body: unknown): InboundWhatsApp[] {
  const out: InboundWhatsApp[] = []
  const entries = asObj(body).entry
  if (!Array.isArray(entries)) return out
  for (const entry of entries) {
    const changes = asObj(entry).changes
    if (!Array.isArray(changes)) continue
    for (const change of changes) {
      const value = asObj(asObj(change).value)
      const messages = value.messages
      if (!Array.isArray(messages)) continue
      const contacts = Array.isArray(value.contacts) ? value.contacts : []
      const names = new Map<string, string>()
      for (const c of contacts) {
        const co = asObj(c)
        const name = asStr(asObj(co.profile).name)
        const id = asStr(co.wa_id).replace(/\D/g, '')
        if (id && name) names.set(id, name)
      }
      for (const m of messages) {
        const mo = asObj(m)
        const from = asStr(mo.from).replace(/\D/g, '')
        const parsed = parseOne(mo, names.get(from) ?? null)
        if (parsed) out.push(parsed)
      }
    }
  }
  return out
}

/** Failed-delivery events from the DLR webhook (useful for spotting 24h-window errors). */
export function parseTelinfyFailures(body: unknown): Array<{ recipient: string; code: number | null; title: string }> {
  const out: Array<{ recipient: string; code: number | null; title: string }> = []
  const entries = asObj(body).entry
  if (!Array.isArray(entries)) return out
  for (const entry of entries) {
    const changes = asObj(entry).changes
    if (!Array.isArray(changes)) continue
    for (const change of changes) {
      const statuses = asObj(asObj(change).value).statuses
      if (!Array.isArray(statuses)) continue
      for (const s of statuses) {
        const so = asObj(s)
        if (asStr(so.status) !== 'failed') continue
        const err = asObj(Array.isArray(so.errors) ? so.errors[0] : null)
        out.push({
          recipient: asStr(so.recipient_id),
          code: typeof err.code === 'number' ? err.code : null,
          title: asStr(err.title),
        })
      }
    }
  }
  return out
}
