/**
 * Read electricity bill fields from a photo (vision) or pasted text.
 * Unclear fields are flagged — never guessed.
 */

import type { BillCharge, BillReading } from './types.js'

const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1'
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? ''
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL ?? 'google/gemini-2.5-flash'
const OPENROUTER_VISION_MODEL = process.env.OPENROUTER_VISION_MODEL ?? OPENROUTER_MODEL

const SYSTEM = `You extract fields from a Telangana (India) electricity bill photo or text.
Return ONLY valid JSON with this shape:
{
  "is_electricity_bill": boolean,
  "service_no": string|null,
  "consumer_name": string|null,
  "billing_period": string|null,
  "units": number|null,
  "total_inr": number|null,
  "due_date": string|null,
  "discom": "TGSPDCL"|"TGNPDCL"|"unknown"|null,
  "charges": [{"label": string, "amount_inr": number|null, "clear": boolean}],
  "unclear_fields": string[],
  "notes": string|null
}
Rules:
- If the image is blurry or a number is unreadable, put that field in unclear_fields and set the value null. NEVER guess.
- If the document is not an electricity bill, set is_electricity_bill false and leave amounts null.
- Prefer printed labels (UKSCNO / SC No, units/kWh, energy charges, fixed charges, electricity duty, total).
- amounts are Indian rupees numbers without commas.`

function emptyReading(partial?: Partial<BillReading>): BillReading {
  return {
    service_no: null,
    consumer_name: null,
    billing_period: null,
    units: null,
    total_inr: null,
    due_date: null,
    discom: null,
    charges: [],
    unclear_fields: [],
    not_a_bill: false,
    raw_notes: null,
    ...partial,
  }
}

function asNum(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const n = Number(v.replace(/,/g, '').replace(/[^\d.-]/g, ''))
    return Number.isFinite(n) ? n : null
  }
  return null
}

function asStr(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t ? t.slice(0, 120) : null
}

function parseCharges(raw: unknown): BillCharge[] {
  if (!Array.isArray(raw)) return []
  const out: BillCharge[] = []
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    const label = asStr(r.label)
    if (!label) continue
    out.push({
      label: label.slice(0, 80),
      amount_inr: asNum(r.amount_inr),
      clear: r.clear !== false && asNum(r.amount_inr) != null,
    })
  }
  return out.slice(0, 20)
}

export function parseBillOcrJson(parsed: Record<string, unknown>): BillReading {
  const isBill = parsed.is_electricity_bill !== false
  const unclear = Array.isArray(parsed.unclear_fields)
    ? parsed.unclear_fields.filter((x): x is string => typeof x === 'string').map((s) => s.slice(0, 40))
    : []
  const discomRaw = asStr(parsed.discom)
  const discom =
    discomRaw === 'TGSPDCL' || discomRaw === 'TGNPDCL' || discomRaw === 'unknown' ? discomRaw : null

  const reading = emptyReading({
    not_a_bill: !isBill,
    service_no: asStr(parsed.service_no),
    consumer_name: asStr(parsed.consumer_name),
    billing_period: asStr(parsed.billing_period),
    units: asNum(parsed.units),
    total_inr: asNum(parsed.total_inr),
    due_date: asStr(parsed.due_date),
    discom,
    charges: parseCharges(parsed.charges),
    unclear_fields: unclear,
    raw_notes: asStr(parsed.notes),
  })

  // Flag important blanks as unclear when missing
  for (const key of ['units', 'total_inr'] as const) {
    if (reading[key] == null && isBill && !reading.unclear_fields.includes(key)) {
      reading.unclear_fields.push(key)
    }
  }
  return reading
}

/**
 * Parse typed corrections / pasted bill lines without vision.
 * Examples: "units 182", "total 1450", "period Sep 2026", "Energy charges: 980"
 */
export function parseBillTextFallback(text: string): BillReading | null {
  const t = text.trim()
  if (!t) return null
  const looksBill =
    /bill|units?|kwh|uksc|sc\s*no|total|tgspdcl|tgnpdcl|బిల్లు|యూనిట్|बिल|यूनिट/i.test(t) ||
    /\d+\s*(units?|kwh)/i.test(t)
  if (!looksBill && !/\bunits?\s*[:=]?\s*\d+/i.test(t)) return null

  const units =
    asNum(t.match(/\bunits?\s*[:=]?\s*([\d,.]+)/i)?.[1]) ??
    asNum(t.match(/([\d,.]+)\s*(?:units?|kwh)\b/i)?.[1])
  const total =
    asNum(t.match(/\b(?:total|amount|payable)\s*[:=]?\s*(?:rs\.?|₹)?\s*([\d,.]+)/i)?.[1]) ??
    asNum(t.match(/(?:rs\.?|₹)\s*([\d,.]+)\s*(?:total|payable)?/i)?.[1])
  const period =
    asStr(t.match(/\b(?:period|month|billing)\s*[:=]?\s*([A-Za-z]{3,9}\s*\d{2,4}|\d{1,2}[\/\-]\d{4})/i)?.[1]) ??
    asStr(t.match(/\b((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4})\b/i)?.[1])
  const service =
    asStr(t.match(/\b(?:ukscno|uksc|sc\s*no|service\s*(?:no|number))\s*[:=]?\s*([A-Za-z0-9\-\/]+)/i)?.[1])

  const charges: BillCharge[] = []
  const chargeRe =
    /(energy\s*charges?|fixed\s*charges?|electricity\s*duty|fuel\s*surcharge|customer\s*charges?|arrears?|subsidy)\s*[:=]?\s*(?:rs\.?|₹)?\s*([\d,.]+)/gi
  let m: RegExpExecArray | null
  while ((m = chargeRe.exec(t))) {
    charges.push({ label: m[1]!, amount_inr: asNum(m[2]), clear: true })
  }

  if (units == null && total == null && !charges.length) return null

  const unclear: string[] = []
  if (units == null) unclear.push('units')
  if (total == null) unclear.push('total_inr')

  return emptyReading({
    service_no: service,
    billing_period: period,
    units,
    total_inr: total,
    charges,
    unclear_fields: unclear,
    not_a_bill: false,
    raw_notes: 'parsed_from_text',
  })
}

