/**
 * Chat intake extract — pre-fill ticket fields from pasted text or chat screenshots.
 *
 * Does NOT create a ticket — caller reviews and submits via worker-intake.
 */

import { tenantGeography } from '@/config/tenant.config.js'
import { canCreateWorkerIntakeTicket } from '@/lib/roleHierarchy.js'
import { normalizePhone } from '@/services/otpService.js'
import { resolveTicketTerritory } from '@/services/territoryResolveService.js'
import type { TerritoryCandidate } from '@/services/territoryCandidateService.js'

const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1'
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? ''
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL ?? 'google/gemini-2.5-flash'
const OPENROUTER_VISION_MODEL = process.env.OPENROUTER_VISION_MODEL ?? OPENROUTER_MODEL

const MAX_CHAT_TEXT_LENGTH = 16_000
const MAX_SCREENSHOT_COUNT = 3
const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024

const ALLOWED_IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'])

export type ChatExtractSource = 'text' | 'image'

export interface WorkerIntakeExtractFields {
  citizen_name: string | null
  citizen_phone: string | null
  address: string | null
  description: string | null
  latitude: number | null
  longitude: number | null
  /** Always false for chat/worker intake — citizen is identified by name/phone. */
  anonymous: boolean
}

export interface WorkerIntakeExtractConfidence {
  citizen_name: number
  citizen_phone: number
  address: number
  description: number
  latitude: number
  longitude: number
}

export interface WorkerIntakeTerritorySuggestion {
  suggested_territory_id: string | null
  suggested_territory_name: string | null
  district_name: string | null
  confidence: number
  match_quality: string
  should_auto_apply: boolean
  resolution_notes: string | null
  candidates: Array<{
    territory_id: string
    name: string
    level_order: number
    district_name: string | null
    confidence: number
    match_reason: string
  }>
}

export interface WorkerIntakeExtractResult {
  fields: WorkerIntakeExtractFields
  confidence: WorkerIntakeExtractConfidence
  missing_fields: Array<'citizen_name' | 'citizen_phone' | 'address' | 'description'>
  extraction_notes: string | null
  ai_used: boolean
  /** How the chat was provided to the extractor. */
  source: ChatExtractSource
  /** Number of screenshots processed (1+ when source is image). */
  screenshot_count?: number
  territory: WorkerIntakeTerritorySuggestion
}

export interface ChatScreenshotInput {
  buffer: Buffer
  mimetype: string
  originalname?: string
}

type VocalUser = {
  organization_id?: string
  roles?: { name: string } | null
}

type WorkerIntakeExtractAiPayload = Omit<WorkerIntakeExtractResult, 'territory'>

type OpenRouterMessage =
  | { role: 'system' | 'user'; content: string }
  | {
      role: 'user'
      content: Array<
        | { type: 'text'; text: string }
        | { type: 'image_url'; image_url: { url: string } }
      >
    }

function emptyConfidence(): WorkerIntakeExtractConfidence {
  return {
    citizen_name: 0,
    citizen_phone: 0,
    address: 0,
    description: 0,
    latitude: 0,
    longitude: 0,
  }
}

function emptyFields(): WorkerIntakeExtractFields {
  return {
    citizen_name: null,
    citizen_phone: null,
    address: null,
    description: null,
    latitude: null,
    longitude: null,
    anonymous: false,
  }
}

function clampConfidence(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(1, n))
}

