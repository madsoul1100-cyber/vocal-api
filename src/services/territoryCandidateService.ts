/**
 * Territory candidate generation — fuzzy names, aliases, metro context, homonym handling.
 */

import {
  GREATER_HYDERABAD_DISTRICT_CODES,
  GREATER_HYDERABAD_TEXT_HINTS,
  TERRITORY_NAME_ALIASES,
} from '@/data/territoryLocationHints.js'
import { haversineKm, isValidLatitude, isValidLongitude } from '@/lib/geo.js'
import { TELANGANA_DISTRICT_CENTROIDS_BY_CODE } from '@/data/telanganaDistrictCentroids.js'
import {
  DEFAULT_TERRITORY_STATE_NAME,
  loadOrgTerritoryRowsCached,
} from '@/services/territoryService.js'

export type TerritoryRow = Awaited<ReturnType<typeof loadOrgTerritoryRowsCached>>[number]

export interface TerritoryCandidate {
  territory_id: string
  name: string
  level_order: number
  district_id: string | null
  district_name: string | null
  district_code: string | null
  score: number
  confidence: number
  match_reason: string
}

const LOCATION_TYPO_FIXES: Array<[RegExp, string]> = [
  [/\bhydreabad\b/gi, 'hyderabad'],
  [/\bhydrabad\b/gi, 'hyderabad'],
  [/\bhyerabad\b/gi, 'hyderabad'],
  [/\bsecunderbad\b/gi, 'secunderabad'],
  [/\brangareddy\b/gi, 'ranga reddy'],
]

export function normalizeTerritoryMatchText(text: string): string {
  let t = text.toLowerCase()
  for (const [pattern, replacement] of LOCATION_TYPO_FIXES) {
    t = t.replace(pattern, replacement)
  }
  return t
    .replace(/\b(dr|mr|mrs)\b\.?/gi, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function levenshteinRatio(a: string, b: string): number {
  if (!a.length || !b.length) return 0
  if (a === b) return 1
  const rows = a.length + 1
  const cols = b.length + 1
  const matrix: number[][] = Array.from({ length: rows }, () => Array(cols).fill(0))
  for (let i = 0; i < rows; i++) matrix[i]![0] = i
  for (let j = 0; j < cols; j++) matrix[0]![j] = j
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      matrix[i]![j] = Math.min(
        matrix[i - 1]![j]! + 1,
        matrix[i]![j - 1]! + 1,
        matrix[i - 1]![j - 1]! + cost,
      )
    }
  }
  const dist = matrix[a.length]![b.length]!
  return 1 - dist / Math.max(a.length, b.length)
}

export function hasGreaterHyderabadContext(normalizedText: string): boolean {
  return GREATER_HYDERABAD_TEXT_HINTS.some((hint) => normalizedText.includes(hint))
}

function aliasesForRow(row: TerritoryRow): string[] {
  const keyName = row.name.trim().toLowerCase()
  const byName = TERRITORY_NAME_ALIASES[keyName] ?? []
  const byCode = row.code ? (TERRITORY_NAME_ALIASES[row.code] ?? []) : []
  return [...byName, ...byCode]
}

