/**
 * Read electricity bill fields from a photo (vision) or pasted text.
 * Unclear fields are flagged — never guessed. Labels canonicalized via KB.
 */

import { allKnownLabels, canonicalizeLabel, matchKbRecord } from './kb.js'
import type { BillCharge, BillReading } from './types.js'

const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1'
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? ''
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL ?? 'google/gemini-2.5-flash'
const OPENROUTER_VISION_MODEL = process.env.OPENROUTER_VISION_MODEL ?? OPENROUTER_MODEL

const KNOWN = allKnownLabels().join(', ')

const SYSTEM = `You extract fields from a Telangana (India) TGSPDCL/TGNPDCL electricity bill photo or text.
Return ONLY valid JSON:
{
  "is_electricity_bill": boolean,
  "service_no": string|null,
  "consumer_name": string|null,
  "billing_period": string|null,
  "units": number|null,
  "total_inr": number|null,
  "due_date": string|null,
  "category": string|null,
  "contracted_load_kw": number|null,
  "discom": "TGSPDCL"|"TGNPDCL"|"unknown"|null,
  "charges": [{"label": string, "amount_inr": number|null, "clear": boolean}],
  "unclear_fields": string[],
  "notes": string|null
}
Rules:
- If blurry/rotated/unreadable, put fields in unclear_fields and set values null. NEVER guess.
- Prefer exact printed labels from this list when possible: ${KNOWN}
- Never invent ACD/BCD/RCD — copy the printed letters carefully. Prefer ACD when unsure between lookalikes only if the printed word clearly starts with A.
- ELECTRICITY DUTY and ED INTEREST / EDINT are different lines.
- total_inr = BILL AMOUNT or NET BILL AMOUNT / TOTAL DUE as printed (prefer BILL AMOUNT if both).
- category like "1 Domestic" or "2B". contracted_load_kw from CONTRACTED LOAD.
- amounts are INR without commas.`

function emptyReading(partial?: Partial<BillReading>): BillReading {
  return {
    service_no: null,
    consumer_name: null,
    billing_period: null,
    units: null,
    total_inr: null,
    due_date: null,
    category: null,
    contracted_load_kw: null,
    discom: null,
    charges: [],
    unclear_fields: [],
    not_a_bill: false,
    reconciliation_warning: null,
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
    const labelRaw = asStr(r.label)
    if (!labelRaw) continue
    const label = canonicalizeLabel(labelRaw)
    const rec = matchKbRecord(label)
    out.push({
      label: (rec?.match_labels[0] ?? label).slice(0, 80),
      amount_inr: asNum(r.amount_inr),
      clear: r.clear !== false && asNum(r.amount_inr) != null,
      code: rec?.id,
    })
  }
  return out.slice(0, 24)
}

/** Flag when charge sum is far from bill amount (TC-08). Do not invent corrections. */
export function reconcileReading(reading: BillReading): BillReading {
  const next = { ...reading, charges: [...reading.charges], unclear_fields: [...reading.unclear_fields] }
  const positive = next.charges.filter(
    (c) => c.amount_inr != null && !matchKbRecord(c.label)?.id?.startsWith('kb-totals') && !/subsidy|gruha/i.test(c.label),
  )
  const credits = next.charges.filter((c) => /subsidy|gruha/i.test(c.label) && c.amount_inr != null)
  const sum =
    positive.reduce((s, c) => s + Math.abs(c.amount_inr!), 0) -
    credits.reduce((s, c) => s + Math.abs(c.amount_inr!), 0)
  if (next.total_inr != null && positive.length >= 2) {
    const diff = Math.abs(sum - next.total_inr)
    // Allow LOSS/GAIN / rounding; flag large gaps
    if (diff > Math.max(5, next.total_inr * 0.15)) {
      next.reconciliation_warning = `charge_sum_${Math.round(sum)}_vs_total_${Math.round(next.total_inr)}`
      if (!next.unclear_fields.includes('total')) next.unclear_fields.push('total')
    }
  }
  return next
}

