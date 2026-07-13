/**
 * Resolve a citizen's free-text location or GPS coordinates to a territory node for ticket routing.
 *
 * Pipeline: rule candidates → optional AI pick (constrained list) → coord fallback.
 * Wrong map is worse than null — low confidence or district conflict → no territory_id.
 */

import { createSupabaseServiceClient } from '@/lib/supabase.js'
import { isLikelyCoordinateOnlyText, isValidLatitude, isValidLongitude } from '@/lib/geo.js'
import { loadOrgTerritoryRowsCached } from '@/services/territoryService.js'
import {
  buildTerritoryCandidates,
  getDistrictAncestor,
  hasTerritoryCandidateConflict,
  pickBestRuleCandidate,
  type TerritoryCandidate,
} from '@/services/territoryCandidateService.js'
import {
  pickTerritoryWithAi,
  TERRITORY_AI_MIN_CONFIDENCE,
  TERRITORY_AUTO_APPLY_CONFIDENCE,
} from '@/services/territoryResolveAiService.js'
import { resolveTerritoryFromCoordinates } from '@/services/territoryResolveLegacyService.js'

export type TerritoryMatchQuality = 'exact' | 'partial' | 'centroid' | 'ai' | 'none'

export interface TerritoryMatchResult {
  territoryId: string | null
  territoryName: string | null
  levelOrder: number | null
  districtId: string | null
  districtName: string | null
  matchQuality: TerritoryMatchQuality
  confidence: number
  distanceKm?: number | null
  candidates: TerritoryCandidate[]
  resolutionNotes: string | null
  /** True when confidence meets auto-apply threshold (else leave null on ticket). */
  shouldAutoApply: boolean
}

function emptyResult(notes?: string | null): TerritoryMatchResult {
  return {
    territoryId: null,
    territoryName: null,
    levelOrder: null,
    districtId: null,
    districtName: null,
    matchQuality: 'none',
    confidence: 0,
    candidates: [],
    resolutionNotes: notes ?? null,
    shouldAutoApply: false,
  }
}

function resultFromCandidate(
  candidate: TerritoryCandidate,
  quality: TerritoryMatchQuality,
  confidence: number,
  candidates: TerritoryCandidate[],
  notes: string | null,
): TerritoryMatchResult {
  const shouldAutoApply = confidence >= TERRITORY_AUTO_APPLY_CONFIDENCE
  return {
    territoryId: shouldAutoApply ? candidate.territory_id : null,
    territoryName: candidate.name,
    levelOrder: candidate.level_order,
    districtId: candidate.district_id,
    districtName: candidate.district_name,
    matchQuality: quality,
    confidence,
    candidates,
    resolutionNotes: shouldAutoApply ? notes : notes ?? `Below confidence threshold (${confidence.toFixed(2)})`,
    shouldAutoApply,
  }
}

function resultFromCoordMatch(
  coordMatch: Awaited<ReturnType<typeof resolveTerritoryFromCoordinates>>,
  candidates: TerritoryCandidate[],
): TerritoryMatchResult {
  if (!coordMatch.territoryId) return emptyResult('No coordinate match')
  const confidence = 0.72
  const shouldAutoApply = confidence >= TERRITORY_AUTO_APPLY_CONFIDENCE
  return {
    territoryId: shouldAutoApply ? coordMatch.territoryId : null,
    territoryName: coordMatch.territoryName,
    levelOrder: coordMatch.levelOrder,
    districtId: null,
    districtName: null,
    matchQuality: 'centroid',
    confidence,
    distanceKm: coordMatch.distanceKm,
    candidates,
    resolutionNotes: shouldAutoApply ? 'Nearest territory centroid from GPS' : 'GPS match below apply policy',
    shouldAutoApply,
  }
}

