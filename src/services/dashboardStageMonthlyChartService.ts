/**
 * Web dashboard — tickets by pipeline stage over past calendar months.
 * Month-end snapshot: stage from latest ticket_stage_history row at each month boundary.
 * Territory scoped only; ignores dashboard date picker.
 */

import { createSupabaseServiceClient } from '@/lib/supabase.js'
import { isPostgresMode, dbQuery } from '@/lib/db.js'
import type { TicketStage } from '@/types/database.js'
import {
  buildDashboardWebTerritoryMeta,
  buildDashboardWebTerritorySqlClause,
  type ResolvedDashboardWebTerritoryFilters,
} from '@/services/dashboardWebFiltersService.js'
import { buildUtcMonthWindows } from '@/services/dashboardCategoryMonthlyChartService.js'
import {
  TICKET_STAGE_LABELS,
  TICKET_STAGE_SEGMENT_ORDER,
} from '@/services/dashboardRegionStageChartService.js'

export interface StageMonthlySegment {
  key: TicketStage
  label: string
  count: number
}

export interface StageMonthlyBucket {
  key: string
  label: string
  from: string
  to: string
  total: number
  segments: StageMonthlySegment[]
}

export interface StageMonthlyChartResponse {
  chart_type: 'grouped_bar_time'
  dimension: 'stage'
  title: string
  segment_order: TicketStage[]
  segments_meta: Array<{ key: TicketStage; label: string }>
  months: StageMonthlyBucket[]
  total: number
  meta: ReturnType<typeof buildDashboardWebTerritoryMeta>
}

interface RawMonthlyStageRow {
  month_key: string
  stage: TicketStage
  count: number
}

const STAGE_SET = new Set<string>(TICKET_STAGE_SEGMENT_ORDER)

function normalizeStage(raw: string | null | undefined): TicketStage {
  if (raw && STAGE_SET.has(raw)) {
    return raw as TicketStage
  }
  return 'to_do'
}

function emptyStageCounts(): Map<TicketStage, number> {
  return new Map(TICKET_STAGE_SEGMENT_ORDER.map((stage) => [stage, 0]))
}

function buildStageSegments(counts: Map<TicketStage, number>): StageMonthlySegment[] {
  return TICKET_STAGE_SEGMENT_ORDER.map((stage) => ({
    key: stage,
    label: TICKET_STAGE_LABELS[stage],
    count: counts.get(stage) ?? 0,
  }))
}