export function parseBillOcrJson(parsed: Record<string, unknown>): BillReading {
  const isBill = parsed.is_electricity_bill !== false
  const unclear = Array.isArray(parsed.unclear_fields)
    ? parsed.unclear_fields
        .filter((x): x is string => typeof x === 'string')
        .map((s) => s.replace(/total_inr/g, 'total').slice(0, 40))
    : []
  const discomRaw = asStr(parsed.discom)
  const discom =
    discomRaw === 'TGSPDCL' || discomRaw === 'TGNPDCL' || discomRaw === 'unknown' ? discomRaw : null

  let reading = emptyReading({
    not_a_bill: !isBill,
    service_no: asStr(parsed.service_no),
    consumer_name: asStr(parsed.consumer_name),
    billing_period: asStr(parsed.billing_period),
    units: asNum(parsed.units),
    total_inr: asNum(parsed.total_inr),
    due_date: asStr(parsed.due_date),
    category: asStr(parsed.category),
    contracted_load_kw: asNum(parsed.contracted_load_kw),
    discom,
    charges: parseCharges(parsed.charges),
    unclear_fields: unclear,
    raw_notes: asStr(parsed.notes),
  })

  for (const key of ['units', 'total'] as const) {
    const field = key === 'total' ? 'total_inr' : key
    if (reading[field] == null && isBill && !reading.unclear_fields.includes(key)) {
      reading.unclear_fields.push(key)
    }
  }
  reading = reconcileReading(reading)
  return reading
}

/**
 * Parse typed corrections / pasted bill lines without vision.
 */
export function parseBillTextFallback(text: string): BillReading | null {
  const t = text.trim()
  if (!t) return null
  const looksBill =
    /bill|units?|kwh|uksc|usc|sc\s*no|total|tgspdcl|tgnpdcl|energy\s*charg|బిల్లు|యూనిట్|बिल|यूनिट/i.test(t) ||
    /\d+\s*(units?|kwh)/i.test(t)
  if (!looksBill && !/\bunits?\s*[:=]?\s*\d+/i.test(t)) return null

  const units =
    asNum(t.match(/\bunits?\s*[:=]?\s*([\d,.]+)/i)?.[1]) ??
    asNum(t.match(/([\d,.]+)\s*(?:units?|kwh)\b/i)?.[1])
  const total =
    asNum(t.match(/\b(?:total|bill\s*amount|net\s*bill|payable)\s*[:=]?\s*(?:rs\.?|₹)?\s*([\d,.]+)/i)?.[1]) ??
    asNum(t.match(/(?:rs\.?|₹)\s*([\d,.]+)\s*(?:total|payable)?/i)?.[1])
  const period =
    asStr(t.match(/\b(?:period|month|billing)\s*[:=]?\s*([A-Za-z]{3,9}\s*\d{2,4}|\d{1,2}[\/\-]\d{4})/i)?.[1]) ??
    asStr(t.match(/\b((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4})\b/i)?.[1])
  const service =
    asStr(t.match(/\b(?:ukscno|uksc|usc\s*no\.?|sc\s*no|service\s*(?:no|number))\s*[:=]?\s*([A-Za-z0-9\-\/]+)/i)?.[1])
  const category = asStr(t.match(/\b(?:cat(?:egory)?)\s*[:=]?\s*([^\n,;]{2,40})/i)?.[1])
  const load = asNum(t.match(/\b(?:contracted\s*load|load)\s*[:=]?\s*([\d,.]+)\s*k?w?/i)?.[1])
  const due = asStr(t.match(/\b(?:due|due\s*date|గడువు)\s*[:=]?\s*([0-9]{1,2}[\/\-][0-9]{1,2}[\/\-][0-9]{2,4}|\d{1,2}\s*\w+)/i)?.[1])

  const charges: BillCharge[] = []
  const chargeRe =
    /(energy\s*charges?|fixed\s*charges?|electricity\s*duty|interest\s*on\s*ed|ed\s*interest|edint|customer\s*charges?|cust\.?\s*charges?|fsa\/?fca(?:\s*charges?)?|surcharge|arrears?(?:\s+after[^:\n]*)?|acd\s*due|acd\s*surcharges?|int\.?\s*on\s*acd|int\.?\s*on\s*sd|gruha\s*jyothi(?:\s*subsidy)?|subsidy|true-?up\s*charges?|addl\.?\s*charges?|loss\/?gain|dps|delayed\s*payment\s*surcharge)\s*[:=]?\s*(-)?\s*(?:rs\.?|₹)?\s*([\d,.]+)/gi
  let m: RegExpExecArray | null
  while ((m = chargeRe.exec(t))) {
    const label = canonicalizeLabel(m[1]!)
    const sign = m[2] === '-' ? -1 : 1
    const amount = asNum(m[3])
    charges.push({
      label: matchKbRecord(label)?.match_labels[0] ?? label,
      amount_inr: amount != null ? amount * sign : null,
      clear: true,
      code: matchKbRecord(label)?.id,
    })
  }

  if (units == null && total == null && !charges.length) return null

  const unclear: string[] = []
  if (units == null) unclear.push('units')
  if (total == null) unclear.push('total')

  return reconcileReading(
    emptyReading({
      service_no: service,
      billing_period: period,
      units,
      total_inr: total,
      due_date: due,
      category,
      contracted_load_kw: load,
      charges,
      unclear_fields: unclear,
      not_a_bill: false,
      raw_notes: 'parsed_from_text',
    }),
  )
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
        max_tokens: 1400,
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
      {
        type: 'text',
        text: 'Extract the electricity bill fields. If the photo looks rotated or blurry, mark unclear fields null — never guess.',
      },
      { type: 'image_url', image_url: { url: dataUrl } },
    ],
    true,
  )
}

