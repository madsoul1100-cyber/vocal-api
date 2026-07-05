import { createSupabaseServiceClient } from '@/lib/supabase.js'
import { isPostgresMode, dbQuery } from '@/lib/db.js'
import {
  buildDashboardWebMeta,
  type ResolvedDashboardWebFilters,
} from '@/services/dashboardWebFiltersService.js'

export interface TicketCategoryChartSegment {
  key: string
  label: string
  count: number
  percent: number
}

export interface TicketCategoryChartResponse {
  chart_type: 'donut'
  dimension: 'ticket_category'
  title: string
  total: number
  segments: TicketCategoryChartSegment[]
  meta: ReturnType<typeof buildDashboardWebMeta>
}

interface RawCategoryRow {
  category_id: string | null
  category_name: string | null
  count: number
}

export type { RawCategoryRow }

const UNCATEGORIZED_KEY = 'uncategorized'
const UNCATEGORIZED_LABEL = 'Uncategorized'
const OTHER_KEY = 'other'
const OTHER_LABEL = 'Other'

export { UNCATEGORIZED_KEY, UNCATEGORIZED_LABEL, OTHER_KEY, OTHER_LABEL }

export interface CategorySegmentDefinition {
  key: string
  label: string
}

export interface CategorySegmentPlan {
  segments: CategorySegmentDefinition[]
  segmentOrder: string[]
  bucketCategoryRow(row: RawCategoryRow): string | null
}

/** Pick top categories + Other + Uncategorized buckets (same rules as donut chart). */
export function planCategorySegments(
  rows: RawCategoryRow[],
  segmentLimit: number,
  options?: { includeUncategorizedWhenEmpty?: boolean },
): CategorySegmentPlan {
  let uncategorizedCount = 0
  const categorized: RawCategoryRow[] = []

  for (const row of rows) {
    if (!row.category_id || !row.category_name) {
      uncategorizedCount += row.count
    } else {
      categorized.push(row)
    }
  }

  categorized.sort((a, b) => b.count - a.count || a.category_name!.localeCompare(b.category_name!))

  const top = categorized.slice(0, segmentLimit)
  const remainder = categorized.slice(segmentLimit)
  const topIds = new Set(top.map((r) => r.category_id!))

  const segments: CategorySegmentDefinition[] = top.map((row) => ({
    key: slugifyCategoryKey(row.category_name!, row.category_id),
    label: row.category_name!,
  }))

  if (remainder.length > 0) {
    segments.push({ key: OTHER_KEY, label: OTHER_LABEL })
  }
  if (uncategorizedCount > 0 || (options?.includeUncategorizedWhenEmpty && rows.length === 0)) {
    segments.push({ key: UNCATEGORIZED_KEY, label: UNCATEGORIZED_LABEL })
  }

  return {
    segments,
    segmentOrder: segments.map((s) => s.key),
    bucketCategoryRow(row: RawCategoryRow): string | null {
      if (!row.category_id || !row.category_name) {
        return UNCATEGORIZED_KEY
      }
      if (topIds.has(row.category_id)) {
        return slugifyCategoryKey(row.category_name, row.category_id)
      }
      return OTHER_KEY
    },
  }
}

function slugifyCategoryKey(name: string, id: string | null): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 64)
  if (slug) return slug
  if (id) return id.replace(/-/g, '').slice(0, 12)
  return 'category'
}

function roundPercent(value: number): number {
  return Math.round(value * 10) / 10
}

function buildSegments(
  rows: RawCategoryRow[],
  total: number,
  segmentLimit: number,
): TicketCategoryChartSegment[] {
  if (total === 0) return []

  let uncategorizedCount = 0
  const categorized: RawCategoryRow[] = []

  for (const row of rows) {
    if (!row.category_id || !row.category_name) {
      uncategorizedCount += row.count
    } else {
      categorized.push(row)
    }
  }

  categorized.sort((a, b) => b.count - a.count || a.category_name!.localeCompare(b.category_name!))

  const segments: TicketCategoryChartSegment[] = []
  const top = categorized.slice(0, segmentLimit)
  const remainder = categorized.slice(segmentLimit)
  const otherCount = remainder.reduce((sum, r) => sum + r.count, 0)

  for (const row of top) {
    segments.push({
      key: slugifyCategoryKey(row.category_name!, row.category_id),
      label: row.category_name!,
      count: row.count,
      percent: roundPercent((row.count / total) * 100),
    })
  }

  if (otherCount > 0) {
    segments.push({
      key: OTHER_KEY,
      label: OTHER_LABEL,
      count: otherCount,
      percent: roundPercent((otherCount / total) * 100),
    })
  }

  if (uncategorizedCount > 0) {
    segments.push({
      key: UNCATEGORIZED_KEY,
      label: UNCATEGORIZED_LABEL,
      count: uncategorizedCount,
      percent: roundPercent((uncategorizedCount / total) * 100),
    })
  }

  return segments
}

