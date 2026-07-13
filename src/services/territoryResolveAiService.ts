/**
 * AI-assisted territory resolution — pick only from server-provided candidates.
 */

import { tenantGeography } from '@/config/tenant.config.js'
import type { TerritoryCandidate } from '@/services/territoryCandidateService.js'

const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1'
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? ''
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL ?? 'google/gemini-2.5-flash'

export const TERRITORY_AUTO_APPLY_CONFIDENCE = 0.55
export const TERRITORY_AI_MIN_CONFIDENCE = 0.62

export interface TerritoryAiPickResult {
  territory_id: string | null
  confidence: number
  reason: string | null
}

function buildSystemPrompt(): string {
  return `You resolve a citizen grievance location to ONE territory node in ${tenantGeography.rootName}, India.

You MUST choose territory_id ONLY from the provided candidates list, or return null if unsure.
Never invent UUIDs or place names not in the list.

Consider:
- The citizen reporting the issue (not the staff/worker asking questions)
- Colloquial names and typos (Hyderabad, Hydreabad, GHMC, NCC Urban, Financial District)
- Homonyms: "Narsingi" near Hyderabad city is NOT the same as Narsingi in Medak district
- Prefer the most specific node (ward/mandal/constituency) only when clearly supported by the text
- Prefer district-level (Hyderabad / Ranga Reddy) over wrong mandal when ambiguous
- If GPS coordinates are provided, use them as a strong hint

Return strict JSON:
{
  "territory_id": "uuid-from-list-or-null",
  "confidence": 0.0-1.0,
  "reason": "one short sentence or null"
}`
}

export async function pickTerritoryWithAi(args: {
  locationText: string
  issueText: string
  latitude?: number | null
  longitude?: number | null
  candidates: TerritoryCandidate[]
  metroContext: boolean
}): Promise<TerritoryAiPickResult | null> {
  if (!OPENROUTER_API_KEY || args.candidates.length === 0) return null

  const allowedIds = new Set(args.candidates.map((c) => c.territory_id))
  const candidateLines = args.candidates.map(
    (c) =>
      `- ${c.territory_id} | ${c.name} (L${c.level_order}) | district: ${c.district_name ?? 'n/a'} | rule_score: ${Math.round(c.score)} | ${c.match_reason}`,
  )

  const userContent = [
    'Location text:',
    args.locationText || '(none)',
    '',
    'Issue / chat text:',
    args.issueText || '(none)',
    '',
    args.latitude != null && args.longitude != null
      ? `GPS: ${args.latitude}, ${args.longitude}`
      : 'GPS: (none)',
    '',
    `Greater Hyderabad metro context detected: ${args.metroContext}`,
    '',
    'Candidates (pick territory_id from this list ONLY):',
    ...candidateLines,
  ].join('\n')

  try {
    const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://vocal-app.vercel.app',
        'X-Title': 'Vocal Territory Resolve',
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        messages: [
          { role: 'system', content: buildSystemPrompt() },
          { role: 'user', content: userContent },
        ],
        temperature: 0.05,
        max_tokens: 256,
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(25_000),
    })

    if (!response.ok) return null

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const content = data.choices?.[0]?.message?.content
    if (!content) return null

    const parsed = JSON.parse(content) as Record<string, unknown>
    const territoryId =
      typeof parsed.territory_id === 'string' && parsed.territory_id.trim()
        ? parsed.territory_id.trim()
        : null
    const confidenceRaw = typeof parsed.confidence === 'number' ? parsed.confidence : Number(parsed.confidence)
    const confidence = Number.isFinite(confidenceRaw)
      ? Math.max(0, Math.min(1, confidenceRaw))
      : 0
    const reason =
      typeof parsed.reason === 'string' && parsed.reason.trim() ? parsed.reason.trim() : null

    if (!territoryId || !allowedIds.has(territoryId)) {
      return { territory_id: null, confidence: 0, reason: reason ?? 'AI returned out-of-list territory' }
    }

    return { territory_id: territoryId, confidence, reason }
  } catch (err) {
    console.error('[territoryResolveAi]', err instanceof Error ? err.message : err)
    return null
  }
}
