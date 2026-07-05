/**
 * Web leadership dashboard KPI row — filtered top metrics.
 *
 * - tickets_created / tickets_closed: territory + date window (matches category chart population)
 * - open_pipeline / needs_action: current snapshot, territory scoped only
 * - Closed tickets: stage = 'closed' AND closed_at in range (not pending_closure_review queue)
 * - Null territory tickets: included on whole-state views (same as ticket-categories chart)
 */

import { createSupabaseServiceClient } from '@/lib/supabase.js'
import { isPostgresMode, dbQuery } from '@/lib/db.js'
import {
  buildDashboardWebMeta,
  buildDashboardWebTerritorySqlClause,
  computeDashboardWebTrend,
  computePreviousPeriod,
  type DashboardWebTrend,
  type ResolvedDashboardWebFilters,
} from '@/services/dashboardWebFiltersService.js'

export interface KpiPeriodMetric {
  count: number
  previous_count: number
  trend: DashboardWebTrend
}

export interface KpiSnapshotMetric {
  count: number
}

export interface KpiNeedsActionMetric extends KpiSnapshotMetric {
  breakdown: {
    awaiting_triage: number
    critical_open: number
    sla_breaches: number
    pending_closure_review: number
  }
}

export interface DashboardWebKpisResponse {
  chart_type: 'kpi_row'
  title: string
  metrics: {
    tickets_created: KpiPeriodMetric
    tickets_closed: KpiPeriodMetric
    open_pipeline: KpiSnapshotMetric
    needs_action: KpiNeedsActionMetric
  }
  meta: ReturnType<typeof buildDashboardWebMeta>
}

interface RawKpiCounts {
  tickets_created: number
  tickets_created_prev: number
  tickets_closed: number
  tickets_closed_prev: number
  open_pipeline: number
  awaiting_triage: number
  critical_open: number
  sla_breaches: number
  pending_closure_review: number
}

function emptyCounts(): RawKpiCounts {
  return {
    tickets_created: 0,
    tickets_created_prev: 0,
    tickets_closed: 0,
    tickets_closed_prev: 0,
    open_pipeline: 0,
    awaiting_triage: 0,
    critical_open: 0,
    sla_breaches: 0,
    pending_closure_review: 0,
  }
}

function mapRow(row: Record<string, string | number>): RawKpiCounts {
  const n = (key: string) => Number(row[key] ?? 0)
  return {
    tickets_created: n('tickets_created'),
    tickets_created_prev: n('tickets_created_prev'),
    tickets_closed: n('tickets_closed'),
    tickets_closed_prev: n('tickets_closed_prev'),
    open_pipeline: n('open_pipeline'),
    awaiting_triage: n('awaiting_triage'),
    critical_open: n('critical_open'),
    sla_breaches: n('sla_breaches'),
    pending_closure_review: n('pending_closure_review'),
  }
}

async function loadKpisPg(
  orgId: string,
  resolved: ResolvedDashboardWebFilters,
  previous: ReturnType<typeof computePreviousPeriod>,
): Promise<RawKpiCounts> {
  const territory = buildDashboardWebTerritorySqlClause(resolved, 't', 4)
  if (territory.clause === 'FALSE') {
    return emptyCounts()
  }

  const { dateRange } = resolved
  const prevFromIdx = 4 + territory.params.length
  const prevToIdx = prevFromIdx + 1
  const params = [
    orgId,
    dateRange.createdFrom.toISOString(),
    dateRange.createdTo.toISOString(),
    ...territory.params,
    previous.createdFrom.toISOString(),
    previous.createdTo.toISOString(),
  ]

  const res = await dbQuery<Record<string, string>>(
    `SELECT
       COUNT(*) FILTER (
         WHERE t.created_at >= $2 AND t.created_at <= $3
       )::text AS tickets_created,
       COUNT(*) FILTER (
         WHERE t.created_at >= $${prevFromIdx} AND t.created_at <= $${prevToIdx}
       )::text AS tickets_created_prev,
       COUNT(*) FILTER (
         WHERE t.stage = 'closed'
           AND t.closed_at IS NOT NULL
           AND t.closed_at >= $2 AND t.closed_at <= $3
       )::text AS tickets_closed,
       COUNT(*) FILTER (
         WHERE t.stage = 'closed'
           AND t.closed_at IS NOT NULL
           AND t.closed_at >= $${prevFromIdx} AND t.closed_at <= $${prevToIdx}
       )::text AS tickets_closed_prev,
       COUNT(*) FILTER (
         WHERE t.stage IN ('to_do', 'in_progress', 'on_hold')
       )::text AS open_pipeline,
       COUNT(*) FILTER (WHERE t.needs_triage = true)::text AS awaiting_triage,
       COUNT(*) FILTER (
         WHERE t.critical_flag = true AND t.stage <> 'closed'
       )::text AS critical_open,
       COUNT(*) FILTER (
         WHERE t.sub_status = 'sla_breach_escalation_queue'
       )::text AS sla_breaches,
       COUNT(*) FILTER (WHERE t.needs_closure_review = true)::text AS pending_closure_review
     FROM tickets t
     WHERE t.organization_id = $1
       AND ${territory.clause}`,
    params,
  )

  return mapRow(res.rows[0] ?? {})
}