export async function readBillFromText(
  text: string,
): Promise<{ ok: true; reading: BillReading } | { ok: false; error: string }> {
  const local = parseBillTextFallback(text)
  if (local && (local.units != null || local.total_inr != null || local.charges.length)) {
    return { ok: true, reading: local }
  }
  return callVisionOrText(`Bill text / typed values:\n\n${text.slice(0, 4000)}`, false)
}

/** Patch one field; keep every other confirmed value (TC-04). */
export function applyBillCorrection(reading: BillReading, field: string, value: string): BillReading {
  const next: BillReading = {
    ...reading,
    charges: reading.charges.map((c) => ({ ...c })),
    unclear_fields: [...reading.unclear_fields],
  }
  const key = field.toLowerCase().replace(/\s+/g, '_')
  const num = asNum(value)
  if (key === 'units' || key === 'unit') {
    next.units = num
    next.unclear_fields = next.unclear_fields.filter((f) => f !== 'units')
  } else if (key === 'total' || key === 'total_inr' || key === 'amount') {
    next.total_inr = num
    next.unclear_fields = next.unclear_fields.filter((f) => f !== 'total' && f !== 'total_inr')
  } else if (key === 'period' || key === 'billing_period' || key === 'month') {
    next.billing_period = value.trim().slice(0, 40) || null
    next.unclear_fields = next.unclear_fields.filter((f) => f !== 'billing_period' && f !== 'period')
  } else if (key === 'service' || key === 'service_no' || key === 'ukscno' || key === 'usc') {
    next.service_no = value.trim().slice(0, 40) || null
  } else if (key === 'due' || key === 'due_date') {
    next.due_date = value.trim().slice(0, 40) || null
  } else {
    const parts = value.split(/[=:]/)
    if (parts.length >= 2) {
      const label = canonicalizeLabel(parts[0]!.trim())
      const amount = asNum(parts.slice(1).join(':'))
      const idx = next.charges.findIndex((c) => canonicalizeLabel(c.label) === label)
      if (idx >= 0) next.charges[idx] = { ...next.charges[idx]!, amount_inr: amount, clear: amount != null }
      else next.charges.push({ label: matchKbRecord(label)?.match_labels[0] ?? label, amount_inr: amount, clear: amount != null })
    }
  }
  next.reconciliation_warning = null
  return reconcileReading(next)
}
