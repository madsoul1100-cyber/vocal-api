/**
 * Resolve a citizen's free-text location to a territory node for ticket routing.
 * Uses the org territory tree (Telangana sample) with fuzzy name matching.
 */

import { createSupabaseServiceClient } from '@/lib/supabase.js'
import {
  DEFAULT_TERRITORY_STATE_NAME,
  loadOrgTerritoryRowsCached,
} from '@/services/territoryService.js'

export type TerritoryMatchQuality = 'exact' | 'partial' | 'none'

export interface TerritoryMatchResult {
  territoryId: string | null
  territoryName: string | null
  levelOrder: number | null
  matchQuality: TerritoryMatchQuality
}

const LOCATION_TYPO_FIXES: Array<[RegExp, string]> = [
  [/\bhydrabad\b/gi, 'hyderabad'],
  [/\bhyerabad\b/gi, 'hyderabad'],
  [/\bsecunderbad\b/gi, 'secunderabad'],
  [/\bbanjara\b/gi, 'banjara'],
]

function normalizeForMatch(text: string): string {
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

function nameAppearsInText(name: string, normalizedText: string): boolean {
  const n = normalizeForMatch(name)
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

/**
 * Match location / issue text to the most specific territory under Telangana.
 * Prefers deeper nodes (ward > mandal > district) when multiple names match.
 */
export async function resolveTerritoryFromLocationText(
  organizationId: string,
  locationText: string,
  issueText?: string | null,
): Promise<TerritoryMatchResult> {
  const combined = [locationText, issueText].filter(Boolean).join(' ').trim()
  if (!combined) {
    return { territoryId: null, territoryName: null, levelOrder: null, matchQuality: 'none' }
  }

  const rows = await loadOrgTerritoryRowsCached(organizationId)
  const telanganaIds = buildTelanganaDescendantIds(rows)
  const normalizedText = normalizeForMatch(combined)

  type Scored = { id: string; name: string; level_order: number; score: number; exact: boolean }
  const scored: Scored[] = []

  for (const row of rows) {
    if (row.level_order < 2) continue
    if (telanganaIds && !telanganaIds.has(row.id)) continue

    const exact = normalizeForMatch(row.name) === normalizedText
    const partial = !exact && nameAppearsInText(row.name, normalizedText)
    if (!exact && !partial) continue

    const nameLen = normalizeForMatch(row.name).length
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

/** Set tickets.territory_id when empty, using location_text and/or issue text. */
export async function resolveAndApplyTicketTerritory(args: {
  ticketId: string
  organizationId: string
  locationText?: string | null
  issueText?: string | null
  /** Re-resolve from location even when territory_id is already set. */
  force?: boolean
}): Promise<TerritoryMatchResult & { applied: boolean }> {
  const supabase = createSupabaseServiceClient()
  const { data: ticket } = await supabase
    .from('tickets')
    .select('territory_id, location_text, original_issue_text')
    .eq('id', args.ticketId)
    .maybeSingle()

  if (ticket?.territory_id && !args.force) {
    return {
      territoryId: ticket.territory_id as string,
      territoryName: null,
      levelOrder: null,
      matchQuality: 'exact',
      applied: false,
    }
  }

  const locationText = args.locationText ?? (ticket?.location_text as string | null) ?? ''
  const issueText = args.issueText ?? (ticket?.original_issue_text as string | null) ?? ''
  const match = await resolveTerritoryFromLocationText(args.organizationId, locationText, issueText)

  if (!match.territoryId) {
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
