import { createSupabaseServiceClient } from '@/lib/supabase.js'
import { isPostgresMode, dbQuery } from '@/lib/db.js'

export const REPORTS_BLOCKED_ROLES = ['ground_worker', 'media_volunteer', 'legal_support']

export function canAccessReports(role: string | null | undefined): boolean {
  return !!role && !REPORTS_BLOCKED_ROLES.includes(role)
}

export interface ReportsSummary {
  total: number
  open: number
  closed: number
  criticalOpen: number
  resolutionRate: number
  stageCounts: Record<string, number>
  topCategories: Array<{ name: string; count: number }>
}

export async function getReportsSummary(orgId: string): Promise<ReportsSummary> {
  if (isPostgresMode()) {
    return getReportsSummaryPg(orgId)
  }
  return getReportsSummarySupabase(orgId)
}

async function getReportsSummaryPg(orgId: string): Promise<ReportsSummary> {
  const base = 'organization_id = $1'
  const [totalRes, openRes, closedRes, criticalRes, stageRes, catRes] = await Promise.all([
    dbQuery<{ c: string }>(`SELECT COUNT(*)::text AS c FROM tickets WHERE ${base}`, [orgId]),
    dbQuery<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM tickets WHERE ${base} AND stage <> 'closed'`,
      [orgId],
    ),
    dbQuery<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM tickets WHERE ${base} AND stage = 'closed'`,
      [orgId],
    ),
    dbQuery<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM tickets WHERE ${base} AND critical_flag = true AND stage <> 'closed'`,
      [orgId],
    ),
    dbQuery<{ stage: string; c: string }>(
      `SELECT stage, COUNT(*)::text AS c FROM tickets WHERE ${base} GROUP BY stage`,
      [orgId],
    ),
    dbQuery<{ name: string; c: string }>(
      `SELECT ic.name, COUNT(*)::text AS c
       FROM tickets t
       INNER JOIN issue_categories ic ON ic.id = t.category_id
       WHERE t.organization_id = $1
       GROUP BY ic.name
       ORDER BY COUNT(*) DESC
       LIMIT 8`,
      [orgId],
    ),
  ])

  const total = Number(totalRes.rows[0]?.c ?? 0)
  const closed = Number(closedRes.rows[0]?.c ?? 0)
  const stageCounts: Record<string, number> = {}
  for (const row of stageRes.rows) {
    stageCounts[row.stage] = Number(row.c)
  }

  return buildSummary({
    total,
    open: Number(openRes.rows[0]?.c ?? 0),
    closed,
    criticalOpen: Number(criticalRes.rows[0]?.c ?? 0),
    stageCounts,
    topCategories: catRes.rows.map((r) => ({ name: r.name, count: Number(r.c) })),
  })
}

async function getReportsSummarySupabase(orgId: string): Promise<ReportsSummary> {
  const supabase = createSupabaseServiceClient()

  const [totalRes, openRes, closedRes, criticalRes, stageDist, topCategories] = await Promise.all([
    supabase.from('tickets').select('id', { count: 'exact', head: true }).eq('organization_id', orgId),
    supabase
      .from('tickets')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .neq('stage', 'closed'),
    supabase
      .from('tickets')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .eq('stage', 'closed'),
    supabase
      .from('tickets')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .eq('critical_flag', true)
      .neq('stage', 'closed'),
    supabase.from('tickets').select('stage').eq('organization_id', orgId),
    supabase
      .from('tickets')
      .select('category_id, issue_categories!tickets_category_id_fkey(name)')
      .eq('organization_id', orgId)
      .not('category_id', 'is', null),
  ])

  const stageCounts: Record<string, number> = {}
  for (const row of stageDist.data ?? []) {
    stageCounts[row.stage] = (stageCounts[row.stage] ?? 0) + 1
  }

  const catCounts: Record<string, number> = {}
  for (const row of topCategories.data ?? []) {
    const catName = (row as { issue_categories?: { name?: string } }).issue_categories?.name ?? 'Unknown'
    catCounts[catName] = (catCounts[catName] ?? 0) + 1
  }
  const sortedCats = Object.entries(catCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, count]) => ({ name, count }))

  const total = totalRes.count ?? 0
  const closed = closedRes.count ?? 0

  return buildSummary({
    total,
    open: openRes.count ?? 0,
    closed,
    criticalOpen: criticalRes.count ?? 0,
    stageCounts,
    topCategories: sortedCats,
  })
}

function buildSummary(input: {
  total: number
  open: number
  closed: number
  criticalOpen: number
  stageCounts: Record<string, number>
  topCategories: Array<{ name: string; count: number }>
}): ReportsSummary {
  const resolutionRate =
    input.total > 0 ? Math.round((input.closed / input.total) * 100) : 0
  return {
    ...input,
    resolutionRate,
  }
}
