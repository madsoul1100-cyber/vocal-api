/**
 * Stacked bar chart — top territories by ticket count, stacked by current stage.
 *
 * Stage counts reflect each ticket's **current** `stage` at query time (not stage at creation).
 * Tickets with `territory_id IS NULL` are excluded from region ranking.
 */

import { createSupabaseServiceClient } from '@/lib/supabase.js'
import { isPostgresMode, dbQuery } from '@/lib/db.js'
import type { TicketStage } from '@/types/database.js'
import { loadOrgTerritoryRowsCached } from '@/services/territoryService.js'
import {
  buildDashboardWebMeta,
  type ResolvedDashboardWebFilters,
} from '@/services/dashboardWebFiltersService.js'

export const TICKET_STAGE_SEGMENT_ORDER: TicketStage[] = [
  'to_do',
  'in_progress',
  'on_hold',
  'closed',
]

export const TICKET_STAGE_LABELS: Record<TicketStage, string> = {
  to_do: 'To do',
  in_progress: 'In progress',
  on_hold: 'On hold',
  closed: 'Closed',
}

type BarTerritoryLevel = 'district' | 'mandal' | 'ward'

export interface RegionStageSegment {
  key: TicketStage
  label: string
  count: number
}

export interface RegionStageCategory {
  territory_id: string
  label: string
  level: BarTerritoryLevel
  total: number
  segments: RegionStageSegment[]
}

export interface RegionStageChartResponse {
  chart_type: 'stacked_bar'
  dimension: 'ticket_stage'
  territory_level: BarTerritoryLevel
  title: string
  total: number
  segment_order: TicketStage[]
  categories: RegionStageCategory[]
  meta: ReturnType<typeof buildDashboardWebMeta>
}

interface RawTicketTerritoryStageRow {
  territory_id: string
  stage: string
  count: number
}

type TerritoryRow = {
  id: string
  name: string
  parent_territory_id: string | null
  level_order: number
  level_label: string
}

const LEVEL_ORDER_BY_BAR: Record<BarTerritoryLevel, number> = {
  district: 2,
  mandal: 3,
  ward: 4,
}

function normalizeStage(raw: string | null | undefined): TicketStage {
  if (raw && (TICKET_STAGE_SEGMENT_ORDER as readonly string[]).includes(raw)) {
    return raw as TicketStage
  }
  return 'to_do'
}

function resolveBarTerritoryLevel(resolved: ResolvedDashboardWebFilters): BarTerritoryLevel {
  if (!resolved.rawTerritoryId) return 'district'
  const filterLevel = resolved.territory.territory_level
  if (filterLevel === 'district') return 'mandal'
  if (filterLevel === 'mandal') return 'ward'
  if (filterLevel === 'ward') return 'ward'
  return 'district'
}

function resolveRankAnchorId(resolved: ResolvedDashboardWebFilters): string | null {
  if (resolved.rawTerritoryId) return resolved.rawTerritoryId
  return resolved.territory.territory_id || null
}

function isUnderAncestor(
  nodeId: string,
  ancestorId: string,
  byId: Map<string, TerritoryRow>,
): boolean {
  let cur: string | null = nodeId
  while (cur) {
    if (cur === ancestorId) return true
    cur = byId.get(cur)?.parent_territory_id ?? null
  }
  return false
}

function resolveTicketRegionId(
  ticketTerritoryId: string,
  targetLevelOrder: number,
  anchorId: string | null,
  byId: Map<string, TerritoryRow>,
): string | null {
  if (
    anchorId &&
    ticketTerritoryId !== anchorId &&
    !isUnderAncestor(ticketTerritoryId, anchorId, byId)
  ) {
    return null
  }

  let cur = byId.get(ticketTerritoryId)
  if (!cur) return null

  while (cur.level_order > targetLevelOrder) {
    const parentId = cur.parent_territory_id
    if (!parentId) return null
    const parent = byId.get(parentId)
    if (!parent) return null
    cur = parent
  }

  if (cur.level_order !== targetLevelOrder) return null
  if (anchorId && cur.id !== anchorId && !isUnderAncestor(cur.id, anchorId, byId)) {
    return null
  }

  return cur.id
}

async function fetchTicketTerritoryStageCountsPg(
  orgId: string,
  resolved: ResolvedDashboardWebFilters,
): Promise<RawTicketTerritoryStageRow[]> {
  const { dateRange, territoryIds } = resolved
  if (territoryIds.length === 0) return []

  const res = await dbQuery<{ territory_id: string; stage: string; c: string }>(
    `SELECT t.territory_id, t.stage, COUNT(*)::text AS c
     FROM tickets t
     WHERE t.organization_id = $1
       AND t.created_at >= $2
       AND t.created_at <= $3
       AND t.territory_id IS NOT NULL
       AND t.territory_id = ANY($4::uuid[])
     GROUP BY t.territory_id, t.stage`,
    [
      orgId,
      dateRange.createdFrom.toISOString(),
      dateRange.createdTo.toISOString(),
      territoryIds,
    ],
  )

  return res.rows.map((r) => ({
    territory_id: r.territory_id,
    stage: r.stage,
    count: Number(r.c),
  }))
}