function buildMonthBuckets(
  windows: ReturnType<typeof buildUtcMonthWindows>,
  rows: RawMonthlyStageRow[],
): StageMonthlyBucket[] {
  return windows.map((window) => {
    const counts = emptyStageCounts()
    for (const row of rows) {
      if (row.month_key !== window.key) continue
      counts.set(row.stage, (counts.get(row.stage) ?? 0) + row.count)
    }
    const segments = buildStageSegments(counts)
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
}

async function aggregateMonthlyStageSnapshotsPg(
  orgId: string,
  resolved: ResolvedDashboardWebTerritoryFilters,
  windows: ReturnType<typeof buildUtcMonthWindows>,
): Promise<RawMonthlyStageRow[]> {
  const territoryParamIndex = 2
  const territory = buildDashboardWebTerritorySqlClause(resolved, 't', territoryParamIndex)
  if (territory.clause === 'FALSE') {
    return []
  }

  const monthParamStart = territoryParamIndex + territory.params.length
  const monthValues = windows
    .map(
      (_, index) =>
        `($${monthParamStart + index * 2}::text, $${monthParamStart + index * 2 + 1}::timestamptz)`,
    )
    .join(', ')

  const params: unknown[] = [orgId, ...territory.params]
  for (const window of windows) {
    params.push(window.key, window.createdTo.toISOString())
  }

  const res = await dbQuery<{ month_key: string; stage: string; c: string }>(
    `WITH month_windows AS (
       SELECT * FROM (VALUES ${monthValues}) AS m(month_key, snapshot_end)
     ),
     ticket_snapshots AS (
       SELECT
         mw.month_key,
         CASE
           WHEN COALESCE(latest.to_stage, 'to_do') IN ('to_do', 'in_progress', 'on_hold', 'closed')
             THEN COALESCE(latest.to_stage, 'to_do')
           ELSE 'to_do'
         END AS stage
       FROM month_windows mw
       INNER JOIN tickets t
         ON t.organization_id = $1
         AND t.created_at <= mw.snapshot_end
         AND ${territory.clause}
       LEFT JOIN LATERAL (
         SELECT h.to_stage
         FROM ticket_stage_history h
         WHERE h.ticket_id = t.id
           AND h.created_at <= mw.snapshot_end
         ORDER BY h.created_at DESC
         LIMIT 1
       ) latest ON true
     )
     SELECT month_key, stage, COUNT(*)::text AS c
     FROM ticket_snapshots
     GROUP BY month_key, stage
     ORDER BY month_key ASC, stage ASC`,
    params,
  )

  return res.rows.map((row) => ({
    month_key: row.month_key,
    stage: normalizeStage(row.stage),
    count: Number(row.c),
  }))
}

async function aggregateMonthlyStageSnapshotsSupabase(
  orgId: string,
  resolved: ResolvedDashboardWebTerritoryFilters,
  windows: ReturnType<typeof buildUtcMonthWindows>,
): Promise<RawMonthlyStageRow[]> {
  if (resolved.territoryIds.length === 0 && !resolved.includeNullTerritory) {
    return []
  }

  const supabase = createSupabaseServiceClient()
  const { data: tickets } = await supabase
    .from('tickets')
    .select('id, created_at, territory_id')
    .eq('organization_id', orgId)

  const territorySet = new Set(resolved.territoryIds)
  const scopedTicketIds: string[] = []

  for (const ticket of tickets ?? []) {
    const tid = ticket.territory_id as string | null
    const inTerritory =
      (resolved.includeNullTerritory && tid == null) ||
      (tid != null && territorySet.has(tid))
    if (inTerritory) {
      scopedTicketIds.push(ticket.id as string)
    }
  }

  if (scopedTicketIds.length === 0) {
    return []
  }

  const { data: historyRows } = await supabase
    .from('ticket_stage_history')
    .select('ticket_id, to_stage, created_at')
    .in('ticket_id', scopedTicketIds)
    .order('created_at', { ascending: true })

  const historyByTicket = new Map<string, Array<{ to_stage: string; created_at: string }>>()
  for (const row of historyRows ?? []) {
    const ticketId = row.ticket_id as string
    const list = historyByTicket.get(ticketId) ?? []
    list.push({
      to_stage: row.to_stage as string,
      created_at: row.created_at as string,
    })
    historyByTicket.set(ticketId, list)
  }

  const ticketCreatedAt = new Map(
    (tickets ?? [])
      .filter((t) => scopedTicketIds.includes(t.id as string))
      .map((t) => [t.id as string, new Date(t.created_at as string).getTime()]),
  )

  const counts = new Map<string, RawMonthlyStageRow>()

  for (const window of windows) {
    const snapshotEndMs = window.createdTo.getTime()
    for (const ticketId of scopedTicketIds) {
      const createdMs = ticketCreatedAt.get(ticketId)
      if (createdMs == null || createdMs > snapshotEndMs) continue

      const history = historyByTicket.get(ticketId) ?? []
      let stage: TicketStage = 'to_do'
      for (let i = history.length - 1; i >= 0; i -= 1) {
        const entry = history[i]!
        if (new Date(entry.created_at).getTime() <= snapshotEndMs) {
          stage = normalizeStage(entry.to_stage)
          break
        }
      }

      const mapKey = `${window.key}::${stage}`
      const existing = counts.get(mapKey)
      if (existing) {
        existing.count += 1
      } else {
        counts.set(mapKey, { month_key: window.key, stage, count: 1 })
      }
    }
  }

  return [...counts.values()]
}

export async function getStageMonthlyChart(
  orgId: string,
  resolved: ResolvedDashboardWebTerritoryFilters,
): Promise<StageMonthlyChartResponse> {
  const windows = buildUtcMonthWindows(resolved.monthCount)
  const rows = isPostgresMode()
    ? await aggregateMonthlyStageSnapshotsPg(orgId, resolved, windows)
    : await aggregateMonthlyStageSnapshotsSupabase(orgId, resolved, windows)

  const months = buildMonthBuckets(windows, rows)
  const total = months.reduce((sum, month) => sum + month.total, 0)
  const endMonth = windows[windows.length - 1]?.key ?? ''

  const segments_meta = TICKET_STAGE_SEGMENT_ORDER.map((stage) => ({
    key: stage,
    label: TICKET_STAGE_LABELS[stage],
  }))

  return {
    chart_type: 'grouped_bar_time',
    dimension: 'stage',
    title: 'Tickets by stage over time',
    segment_order: [...TICKET_STAGE_SEGMENT_ORDER],
    segments_meta,
    months,
    total,
    meta: buildDashboardWebTerritoryMeta(
      orgId,
      resolved,
      {
        end_month: endMonth,
        aggregation: 'month_end_snapshot',
      },
      { omitLimit: true },
    ),
  }
}