function parseCoord(value: unknown): number | null {
  if (value == null || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return null
  return n
}

function normalizeExtractedPhone(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null
  return normalizePhone(raw.trim())
}

function mapTerritoryCandidates(candidates: TerritoryCandidate[]) {
  return candidates.map((c) => ({
    territory_id: c.territory_id,
    name: c.name,
    level_order: c.level_order,
    district_name: c.district_name,
    confidence: c.confidence,
    match_reason: c.match_reason,
  }))
}

function emptyTerritorySuggestion(): WorkerIntakeTerritorySuggestion {
  return {
    suggested_territory_id: null,
    suggested_territory_name: null,
    district_name: null,
    confidence: 0,
    match_quality: 'none',
    should_auto_apply: false,
    resolution_notes: null,
    candidates: [],
  }
}

async function suggestTerritoryFromExtract(
  organizationId: string | undefined,
  fields: WorkerIntakeExtractFields,
): Promise<WorkerIntakeTerritorySuggestion> {
  if (!organizationId) return emptyTerritorySuggestion()

  const match = await resolveTicketTerritory({
    organizationId,
    locationText: fields.address,
    issueText: fields.description,
    latitude: fields.latitude,
    longitude: fields.longitude,
    applyConfidenceGate: false,
  })

  const topCandidate = match.candidates[0]
  const suggestedId = match.territoryId ?? topCandidate?.territory_id ?? null
  const suggestedName = match.territoryName ?? topCandidate?.name ?? null

  return {
    suggested_territory_id: suggestedId,
    suggested_territory_name: suggestedName,
    district_name: match.districtName ?? topCandidate?.district_name ?? null,
    confidence: match.confidence,
    match_quality: match.matchQuality,
    should_auto_apply: match.shouldAutoApply,
    resolution_notes: match.resolutionNotes,
    candidates: mapTerritoryCandidates(match.candidates),
  }
}

function computeMissingFields(
  fields: WorkerIntakeExtractFields,
  confidence: WorkerIntakeExtractConfidence,
): WorkerIntakeExtractResult['missing_fields'] {
  const missing: WorkerIntakeExtractResult['missing_fields'] = []
  const threshold = 0.35

  if (!fields.citizen_name?.trim() || confidence.citizen_name < threshold) {
    missing.push('citizen_name')
  }
  if (!fields.citizen_phone?.trim() || confidence.citizen_phone < threshold) {
    missing.push('citizen_phone')
  }
  if (!fields.address?.trim() || confidence.address < threshold) {
    missing.push('address')
  }
  if (!fields.description?.trim() || confidence.description < threshold) {
    missing.push('description')
  }

  return missing
}

function buildSystemPrompt(source: ChatExtractSource): string {
  const inputHint =
    source === 'image'
      ? `The input is one or more screenshots of a mobile chat app (WhatsApp, Telegram, SMS, etc.) between a field worker and a citizen in ${tenantGeography.rootName}, India. Read all visible text carefully — bubble sides, sender names, timestamps, and shared location pins.`
      : `The input may be WhatsApp-style (timestamps, sender names), plain SMS, or unstructured notes between a field worker and a citizen in ${tenantGeography.rootName}, India.`

  return `You extract structured ticket intake fields from a chat conversation.

${inputHint}
Messages may be in English, Hindi, Telugu, or mixed (Hinglish/Tinglish).

Return strict JSON only. Schema:
{
  "citizen_name": "full name of the citizen reporting the issue, or null",
  "citizen_phone": "phone number as written in chat (10-digit Indian or with +91), or null",
  "address": "location/address/landmark/ward/village mentioned by the citizen, or null",
  "description": "clear summary of the civic problem or complaint (2-5 sentences, preserve key facts)",
  "latitude": number | null,
  "longitude": number | null,
  "confidence": {
    "citizen_name": 0.0-1.0,
    "citizen_phone": 0.0-1.0,
    "address": 0.0-1.0,
    "description": 0.0-1.0,
    "latitude": 0.0-1.0,
    "longitude": 0.0-1.0
  },
  "extraction_notes": "brief note for the reviewer about ambiguity, blurry text, multiple people, or assumptions — or null"
}

Rules:
- citizen_name: the person who has the problem, NOT the worker/staff member.
- citizen_phone: prefer the citizen's number; ignore the worker's number if both appear.
- address: combine village, mandal, ward, landmark, pin code if mentioned.
- description: focus on the civic issue (water, road, electricity, harassment, etc.), not greetings or small talk.
- latitude/longitude: only if explicitly shared (e.g. Google Maps link or location pin); otherwise null with confidence 0.
- Use lower confidence when text is unreadable, cropped, or when guessing.
- Do not invent facts not supported by the chat.`
}

function parseExtractionResponse(
  parsed: Record<string, unknown>,
  source: ChatExtractSource,
  screenshotCount?: number,
): WorkerIntakeExtractAiPayload {
  const confidenceRaw = (parsed.confidence ?? {}) as Record<string, unknown>

  const fields: WorkerIntakeExtractFields = {
    citizen_name:
      typeof parsed.citizen_name === 'string' && parsed.citizen_name.trim()
        ? parsed.citizen_name.trim().slice(0, 200)
        : null,
    citizen_phone: normalizeExtractedPhone(
      typeof parsed.citizen_phone === 'string' ? parsed.citizen_phone : null,
    ),
    address:
      typeof parsed.address === 'string' && parsed.address.trim()
        ? parsed.address.trim().slice(0, 500)
        : null,
    description:
      typeof parsed.description === 'string' && parsed.description.trim()
        ? parsed.description.trim().slice(0, 4000)
        : null,
    latitude: parseCoord(parsed.latitude),
    longitude: parseCoord(parsed.longitude),
    anonymous: false,
  }

  const confidence: WorkerIntakeExtractConfidence = {
    citizen_name: clampConfidence(confidenceRaw.citizen_name),
    citizen_phone: clampConfidence(confidenceRaw.citizen_phone),
    address: clampConfidence(confidenceRaw.address),
    description: clampConfidence(confidenceRaw.description),
    latitude: clampConfidence(confidenceRaw.latitude),
    longitude: clampConfidence(confidenceRaw.longitude),
  }

  if (fields.latitude != null && (fields.latitude < -90 || fields.latitude > 90)) {
    fields.latitude = null
    confidence.latitude = 0
  }
  if (fields.longitude != null && (fields.longitude < -180 || fields.longitude > 180)) {
    fields.longitude = null
    confidence.longitude = 0
  }

  const hasLat = fields.latitude != null
  const hasLng = fields.longitude != null
  if (hasLat !== hasLng) {
    fields.latitude = null
    fields.longitude = null
    confidence.latitude = 0
    confidence.longitude = 0
  }

  return {
    fields,
    confidence,
    missing_fields: computeMissingFields(fields, confidence),
    extraction_notes:
      typeof parsed.extraction_notes === 'string' && parsed.extraction_notes.trim()
        ? parsed.extraction_notes.trim().slice(0, 500)
        : null,
    ai_used: true,
    source,
    ...(screenshotCount != null ? { screenshot_count: screenshotCount } : {}),
  }
}

async function callOpenRouterExtraction(
  messages: OpenRouterMessage[],
  source: ChatExtractSource,
  screenshotCount?: number,
): Promise<{ ok: true; result: WorkerIntakeExtractAiPayload } | { ok: false; error: string }> {
  if (!OPENROUTER_API_KEY) {
    return { ok: false, error: 'AI extraction is not configured (OPENROUTER_API_KEY missing)' }
  }

  const model = source === 'image' ? OPENROUTER_VISION_MODEL : OPENROUTER_MODEL
  const timeoutMs = source === 'image' ? 45_000 : 30_000

  try {
    const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://vocal-app.vercel.app',
        'X-Title': 'Vocal Chat Intake Extract',
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.1,
        max_tokens: 1024,
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })

    if (!response.ok) {
      const errText = await response.text()
      return { ok: false, error: `AI extraction failed (${response.status}): ${errText.slice(0, 200)}` }
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const content = data.choices?.[0]?.message?.content
    if (!content) {
      return { ok: false, error: 'AI returned an empty response' }
    }

    const parsed = JSON.parse(content) as Record<string, unknown>
    return { ok: true, result: parseExtractionResponse(parsed, source, screenshotCount) }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: `AI extraction failed: ${msg}` }
  }
}

