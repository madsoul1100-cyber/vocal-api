/**
 * Chat-paste intake — extract ticket fields from a copied conversation.
 *
 * A field worker pastes a WhatsApp/SMS/call transcript; the LLM pulls out
 * citizen name, phone, address, and problem description for form pre-fill.
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

const MAX_CHAT_TEXT_LENGTH = 16_000

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
  /** Required worker-intake fields that could not be extracted with reasonable confidence. */
  missing_fields: Array<'citizen_name' | 'citizen_phone' | 'address' | 'description'>
  /** Short note for the reviewer (e.g. ambiguous phone, multiple names). */
  extraction_notes: string | null
  ai_used: boolean
  territory: WorkerIntakeTerritorySuggestion
}

type VocalUser = {
  organization_id?: string
  roles?: { name: string } | null
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

function buildSystemPrompt(): string {
  return `You extract structured ticket intake fields from a pasted chat conversation between a field worker and a citizen in ${tenantGeography.rootName}, India.

The input may be WhatsApp-style (timestamps, sender names), plain SMS, or unstructured notes. Messages may be in English, Hindi, Telugu, or mixed (Hinglish/Tinglish).

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
  "extraction_notes": "brief note for the reviewer about ambiguity, multiple people, or assumptions — or null"
}

Rules:
- citizen_name: the person who has the problem, NOT the worker/staff member.
- citizen_phone: prefer the citizen's number; ignore the worker's number if both appear.
- address: combine village, mandal, ward, landmark, pin code if mentioned.
- description: focus on the civic issue (water, road, electricity, harassment, etc.), not greetings or small talk.
- latitude/longitude: only if explicitly shared (e.g. Google Maps link coordinates); otherwise null with confidence 0.
- Use lower confidence when guessing or when multiple candidates exist.
- Do not invent facts not supported by the chat.`
}

type WorkerIntakeExtractAiPayload = Omit<WorkerIntakeExtractResult, 'territory'>

async function extractWithAi(chatText: string): Promise<
  | { ok: true; result: WorkerIntakeExtractAiPayload }
  | { ok: false; error: string }
> {
  if (!OPENROUTER_API_KEY) {
    return { ok: false, error: 'AI extraction is not configured (OPENROUTER_API_KEY missing)' }
  }

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
        model: OPENROUTER_MODEL,
        messages: [
          { role: 'system', content: buildSystemPrompt() },
          { role: 'user', content: `Pasted chat:\n\n${chatText}` },
        ],
        temperature: 0.1,
        max_tokens: 1024,
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(30_000),
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
      ok: true,
      result: {
        fields,
        confidence,
        missing_fields: computeMissingFields(fields, confidence),
        extraction_notes:
          typeof parsed.extraction_notes === 'string' && parsed.extraction_notes.trim()
            ? parsed.extraction_notes.trim().slice(0, 500)
            : null,
        ai_used: true,
      },
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: `AI extraction failed: ${msg}` }
  }
}

export async function extractWorkerIntakeFromChat(
  user: VocalUser,
  chatText: string,
): Promise<
  | { ok: true; result: WorkerIntakeExtractResult }
  | { ok: false; status: number; error: string }
> {
  const roleName = user.roles?.name
  if (!canCreateWorkerIntakeTicket(roleName)) {
    return { ok: false, status: 403, error: 'Your role cannot use chat intake extraction' }
  }

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

  const aiResult = await extractWithAi(trimmed)
  if (!aiResult.ok) {
    return { ok: false, status: 503, error: aiResult.error }
  }

  const territory = await suggestTerritoryFromExtract(user.organization_id, aiResult.result.fields)

  return {
    ok: true,
    result: {
      ...aiResult.result,
      territory,
    },
  }
}

/** For tests / fallbacks when AI is unavailable. */
export function emptyWorkerIntakeExtractResult(): WorkerIntakeExtractResult {
  return {
    fields: emptyFields(),
    confidence: emptyConfidence(),
    missing_fields: ['citizen_name', 'citizen_phone', 'address', 'description'],
    extraction_notes: null,
    ai_used: false,
    territory: emptyTerritorySuggestion(),
  }
}