async function aggregateCategoryCountsPg(
  orgId: string,
  resolved: ResolvedDashboardWebFilters,
): Promise<RawCategoryRow[]> {
  const { dateRange, territoryIds, includeNullTerritory } = resolved

  if (territoryIds.length === 0 && !includeNullTerritory) {
    return []
  }

  let territoryClause: string
  const params: unknown[] = [
    orgId,
    dateRange.createdFrom.toISOString(),
    dateRange.createdTo.toISOString(),
  ]

  if (territoryIds.length === 0) {
    territoryClause = 't.territory_id IS NULL'
  } else if (includeNullTerritory) {
    params.push(territoryIds)
    territoryClause = '(t.territory_id IS NULL OR t.territory_id = ANY($4::uuid[]))'
  } else {
    params.push(territoryIds)
    territoryClause = 't.territory_id = ANY($4::uuid[])'
  }

  const res = await dbQuery<{ category_id: string | null; category_name: string | null; c: string }>(
    `SELECT top.id AS category_id, top.name AS category_name, COUNT(*)::text AS c
     FROM tickets t
     LEFT JOIN issue_categories cat ON cat.id = t.category_id
     LEFT JOIN issue_categories sub ON sub.id = t.subcategory_id
     LEFT JOIN issue_categories top ON top.id = COALESCE(
       CASE WHEN cat.level = 1 THEN cat.id ELSE cat.parent_id END,
       CASE WHEN sub.level = 1 THEN sub.id ELSE sub.parent_id END
     )
     WHERE t.organization_id = $1
       AND t.created_at >= $2
       AND t.created_at <= $3
       AND ${territoryClause}
     GROUP BY top.id, top.name
     ORDER BY COUNT(*) DESC`,
    params,
  )

  return res.rows.map((r) => ({
    category_id: r.category_id,
    category_name: r.category_name,
    count: Number(r.c),
  }))
}

async function aggregateCategoryCountsSupabase(
  orgId: string,
  resolved: ResolvedDashboardWebFilters,
): Promise<RawCategoryRow[]> {
  const { dateRange, territoryIds, includeNullTerritory } = resolved
  if (territoryIds.length === 0 && !includeNullTerritory) {
    return []
  }

  const supabase = createSupabaseServiceClient()
  const { data: categories } = await supabase
    .from('issue_categories')
    .select('id, name, level, parent_id')

  const catById = new Map(
    (categories ?? []).map((c) => [c.id as string, c as { id: string; name: string; level: number; parent_id: string | null }]),
  )

  function topLevelCategoryId(ticket: {
    category_id: string | null
    subcategory_id: string | null
  }): { id: string | null; name: string | null } {
    const cat = ticket.category_id ? catById.get(ticket.category_id) : null
    const sub = ticket.subcategory_id ? catById.get(ticket.subcategory_id) : null
    let topId: string | null = null
    if (cat) topId = cat.level === 1 ? cat.id : cat.parent_id
    else if (sub) topId = sub.level === 1 ? sub.id : sub.parent_id
    if (!topId) return { id: null, name: null }
    const top = catById.get(topId)
    return { id: topId, name: top?.name ?? null }
  }

  let q = supabase
    .from('tickets')
    .select('category_id, subcategory_id, territory_id')
    .eq('organization_id', orgId)
    .gte('created_at', dateRange.createdFrom.toISOString())
    .lte('created_at', dateRange.createdTo.toISOString())

  const { data: tickets } = await q
  const territorySet = new Set(territoryIds)
  const counts = new Map<string, { id: string | null; name: string | null; count: number }>()

  for (const t of tickets ?? []) {
    const tid = t.territory_id as string | null
    const inTerritory =
      (includeNullTerritory && tid == null) || (tid != null && territorySet.has(tid))
    if (!inTerritory) continue

    const top = topLevelCategoryId(t as { category_id: string | null; subcategory_id: string | null })
    const mapKey = top.id ?? '__uncategorized__'
    const existing = counts.get(mapKey)
    if (existing) {
      existing.count += 1
    } else {
      counts.set(mapKey, { id: top.id, name: top.name, count: 1 })
    }
  }

  return [...counts.values()].map((v) => ({
    category_id: v.id,
    category_name: v.name,
    count: v.count,
  }))
}

export async function getTicketCategoryChart(
  orgId: string,
  resolved: ResolvedDashboardWebFilters,
): Promise<TicketCategoryChartResponse> {
  const rows = isPostgresMode()
    ? await aggregateCategoryCountsPg(orgId, resolved)
    : await aggregateCategoryCountsSupabase(orgId, resolved)

  const total = rows.reduce((sum, r) => sum + r.count, 0)
  const segments = buildSegments(rows, total, resolved.segmentLimit)

  return {
    chart_type: 'donut',
    dimension: 'ticket_category',
    title: 'Tickets by category',
    total,
    segments,
    meta: buildDashboardWebMeta(orgId, resolved),
  }
}