/** Resolve territory for intake — rules + AI + GPS, with confidence gating. */
export async function resolveTicketTerritory(args: {
  organizationId: string
  locationText?: string | null
  issueText?: string | null
  latitude?: number | null
  longitude?: number | null
  /** When false, always return best guess in territoryId (for suggestions). Default true. */
  applyConfidenceGate?: boolean
}): Promise<TerritoryMatchResult> {
  const combined = [args.locationText, args.issueText].filter(Boolean).join(' ').trim()
  if (!combined && !isValidLatitude(args.latitude)) {
    return emptyResult()
  }
  if (combined && isLikelyCoordinateOnlyText(combined) && isValidLatitude(args.latitude)) {
    // skip text when only coords string; fall through to GPS
  }

  const { candidates, metroContext } = await buildTerritoryCandidates({
    organizationId: args.organizationId,
    locationText: args.locationText,
    issueText: args.issueText,
    latitude: args.latitude,
    longitude: args.longitude,
  })

  const applyGate = args.applyConfidenceGate !== false
  const rows = await loadOrgTerritoryRowsCached(args.organizationId)
  const byId = new Map(rows.map((r) => [r.id, r]))

  // 1) AI pick when configured and we have candidates
  const aiPick = await pickTerritoryWithAi({
    locationText: args.locationText ?? '',
    issueText: args.issueText ?? '',
    latitude: args.latitude,
    longitude: args.longitude,
    candidates,
    metroContext,
  })

  if (aiPick?.territory_id && aiPick.confidence >= TERRITORY_AI_MIN_CONFIDENCE) {
    const picked = candidates.find((c) => c.territory_id === aiPick.territory_id)
    if (picked) {
      const result = resultFromCandidate(
        picked,
        'ai',
        aiPick.confidence,
        candidates,
        aiPick.reason,
      )
      if (!applyGate && result.territoryId == null) {
        return { ...result, territoryId: picked.territory_id, shouldAutoApply: true }
      }
      return result
    }
  }

  // 2) Rule-based best candidate
  if (hasTerritoryCandidateConflict(candidates)) {
    const note =
      aiPick?.reason ??
      `Ambiguous location — top matches span different districts (${candidates[0]?.district_name} vs ${candidates[1]?.district_name})`
    const suggestion = candidates[0]
    if (!applyGate && suggestion) {
      const district = getDistrictAncestor(suggestion.territory_id, byId)
      return {
        territoryId: suggestion.territory_id,
        territoryName: suggestion.name,
        levelOrder: suggestion.level_order,
        districtId: district?.id ?? suggestion.district_id,
        districtName: district?.name ?? suggestion.district_name,
        matchQuality: 'partial',
        confidence: suggestion.confidence,
        candidates,
        resolutionNotes: note,
        shouldAutoApply: false,
      }
    }
    return { ...emptyResult(note), candidates }
  }

  const ruleBest = pickBestRuleCandidate(candidates)
  if (ruleBest) {
    const result = resultFromCandidate(
      ruleBest,
      ruleBest.score >= 100 ? 'exact' : 'partial',
      ruleBest.confidence,
      candidates,
      ruleBest.match_reason,
    )
    if (!applyGate && result.territoryId == null) {
      return { ...result, territoryId: ruleBest.territory_id, shouldAutoApply: false }
    }
    return result
  }

  // 3) GPS centroid fallback
  if (isValidLatitude(args.latitude) && isValidLongitude(args.longitude)) {
    const coordMatch = await resolveTerritoryFromCoordinates(
      args.organizationId,
      args.latitude,
      args.longitude,
    )
    if (coordMatch.territoryId) {
      const district = getDistrictAncestor(coordMatch.territoryId, byId)
      const coordResult = resultFromCoordMatch(coordMatch, candidates)
      if (district) {
        coordResult.districtId = district.id
        coordResult.districtName = district.name
      }
      if (!applyGate && coordResult.territoryId == null && coordMatch.territoryId) {
        return {
          ...coordResult,
          territoryId: coordMatch.territoryId,
          territoryName: coordMatch.territoryName,
          levelOrder: coordMatch.levelOrder,
        }
      }
      return coordResult
    }
  }

  if (aiPick?.reason) {
    return { ...emptyResult(aiPick.reason), candidates }
  }

  return { ...emptyResult(), candidates }
}

/** Set tickets.territory_id when confidence allows, using location text, issue text, and/or coordinates. */
export async function resolveAndApplyTicketTerritory(args: {
  ticketId: string
  organizationId: string
  locationText?: string | null
  issueText?: string | null
  latitude?: number | null
  longitude?: number | null
  force?: boolean
}): Promise<TerritoryMatchResult & { applied: boolean }> {
  const supabase = createSupabaseServiceClient()
  const { data: ticket } = await supabase
    .from('tickets')
    .select('territory_id, location_text, original_issue_text, latitude, longitude')
    .eq('id', args.ticketId)
    .maybeSingle()

  if (ticket?.territory_id && !args.force) {
    return {
      territoryId: ticket.territory_id as string,
      territoryName: null,
      levelOrder: null,
      districtId: null,
      districtName: null,
      matchQuality: 'exact',
      confidence: 1,
      candidates: [],
      resolutionNotes: null,
      shouldAutoApply: true,
      applied: false,
    }
  }

  const locationText = args.locationText ?? (ticket?.location_text as string | null) ?? ''
  const issueText = args.issueText ?? (ticket?.original_issue_text as string | null) ?? ''
  const latitude = args.latitude ?? (ticket?.latitude as number | null) ?? null
  const longitude = args.longitude ?? (ticket?.longitude as number | null) ?? null

  const match = await resolveTicketTerritory({
    organizationId: args.organizationId,
    locationText,
    issueText,
    latitude,
    longitude,
    applyConfidenceGate: true,
  })

  if (!match.territoryId || !match.shouldAutoApply) {
    return { ...match, applied: false }
  }

  const { error } = await supabase
    .from('tickets')
    .update({ territory_id: match.territoryId })
    .eq('id', args.ticketId)

  if (error) {
    console.error('[territoryResolve] ticket update', error)
    return { ...match, applied: false }
  }

  return { ...match, applied: true }
}

// Re-export for callers that used legacy text-only resolve
export { resolveTerritoryFromLocationText } from '@/services/territoryResolveLegacyService.js'