async function extractWithAiFromText(
  chatText: string,
): Promise<{ ok: true; result: WorkerIntakeExtractAiPayload } | { ok: false; error: string }> {
  return callOpenRouterExtraction(
    [
      { role: 'system', content: buildSystemPrompt('text') },
      { role: 'user', content: `Pasted chat:\n\n${chatText}` },
    ],
    'text',
  )
}

function normalizeImageMime(mimetype: string): string {
  const mime = mimetype.toLowerCase().split(';')[0]?.trim() || 'image/jpeg'
  if (mime === 'image/jpg') return 'image/jpeg'
  return ALLOWED_IMAGE_MIMES.has(mime) ? mime : 'image/jpeg'
}

function toDataUrl(buffer: Buffer, mimetype: string): string {
  const mime = normalizeImageMime(mimetype)
  return `data:${mime};base64,${buffer.toString('base64')}`
}

async function extractWithAiFromScreenshots(
  screenshots: ChatScreenshotInput[],
): Promise<{ ok: true; result: WorkerIntakeExtractAiPayload } | { ok: false; error: string }> {
  const content: Array<
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string } }
  > = [
    {
      type: 'text',
      text:
        screenshots.length === 1
          ? 'Extract ticket intake fields from this chat screenshot.'
          : `Extract ticket intake fields from these ${screenshots.length} chat screenshots (same conversation, scroll capture). Merge information across all images.`,
    },
  ]

  for (const shot of screenshots) {
    content.push({
      type: 'image_url',
      image_url: { url: toDataUrl(shot.buffer, shot.mimetype) },
    })
  }

  return callOpenRouterExtraction(
    [{ role: 'system', content: buildSystemPrompt('image') }, { role: 'user', content }],
    'image',
    screenshots.length,
  )
}

