/**
 * Web dashboard — tickets by top-level category over past calendar months.
 * Territory scoped only; ignores dashboard date picker (uses fixed month window).
 */

import { createSupabaseServiceClient } from '@/lib/supabase.js'
import { isPostgresMode, dbQuery } from '@/lib/db.js'
import {
  buildDashboardWebTerritoryMeta,
  buildDashboardWebTerritorySqlClause,
  type ResolvedDashboardWebTerritoryFilters,
} from '@/services/dashboardWebFiltersService.js'
import {
  planCategorySegments,
  type RawCategoryRow,
} from '@/services/dashboardTicketCategoryChartService.js'

export interface CategoryMonthlySegment {
  key: string
  label: string
  count: number
}

export interface CategoryMonthlyBucket {
  key: string
  label: string
  from: string
  to: string
  total: number
  segments: CategoryMonthlySegment[]
}

export interface CategoryMonthlyChartResponse {
  chart_type: 'stacked_bar_time'
  title: string
  segment_order: string[]
  segments_meta: Array<{ key: string; label: string }>
  months: CategoryMonthlyBucket[]
  total: number
  meta: ReturnType<typeof buildDashboardWebTerritoryMeta>
}

interface MonthWindow {
  key: string
  label: string
  from: string
  to: string
  createdFrom: Date
  createdTo: Date
}

interface RawMonthlyCategoryRow extends RawCategoryRow {
  month_key: string
}

const MONTH_LABELS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]

function utcYmd(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function daysInUtcMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate()
}

/** Last N calendar months ending in the current UTC month (current month partial through today). */
export function buildUtcMonthWindows(monthCount: number, reference = new Date()): MonthWindow[] {
  const now = new Date(
    Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), reference.getUTCDate()),
  )
  const currentYear = now.getUTCFullYear()
  const currentMonth = now.getUTCMonth()

  const windows: MonthWindow[] = []

  for (let offset = monthCount - 1; offset >= 0; offset -= 1) {
    let year = currentYear
    let month = currentMonth - offset
    while (month < 0) {
      month += 12
      year -= 1
    }

    const from = `${year}-${String(month + 1).padStart(2, '0')}-01`
    const isCurrentMonth = year === currentYear && month === currentMonth
    const to = isCurrentMonth
      ? utcYmd(now)
      : `${year}-${String(month + 1).padStart(2, '0')}-${String(daysInUtcMonth(year, month)).padStart(2, '0')}`

    windows.push({
      key: `${year}-${String(month + 1).padStart(2, '0')}`,
      label: `${MONTH_LABELS[month]} ${year}`,
      from,
      to,
      createdFrom: new Date(`${from}T00:00:00.000Z`),
      createdTo: isCurrentMonth
        ? new Date(`${to}T23:59:59.999Z`)
        : new Date(`${to}T23:59:59.999Z`),
    })
  }

  return windows
}

function rollupGlobalCategoryRows(rows: RawMonthlyCategoryRow[]): RawCategoryRow[] {
  const byCategory = new Map<string, RawCategoryRow>()
  for (const row of rows) {
    const mapKey = row.category_id ?? '__uncategorized__'
    const existing = byCategory.get(mapKey)
    if (existing) {
      existing.count += row.count
    } else {
      byCategory.set(mapKey, {
        category_id: row.category_id,
        category_name: row.category_name,
        count: row.count,
      })
    }
  }
  return [...byCategory.values()]
}

function buildMonthSegments(
  monthKey: string,
  rows: RawMonthlyCategoryRow[],
  plan: ReturnType<typeof planCategorySegments>,
): CategoryMonthlySegment[] {
  const counts = new Map<string, number>()
  for (const key of plan.segmentOrder) {
    counts.set(key, 0)
  }

  for (const row of rows) {
    if (row.month_key !== monthKey) continue
    const bucket = plan.bucketCategoryRow(row)
    if (!bucket || !counts.has(bucket)) continue
    counts.set(bucket, (counts.get(bucket) ?? 0) + row.count)
  }

  return plan.segments.map((segment) => ({
    key: segment.key,
    label: segment.label,
    count: counts.get(segment.key) ?? 0,
  }))
}