async function callVisionOrText(
  userContent:
    | string
    | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>,
  useVision: boolean,
): Promise<{ ok: true; reading: BillReading } | { ok: false; error: string }> {
  if (!OPENROUTER_API_KEY) {
    return { ok: false, error: 'Bill reading is not configured (OPENROUTER_API_KEY missing)' }
  }
  const model = useVision ? OPENROUTER_VISION_MODEL : OPENROUTER_MODEL
  try {
    const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://bharosa.local',
        'X-Title': 'Bharosa Electricity Bill OCR',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: userContent },
        ],
        temperature: 0,
        max_tokens: 1200,
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(useVision ? 45_000 : 25_000),
    })
    if (!response.ok) {
      const errText = await response.text()
      return { ok: false, error: `Bill OCR failed (${response.status}): ${errText.slice(0, 200)}` }
    }
    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> }
    const content = data.choices?.[0]?.message?.content
    if (!content) return { ok: false, error: 'Bill OCR returned empty response' }
    const parsed = JSON.parse(content) as Record<string, unknown>
    return { ok: true, reading: parseBillOcrJson(parsed) }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Bill OCR failed' }
  }
}

export async function readBillFromImage(args: {
  buffer: Buffer
  mimetype: string
}): Promise<{ ok: true; reading: BillReading } | { ok: false; error: string }> {
  const mime = args.mimetype.toLowerCase().split(';')[0]?.trim() || 'image/jpeg'
  const safe = mime === 'image/jpg' ? 'image/jpeg' : mime
  if (!safe.startsWith('image/')) {
    return { ok: false, error: 'Please send a photo of the bill (image file).' }
  }
  const dataUrl = `data:${safe};base64,${args.buffer.toString('base64')}`
  return callVisionOrText(
    [
      { type: 'text', text: 'Extract the electricity bill fields from this photo. Do not guess unclear numbers.' },
      { type: 'image_url', image_url: { url: dataUrl } },
    ],
    true,
  )
}

export async function readBillFromText(
  text: string,
): Promise<{ ok: true; reading: BillReading } | { ok: false; error: string }> {
  const local = parseBillTextFallback(text)
  if (local && (local.units != null || local.total_inr != null)) {
    return { ok: true, reading: local }
  }
  return callVisionOrText(`Bill text / typed values:\n\n${text.slice(0, 4000)}`, false)
}

export function applyBillCorrection(
  reading: BillReading,
  field: string,
  value: string,
): BillReading {
  const next = { ...reading, charges: [...reading.charges], unclear_fields: [...reading.unclear_fields] }
  const key = field.toLowerCase().replace(/\s+/g, '_')
  const num = asNum(value)
  if (key === 'units' || key === 'unit') {
    next.units = num
    next.unclear_fields = next.unclear_fields.filter((f) => f !== 'units')
  } else if (key === 'total' || key === 'total_inr' || key === 'amount') {
    next.total_inr = num
    next.unclear_fields = next.unclear_fields.filter((f) => f !== 'total_inr')
  } else if (key === 'period' || key === 'billing_period' || key === 'month') {
    next.billing_period = value.trim().slice(0, 40) || null
    next.unclear_fields = next.unclear_fields.filter((f) => f !== 'billing_period')
  } else if (key === 'service' || key === 'service_no' || key === 'ukscno') {
    next.service_no = value.trim().slice(0, 40) || null
  } else {
    // Treat as a charge label correction: "Energy charges=980"
    const parts = value.split(/[=:]/)
    if (parts.length >= 2) {
      const label = parts[0]!.trim()
      const amount = asNum(parts.slice(1).join(':'))
      const idx = next.charges.findIndex((c) => c.label.toLowerCase() === label.toLowerCase())
      if (idx >= 0) next.charges[idx] = { ...next.charges[idx]!, amount_inr: amount, clear: amount != null }
      else next.charges.push({ label, amount_inr: amount, clear: amount != null })
    }
  }
  return next
}
