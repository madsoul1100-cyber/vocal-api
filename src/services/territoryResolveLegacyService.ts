/**
 * Legacy rule-only territory helpers (coordinates + simple text scan).
 * Used as GPS fallback by territoryResolveService.
 */

import {
  DEFAULT_TERRITORY_STATE_NAME,
  loadOrgTerritoryRowsCached,
} from '@/services/territoryService.js'
import {
  haversineKm,
  isLikelyCoordinateOnlyText,
  isValidLatitude,
  isValidLongitude,
} from '@/lib/geo.js'
import { TELANGANA_DISTRICT_CENTROIDS_BY_CODE } from '@/data/telanganaDistrictCentroids.js'
import { normalizeTerritoryMatchText } from '@/services/territoryCandidateService.js'

export type LegacyTerritoryMatchQuality = 'exact' | 'partial' | 'centroid' | 'none'

export interface LegacyTerritoryMatchResult {
  territoryId: string | null
  territoryName: string | null
  levelOrder: number | null
  matchQuality: LegacyTerritoryMatchQuality
  distanceKm?: number | null
}

function nameAppearsInText(name: string, normalizedText: string): boolean {
  const n = normalizeTerritoryMatchText(name)
  if (n.length < 3) return false
  if (normalizedText.includes(n)) return true
  const tokens = n.split(' ').filter((w) => w.length >= 4)
  if (tokens.length === 0) return false
  const matched = tokens.filter((tok) => normalizedText.includes(tok))
  return matched.length >= Math.min(2, tokens.length)
}

function buildTelanganaDescendantIds(
  rows: Awaited<ReturnType<typeof loadOrgTerritoryRowsCached>>,
): Set<string> | null {
  const telangana = rows.find(
    (r) =>
      r.level_order === 1 &&
      r.name.trim().toLowerCase() === DEFAULT_TERRITORY_STATE_NAME.toLowerCase(),
  )
  if (!telangana) return null

  const childrenOf = new Map<string, string[]>()
  for (const r of rows) {
    if (!r.parent_territory_id) continue
    const list = childrenOf.get(r.parent_territory_id) ?? []
    list.push(r.id)
    childrenOf.set(r.parent_territory_id, list)
  }

  const out = new Set<string>()
  const stack = [telangana.id]
  while (stack.length > 0) {
    const id = stack.pop()!
    if (out.has(id)) continue
    out.add(id)
    for (const childId of childrenOf.get(id) ?? []) stack.push(childId)
  }
  return out
}

function resolveCentroid(
  row: Awaited<ReturnType<typeof loadOrgTerritoryRowsCached>>[number],
): { lat: number; lng: number } | null {
  if (row.centroid_lat != null && row.centroid_lng != null) {
    return { lat: row.centroid_lat, lng: row.centroid_lng }
  }
  if (row.level_order === 2 && row.code) {
    return TELANGANA_DISTRICT_CENTROIDS_BY_CODE[row.code] ?? null
  }
  return null
}

export async function resolveTerritoryFromLocationText(
  organizationId: string,
  locationText: string,
  issueText?: string | null,
): Promise<LegacyTerritoryMatchResult> {
  const combined = [locationText, issueText].filter(Boolean).join(' ').trim()
  if (!combined || isLikelyCoordinateOnlyText(combined)) {
    return { territoryId: null, territoryName: null, levelOrder: null, matchQuality: 'none' }
  }

  const rows = await loadOrgTerritoryRowsCached(organizationId)
  const telanganaIds = buildTelanganaDescendantIds(rows)
  const normalizedText = normalizeTerritoryMatchText(combined)

  type Scored = { id: string; name: string; level_order: number; score: number; exact: boolean }
  const scored: Scored[] = []

  for (const row of rows) {
    if (row.level_order < 2) continue
    if (telanganaIds && !telanganaIds.has(row.id)) continue

    const exact = normalizeTerritoryMatchText(row.name) === normalizedText
    const partial = !exact && nameAppearsInText(row.name, normalizedText)
    if (!exact && !partial) continue

    const nameLen = normalizeTerritoryMatchText(row.name).length
    const depthBoost = row.level_order ** 2
    const score = nameLen * depthBoost + (exact ? 10_000 : 0)
    scored.push({
      id: row.id,
      name: row.name,
      level_order: row.level_order,
      score,
      exact,
    })
  }

  if (scored.length === 0) {
    return { territoryId: null, territoryName: null, levelOrder: null, matchQuality: 'none' }
  }

  scored.sort((a, b) => b.score - a.score || b.level_order - a.level_order)
  const best = scored[0]!
  return {
    territoryId: best.id,
    territoryName: best.name,
    levelOrder: best.level_order,
    matchQuality: best.exact ? 'exact' : 'partial',
  }
}

export async function resolveTerritoryFromCoordinates(
  organizationId: string,
  latitude: number,
  longitude: number,
): Promise<LegacyTerritoryMatchResult> {
  if (!isValidLatitude(latitude) || !isValidLongitude(longitude)) {
    return { territoryId: null, territoryName: null, levelOrder: null, matchQuality: 'none' }
  }

  const rows = await loadOrgTerritoryRowsCached(organizationId)
  const telanganaIds = buildTelanganaDescendantIds(rows)
  const point = { lat: latitude, lng: longitude }

  type Candidate = {
    id: string
    name: string
    level_order: number
    distanceKm: number
  }
  const candidates: Candidate[] = []

  for (const row of rows) {
    if (row.level_order < 2) continue
    if (telanganaIds && !telanganaIds.has(row.id)) continue

    const centroid = resolveCentroid(row)
    if (!centroid) continue

    candidates.push({
      id: row.id,
      name: row.name,
      level_order: row.level_order,
      distanceKm: haversineKm(point, centroid),
    })
  }

  if (candidates.length === 0) {
    return { territoryId: null, territoryName: null, levelOrder: null, matchQuality: 'none' }
  }

  candidates.sort(
    (a, b) =>
      a.distanceKm - b.distanceKm ||
      b.level_order - a.level_order ||
      a.name.localeCompare(b.name),
  )

  const best = candidates[0]!
  return {
    territoryId: best.id,
    territoryName: best.name,
    levelOrder: best.level_order,
    matchQuality: 'centroid',
    distanceKm: Math.round(best.distanceKm * 100) / 100,
  }
}