async function aggregateMonthlyCategoryCountsPg(
  orgId: string,
  resolved: ResolvedDashboardWebTerritoryFilters,
  windows: MonthWindow[],
): Promise<RawMonthlyCategoryRow[]> {
  const territory = buildDashboardWebTerritorySqlClause(resolved, 't', 4)
  if (territory.clause === 'FALSE') {
    return []
  }

  const windowStart = windows[0]!.createdFrom.toISOString()
  const windowEnd = windows[windows.length - 1]!.createdTo.toISOString()

  const params = [orgId, windowStart, windowEnd, ...territory.params]

  const res = await dbQuery<{
    month_key: string
    category_id: string | null
    category_name: string | null
    c: string
  }>(
    `SELECT
       to_char(t.created_at AT TIME ZONE 'UTC', 'YYYY-MM') AS month_key,
       top.id AS category_id,
       top.name AS category_name,
       COUNT(*)::text AS c
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
       AND ${territory.clause}
     GROUP BY month_key, top.id, top.name
     ORDER BY month_key ASC, COUNT(*) DESC`,
    params,
  )

  return res.rows.map((r) => ({
    month_key: r.month_key,
    category_id: r.category_id,
    category_name: r.category_name,
    count: Number(r.c),
  }))
}

async function aggregateMonthlyCategoryCountsSupabase(
  orgId: string,
  resolved: ResolvedDashboardWebTerritoryFilters,
  windows: MonthWindow[],
): Promise<RawMonthlyCategoryRow[]> {
  if (resolved.territoryIds.length === 0 && !resolved.includeNullTerritory) {
    return []
  }

  const supabase = createSupabaseServiceClient()
  const { data: categories } = await supabase
    .from('issue_categories')
    .select('id, name, level, parent_id')

  const catById = new Map(
    (categories ?? []).map((c) => [
      c.id as string,
      c as { id: string; name: string; level: number; parent_id: string | null },
    ]),
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

  const windowStart = windows[0]!.createdFrom.toISOString()
  const windowEnd = windows[windows.length - 1]!.createdTo.toISOString()

  const { data: tickets } = await supabase
    .from('tickets')
    .select('created_at, category_id, subcategory_id, territory_id')
    .eq('organization_id', orgId)
    .gte('created_at', windowStart)
    .lte('created_at', windowEnd)

  const territorySet = new Set(resolved.territoryIds)
  const counts = new Map<string, RawMonthlyCategoryRow>()

  for (const t of tickets ?? []) {
    const tid = t.territory_id as string | null
    const inTerritory =
      (resolved.includeNullTerritory && tid == null) ||
      (tid != null && territorySet.has(tid))
    if (!inTerritory) continue

    const createdAt = new Date(t.created_at as string)
    const monthKey = `${createdAt.getUTCFullYear()}-${String(createdAt.getUTCMonth() + 1).padStart(2, '0')}`
    const top = topLevelCategoryId(t as { category_id: string | null; subcategory_id: string | null })
    const mapKey = `${monthKey}::${top.id ?? '__uncategorized__'}`
    const existing = counts.get(mapKey)
    if (existing) {
      existing.count += 1
    } else {
      counts.set(mapKey, {
        month_key: monthKey,
        category_id: top.id,
        category_name: top.name,
        count: 1,
      })
    }
  }

  return [...counts.values()]
}

export async function getCategoryMonthlyChart(
  orgId: string,
  resolved: ResolvedDashboardWebTerritoryFilters,
): Promise<CategoryMonthlyChartResponse> {
  const windows = buildUtcMonthWindows(resolved.monthCount)
  const rows = isPostgresMode()
    ? await aggregateMonthlyCategoryCountsPg(orgId, resolved, windows)
    : await aggregateMonthlyCategoryCountsSupabase(orgId, resolved, windows)

  const globalRows = rollupGlobalCategoryRows(rows)
  const plan = planCategorySegments(globalRows, resolved.segmentLimit, {
    includeUncategorizedWhenEmpty: globalRows.length === 0,
  })

  const months: CategoryMonthlyBucket[] = windows.map((window) => {
    const segments = buildMonthSegments(window.key, rows, plan)
    const total = segments.reduce((sum, segment) => sum + segment.count, 0)
    return {
      key: window.key,
      label: window.label,
      from: window.from,
      to: window.to,
      total,
      segments,
    }
  })

  const total = months.reduce((sum, month) => sum + month.total, 0)
  const endMonth = windows[windows.length - 1]?.key ?? ''

  return {
    chart_type: 'stacked_bar_time',
    title: 'Tickets by category over time',
    segment_order: plan.segmentOrder,
    segments_meta: plan.segments,
    months,
    total,
    meta: buildDashboardWebTerritoryMeta(orgId, resolved, { end_month: endMonth }),
  }
}