export function buildTelanganaDescendantIds(rows: TerritoryRow[]): Set<string> | null {
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

export function buildSubtreeIds(rows: TerritoryRow[], rootId: string): Set<string> {
  const childrenOf = new Map<string, string[]>()
  for (const r of rows) {
    if (!r.parent_territory_id) continue
    const list = childrenOf.get(r.parent_territory_id) ?? []
    list.push(r.id)
    childrenOf.set(r.parent_territory_id, list)
  }
  const out = new Set<string>([rootId])
  const stack = [rootId]
  while (stack.length > 0) {
    const id = stack.pop()!
    for (const childId of childrenOf.get(id) ?? []) {
      if (!out.has(childId)) {
        out.add(childId)
        stack.push(childId)
      }
    }
  }
  return out
}

export function getDistrictAncestor(
  territoryId: string,
  byId: Map<string, TerritoryRow>,
): TerritoryRow | null {
  let cur = byId.get(territoryId)
  while (cur && cur.level_order > 2) {
    const parentId = cur.parent_territory_id
    if (!parentId) return null
    cur = byId.get(parentId)
  }
  if (cur && cur.level_order === 2) return cur
  return null
}

function textMatchScore(name: string, aliases: string[], normalizedText: string): {
  score: number
  reason: string
} {
  const normalizedName = normalizeTerritoryMatchText(name)
  if (!normalizedName) return { score: 0, reason: '' }

  if (normalizedText.includes(normalizedName)) {
    return { score: 100 + normalizedName.length, reason: `name:${name}` }
  }

  let best = 0
  let bestToken = ''
  for (const token of normalizedName.split(' ').filter((w) => w.length >= 4)) {
    if (normalizedText.includes(token)) {
      const s = 40 + token.length
      if (s > best) {
        best = s
        bestToken = token
      }
    }
  }
  if (best > 0) return { score: best, reason: `token:${bestToken}` }

  const fuzzyName = levenshteinRatio(normalizedName, normalizedText)
  if (fuzzyName >= 0.82 && normalizedName.length >= 5) {
    return { score: 35 + fuzzyName * 20, reason: `fuzzy_name:${name}` }
  }

  for (const alias of aliases) {
    const na = normalizeTerritoryMatchText(alias)
    if (na && normalizedText.includes(na)) {
      return { score: 55 + na.length, reason: `alias:${alias}` }
    }
    const fuzzyAlias = levenshteinRatio(na, normalizedText)
    if (fuzzyAlias >= 0.85 && na.length >= 4) {
      return { score: 30 + fuzzyAlias * 20, reason: `fuzzy_alias:${alias}` }
    }
  }

  return { score: 0, reason: '' }
}

function resolveCentroid(row: TerritoryRow): { lat: number; lng: number } | null {
  if (row.centroid_lat != null && row.centroid_lng != null) {
    return { lat: row.centroid_lat, lng: row.centroid_lng }
  }
  if (row.level_order === 2 && row.code) {
    return TELANGANA_DISTRICT_CENTROIDS_BY_CODE[row.code] ?? null
  }
  return null
}

function scoreToConfidence(score: number): number {
  if (score <= 0) return 0
  return Math.min(0.98, Math.max(0.2, score / 120))
}

export interface BuildCandidatesInput {
  organizationId: string
  locationText?: string | null
  issueText?: string | null
  latitude?: number | null
  longitude?: number | null
  limit?: number
}

export async function buildTerritoryCandidates(
  input: BuildCandidatesInput,
): Promise<{
  candidates: TerritoryCandidate[]
  normalizedText: string
  metroContext: boolean
  coordDistrictHint: TerritoryRow | null
}> {
  const combined = [input.locationText, input.issueText].filter(Boolean).join(' ').trim()
  const normalizedText = normalizeTerritoryMatchText(combined)
  const metroContext = hasGreaterHyderabadContext(normalizedText)

  const rows = await loadOrgTerritoryRowsCached(input.organizationId)
  const byId = new Map(rows.map((r) => [r.id, r]))
  const telanganaIds = buildTelanganaDescendantIds(rows)

  const metroDistrictIds = new Set<string>()
  const metroSubtree = new Set<string>()
  if (metroContext) {
    for (const row of rows) {
      if (row.level_order === 2 && row.code && GREATER_HYDERABAD_DISTRICT_CODES.includes(row.code as typeof GREATER_HYDERABAD_DISTRICT_CODES[number])) {
        metroDistrictIds.add(row.id)
        for (const id of buildSubtreeIds(rows, row.id)) metroSubtree.add(id)
      }
    }
    const ghmc = rows.find((r) => normalizeTerritoryMatchText(r.name).includes('greater hyderabad'))
    if (ghmc) {
      for (const id of buildSubtreeIds(rows, ghmc.id)) metroSubtree.add(id)
    }
  }

  let coordDistrictHint: TerritoryRow | null = null
  if (isValidLatitude(input.latitude) && isValidLongitude(input.longitude)) {
    const point = { lat: input.latitude!, lng: input.longitude! }
    let bestDist = Infinity
    for (const row of rows) {
      if (row.level_order !== 2) continue
      const c = resolveCentroid(row)
      if (!c) continue
      const d = haversineKm(point, c)
      if (d < bestDist) {
        bestDist = d
        coordDistrictHint = row
      }
    }
  }

  const scored: TerritoryCandidate[] = []

  for (const row of rows) {
    if (row.level_order < 2) continue
    if (telanganaIds && !telanganaIds.has(row.id)) continue

    const { score: baseScore, reason } = textMatchScore(
      row.name,
      aliasesForRow(row),
      normalizedText,
    )
    if (baseScore <= 0) continue

    const district = getDistrictAncestor(row.id, byId)
    let score = baseScore + row.level_order * 3
    let matchReason = reason

    if (metroContext) {
      if (metroSubtree.has(row.id) || (district && metroDistrictIds.has(district.id))) {
        score += 45
        matchReason += '+metro'
      } else if (normalizeTerritoryMatchText(row.name) === 'narsingi') {
        score -= 80
        matchReason += '-metro_homonym'
      } else {
        score -= 15
      }
    }

    // Narsingi near Hyderabad city is under Ranga Reddy / GHMC — not Medak Narsingi.
    if (metroContext && normalizedText.includes('narsingi')) {
      const rowName = normalizeTerritoryMatchText(row.name)
      if (district?.code === '547' || rowName.includes('greater hyderabad')) {
        score += 55
        matchReason += '+narsingi_metro'
      }
    }

    if (coordDistrictHint && district?.id === coordDistrictHint.id) {
      score += 25
      matchReason += '+coord_district'
    }

    scored.push({
      territory_id: row.id,
      name: row.name,
      level_order: row.level_order,
      district_id: district?.id ?? null,
      district_name: district?.name ?? null,
      district_code: district?.code ?? null,
      score,
      confidence: scoreToConfidence(score),
      match_reason: matchReason,
    })
  }

  scored.sort((a, b) => b.score - a.score || b.level_order - a.level_order)

  const limit = input.limit ?? 12
  return {
    candidates: scored.slice(0, limit),
    normalizedText,
    metroContext,
    coordDistrictHint,
  }
}

/** True when top two candidates map to different districts with similar scores. */
export function hasTerritoryCandidateConflict(candidates: TerritoryCandidate[]): boolean {
  if (candidates.length < 2) return false
  const a = candidates[0]!
  const b = candidates[1]!
  if (!a.district_id || !b.district_id || a.district_id === b.district_id) return false
  const gap = a.score - b.score
  return gap < 18
}

export function pickBestRuleCandidate(
  candidates: TerritoryCandidate[],
): TerritoryCandidate | null {
  if (candidates.length === 0) return null
  if (hasTerritoryCandidateConflict(candidates)) return null
  return candidates[0]!
}