async function fetchTicketTerritoryStageCountsSupabase(
  orgId: string,
  resolved: ResolvedDashboardWebFilters,
): Promise<RawTicketTerritoryStageRow[]> {
  const { dateRange, territoryIds } = resolved
  if (territoryIds.length === 0) return []

  const supabase = createSupabaseServiceClient()
  const territorySet = new Set(territoryIds)
  const { data } = await supabase
    .from('tickets')
    .select('territory_id, stage')
    .eq('organization_id', orgId)
    .gte('created_at', dateRange.createdFrom.toISOString())
    .lte('created_at', dateRange.createdTo.toISOString())
    .not('territory_id', 'is', null)

  const counts = new Map<string, number>()
  for (const row of data ?? []) {
    const tid = row.territory_id as string | null
    if (!tid || !territorySet.has(tid)) continue
    const stage = normalizeStage(row.stage as string)
    const key = `${tid}\0${stage}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }

  return [...counts.entries()].map(([key, count]) => {
    const [territory_id, stage] = key.split('\0')
    return { territory_id: territory_id!, stage, count }
  })
}

function rollupToRegions(
  rows: RawTicketTerritoryStageRow[],
  resolved: ResolvedDashboardWebFilters,
  barLevel: BarTerritoryLevel,
  territoryRows: TerritoryRow[],
): Map<string, Map<TicketStage, number>> {
  const byId = new Map(territoryRows.map((r) => [r.id, r]))
  const targetOrder = LEVEL_ORDER_BY_BAR[barLevel]
  const anchorId = resolveRankAnchorId(resolved)
  const regionCounts = new Map<string, Map<TicketStage, number>>()

  for (const row of rows) {
    const regionId = resolveTicketRegionId(row.territory_id, targetOrder, anchorId, byId)
    if (!regionId) continue

    const stage = normalizeStage(row.stage)
    if (!regionCounts.has(regionId)) {
      regionCounts.set(regionId, new Map())
    }
    const stageMap = regionCounts.get(regionId)!
    stageMap.set(stage, (stageMap.get(stage) ?? 0) + row.count)
  }

  return regionCounts
}

function buildCategories(
  regionCounts: Map<string, Map<TicketStage, number>>,
  barLevel: BarTerritoryLevel,
  limit: number,
  territoryRows: TerritoryRow[],
): RegionStageCategory[] {
  const byId = new Map(territoryRows.map((r) => [r.id, r]))

  const ranked = [...regionCounts.entries()]
    .map(([territoryId, stageMap]) => {
      const total = [...stageMap.values()].reduce((sum, n) => sum + n, 0)
      return { territoryId, stageMap, total }
    })
    .sort((a, b) => b.total - a.total || a.territoryId.localeCompare(b.territoryId))
    .slice(0, limit)

  return ranked.map(({ territoryId, stageMap, total }) => {
    const node = byId.get(territoryId)
    const segments = TICKET_STAGE_SEGMENT_ORDER.map((key) => ({
      key,
      label: TICKET_STAGE_LABELS[key],
      count: stageMap.get(key) ?? 0,
    }))

    return {
      territory_id: territoryId,
      label: node?.name ?? 'Unknown',
      level: barLevel,
      total,
      segments,
    }
  })
}

export async function getRegionStageChart(
  orgId: string,
  resolved: ResolvedDashboardWebFilters,
): Promise<RegionStageChartResponse> {
  const barLevel = resolveBarTerritoryLevel(resolved)
  const rows = isPostgresMode()
    ? await fetchTicketTerritoryStageCountsPg(orgId, resolved)
    : await fetchTicketTerritoryStageCountsSupabase(orgId, resolved)

  const territoryRows = await loadOrgTerritoryRowsCached(orgId)
  const regionCounts = rollupToRegions(rows, resolved, barLevel, territoryRows)
  const categories = buildCategories(
    regionCounts,
    barLevel,
    resolved.segmentLimit,
    territoryRows,
  )

  const total = categories.reduce((sum, c) => sum + c.total, 0)

  return {
    chart_type: 'stacked_bar',
    dimension: 'ticket_stage',
    territory_level: barLevel,
    title: 'Top regions by tickets',
    total,
    segment_order: [...TICKET_STAGE_SEGMENT_ORDER],
    categories,
    meta: buildDashboardWebMeta(orgId, resolved),
  }
}