function ticketMatchesTerritory(
  territoryId: string | null,
  resolved: ResolvedDashboardWebFilters,
): boolean {
  const { territoryIds, includeNullTerritory } = resolved
  if (territoryIds.length === 0 && !includeNullTerritory) return false
  if (territoryId == null) return includeNullTerritory
  return territoryIds.includes(territoryId)
}

async function loadKpisSupabase(
  orgId: string,
  resolved: ResolvedDashboardWebFilters,
  previous: ReturnType<typeof computePreviousPeriod>,
): Promise<RawKpiCounts> {
  if (resolved.territoryIds.length === 0 && !resolved.includeNullTerritory) {
    return emptyCounts()
  }

  const supabase = createSupabaseServiceClient()
  const { data: tickets } = await supabase
    .from('tickets')
    .select(
      'created_at, closed_at, stage, territory_id, needs_triage, critical_flag, sub_status, needs_closure_review',
    )
    .eq('organization_id', orgId)

  const counts = emptyCounts()
  const fromMs = resolved.dateRange.createdFrom.getTime()
  const toMs = resolved.dateRange.createdTo.getTime()
  const prevFromMs = previous.createdFrom.getTime()
  const prevToMs = previous.createdTo.getTime()

  for (const t of tickets ?? []) {
    if (!ticketMatchesTerritory(t.territory_id as string | null, resolved)) continue

    const createdAt = new Date(t.created_at as string).getTime()
    const closedAt = t.closed_at ? new Date(t.closed_at as string).getTime() : null
    const stage = t.stage as string

    if (createdAt >= fromMs && createdAt <= toMs) counts.tickets_created++
    if (createdAt >= prevFromMs && createdAt <= prevToMs) counts.tickets_created_prev++

    if (
      stage === 'closed' &&
      closedAt != null &&
      closedAt >= fromMs &&
      closedAt <= toMs
    ) {
      counts.tickets_closed++
    }
    if (
      stage === 'closed' &&
      closedAt != null &&
      closedAt >= prevFromMs &&
      closedAt <= prevToMs
    ) {
      counts.tickets_closed_prev++
    }

    if (stage === 'to_do' || stage === 'in_progress' || stage === 'on_hold') {
      counts.open_pipeline++
    }
    if (t.needs_triage === true) counts.awaiting_triage++
    if (t.critical_flag === true && stage !== 'closed') counts.critical_open++
    if (t.sub_status === 'sla_breach_escalation_queue') counts.sla_breaches++
    if (t.needs_closure_review === true) counts.pending_closure_review++
  }

  return counts
}

function buildResponse(
  orgId: string,
  resolved: ResolvedDashboardWebFilters,
  previous: ReturnType<typeof computePreviousPeriod>,
  raw: RawKpiCounts,
): DashboardWebKpisResponse {
  const needsHeadline =
    raw.awaiting_triage + raw.critical_open + raw.sla_breaches

  return {
    chart_type: 'kpi_row',
    title: 'Dashboard KPIs',
    metrics: {
      tickets_created: {
        count: raw.tickets_created,
        previous_count: raw.tickets_created_prev,
        trend: computeDashboardWebTrend(raw.tickets_created, raw.tickets_created_prev),
      },
      tickets_closed: {
        count: raw.tickets_closed,
        previous_count: raw.tickets_closed_prev,
        trend: computeDashboardWebTrend(raw.tickets_closed, raw.tickets_closed_prev),
      },
      open_pipeline: {
        count: raw.open_pipeline,
      },
      needs_action: {
        count: needsHeadline,
        breakdown: {
          awaiting_triage: raw.awaiting_triage,
          critical_open: raw.critical_open,
          sla_breaches: raw.sla_breaches,
          pending_closure_review: raw.pending_closure_review,
        },
      },
    },
    meta: buildDashboardWebMeta(
      orgId,
      resolved,
      {
        previous_from: previous.previous_from,
        previous_to: previous.previous_to,
      },
      { omitLimit: true },
    ),
  }
}

export async function getDashboardWebKpis(
  orgId: string,
  resolved: ResolvedDashboardWebFilters,
): Promise<DashboardWebKpisResponse> {
  const previous = computePreviousPeriod(resolved.dateRange.from, resolved.dateRange.to)
  const raw = isPostgresMode()
    ? await loadKpisPg(orgId, resolved, previous)
    : await loadKpisSupabase(orgId, resolved, previous)

  return buildResponse(orgId, resolved, previous, raw)
}