function assertChatExtractAccess(
  user: VocalUser,
): { ok: true } | { ok: false; status: number; error: string } {
  const roleName = user.roles?.name
  if (!canCreateWorkerIntakeTicket(roleName)) {
    return { ok: false, status: 403, error: 'Your role cannot use chat intake extraction' }
  }
  return { ok: true }
}

export function validateChatScreenshots(
  screenshots: ChatScreenshotInput[],
): { ok: true } | { ok: false; status: number; error: string } {
  if (!screenshots.length) {
    return { ok: false, status: 400, error: 'At least one screenshot image is required' }
  }
  if (screenshots.length > MAX_SCREENSHOT_COUNT) {
    return {
      ok: false,
      status: 400,
      error: `At most ${MAX_SCREENSHOT_COUNT} screenshots allowed per request`,
    }
  }

  for (const shot of screenshots) {
    if (!shot.buffer?.length) {
      return { ok: false, status: 400, error: 'Screenshot file is empty' }
    }
    if (shot.buffer.length > MAX_SCREENSHOT_BYTES) {
      return {
        ok: false,
        status: 400,
        error: `Each screenshot must be at most ${MAX_SCREENSHOT_BYTES / (1024 * 1024)}MB`,
      }
    }
    const mime = normalizeImageMime(shot.mimetype)
    if (!ALLOWED_IMAGE_MIMES.has(mime)) {
      return {
        ok: false,
        status: 400,
        error: 'Screenshots must be JPEG, PNG, or WebP images',
      }
    }
  }

  return { ok: true }
}

async function attachTerritorySuggestion(
  user: VocalUser,
  aiResult: WorkerIntakeExtractAiPayload,
): Promise<WorkerIntakeExtractResult> {
  const territory = await suggestTerritoryFromExtract(user.organization_id, aiResult.fields)
  return { ...aiResult, territory }
}

export async function extractWorkerIntakeFromChat(
  user: VocalUser,
  chatText: string,
): Promise<
  | { ok: true; result: WorkerIntakeExtractResult }
  | { ok: false; status: number; error: string }
> {
  const access = assertChatExtractAccess(user)
  if (!access.ok) return access

  const trimmed = (chatText ?? '').trim()
  if (!trimmed) {
    return { ok: false, status: 400, error: 'chat_text is required' }
  }
  if (trimmed.length > MAX_CHAT_TEXT_LENGTH) {
    return {
      ok: false,
      status: 400,
      error: `chat_text must be at most ${MAX_CHAT_TEXT_LENGTH} characters`,
    }
  }

  const aiResult = await extractWithAiFromText(trimmed)
  if (!aiResult.ok) {
    return { ok: false, status: 503, error: aiResult.error }
  }

  return { ok: true, result: await attachTerritorySuggestion(user, aiResult.result) }
}

export async function extractWorkerIntakeFromChatScreenshots(
  user: VocalUser,
  screenshots: ChatScreenshotInput[],
): Promise<
  | { ok: true; result: WorkerIntakeExtractResult }
  | { ok: false; status: number; error: string }
> {
  const access = assertChatExtractAccess(user)
  if (!access.ok) return access

  const validation = validateChatScreenshots(screenshots)
  if (!validation.ok) return validation

  const aiResult = await extractWithAiFromScreenshots(screenshots)
  if (!aiResult.ok) {
    return { ok: false, status: 503, error: aiResult.error }
  }

  return { ok: true, result: await attachTerritorySuggestion(user, aiResult.result) }
}

/** For tests / fallbacks when AI is unavailable. */
export function emptyWorkerIntakeExtractResult(
  source: ChatExtractSource = 'text',
): WorkerIntakeExtractResult {
  return {
    fields: emptyFields(),
    confidence: emptyConfidence(),
    missing_fields: ['citizen_name', 'citizen_phone', 'address', 'description'],
    extraction_notes: null,
    ai_used: false,
    source,
    territory: emptyTerritorySuggestion(),
  }
}
