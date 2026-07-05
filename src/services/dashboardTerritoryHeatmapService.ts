/**
 * Web dashboard — Telangana district heat map (counts per district).
 * Map-local controls only (metric + period); ignores dashboard territory/date filters.
 *
 * Ticket → district: roll up tickets.territory_id to district ancestor (level_order = 2).
 * Tickets with territory_id IS NULL are excluded (not counted on any district).
 */

import { createSupabaseServiceClient } from '@/lib/supabase.js'
import { isPostgresMode, dbQuery } from '@/lib/db.js'
import {
  DEFAULT_TERRITORY_STATE_NAME,
  getTerritoryPickerBootstrap,
  loadOrgTerritoryRowsCached,
} from '@/services/territoryService.js'
import type { DashboardWebScopeMeta } from '@/services/dashboardWebFiltersService.js'

export type HeatmapMetric = 'created' | 'closed' | 'open'
export type HeatmapPeriod = '30d' | '90d' | 'ytd'

export interface ResolvedDashboardWebHeatmapFilters {
  metric: HeatmapMetric
  period: HeatmapPeriod | null
  windowFrom: Date | null
  windowTo: Date | null
  windowFromStr: string | null
  windowToStr: string | null
  scope: DashboardWebScopeMeta
}

export type HeatmapFilterResult =
  | { ok: true; filters: ResolvedDashboardWebHeatmapFilters }
  | { ok: false; status: number; error: string }

export interface TerritoryHeatmapEntry {
  territory_id: string
  dt_code: string | null
  name: string
  count: number
}

export interface TerritoryHeatmapResponse {
  chart_type: 'territory_heatmap'
  metric: HeatmapMetric
  period: HeatmapPeriod | null
  level: 'district'
  entries: TerritoryHeatmapEntry[]
  meta: {
    organization_id: string
    generated_at: string
    state: string
    expected_districts: number
    window_from: string | null
    window_to: string | null
    timezone: 'UTC'
    null_territory_policy: 'excluded'
    scope: DashboardWebScopeMeta
  }
}

type TerritoryRow = {
  id: string
  name: string
  code: string | null
  parent_territory_id: string | null
  level_order: number
  level_label: string
}

type DistrictRow = {
  id: string
  name: string
  code: string | null
}

const DISTRICT_LEVEL_ORDER = 2
const OPEN_STAGES = ['to_do', 'in_progress', 'on_hold'] as const

function utcYmd(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function utcEndOfDay(date: Date): Date {
  return new Date(`${utcYmd(date)}T23:59:59.999Z`)
}

function utcStartOfDay(date: Date): Date {
  return new Date(`${utcYmd(date)}T00:00:00.000Z`)
}

function addUtcDays(date: Date, days: number): Date {
  const copy = new Date(date.getTime())
  copy.setUTCDate(copy.getUTCDate() + days)
  return copy
}

export function computeHeatmapWindow(
  metric: HeatmapMetric,
  period: HeatmapPeriod | null,
  reference = new Date(),
): { windowFrom: Date | null; windowTo: Date | null; windowFromStr: string | null; windowToStr: string | null } {
  if (metric === 'open') {
    return { windowFrom: null, windowTo: null, windowFromStr: null, windowToStr: null }
  }

  const today = new Date(
    Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), reference.getUTCDate()),
  )
  const windowTo = utcEndOfDay(today)
  const windowToStr = utcYmd(today)

  let windowFrom: Date
  if (period === 'ytd') {
    windowFrom = new Date(Date.UTC(today.getUTCFullYear(), 0, 1))
  } else if (period === '90d') {
    windowFrom = utcStartOfDay(addUtcDays(today, -89))
  } else {
    windowFrom = utcStartOfDay(addUtcDays(today, -29))
  }

  return {
    windowFrom,
    windowTo,
    windowFromStr: utcYmd(windowFrom),
    windowToStr,
  }
}

export function parseHeatmapMetric(raw: unknown): HeatmapMetric | null {
  if (raw === 'created' || raw === 'closed' || raw === 'open') return raw
  return null
}

export function parseHeatmapPeriod(raw: unknown): HeatmapPeriod | null {
  if (raw === '30d' || raw === '90d' || raw === 'ytd') return raw
  return null
}

export function resolveDashboardWebHeatmapFilters(
  roleName: string | null | undefined,
  query: Record<string, unknown>,
): HeatmapFilterResult {
  const role = roleName ?? ''

  if (query.territory_id !== undefined && query.territory_id !== null && String(query.territory_id).trim()) {
    return { ok: false, status: 400, error: 'territory_id is not supported on the heat map chart' }
  }
  if (query.from !== undefined && query.from !== null && String(query.from).trim()) {
    return { ok: false, status: 400, error: 'from and to are not supported on the heat map; use period instead' }
  }
  if (query.to !== undefined && query.to !== null && String(query.to).trim()) {
    return { ok: false, status: 400, error: 'from and to are not supported on the heat map; use period instead' }
  }
  if (
    query.include_descendants !== undefined &&
    query.include_descendants !== null &&
    String(query.include_descendants).trim()
  ) {
    return {
      ok: false,
      status: 400,
      error: 'include_descendants is not supported on the heat map chart',
    }
  }
  if (query.parent_id !== undefined && query.parent_id !== null && String(query.parent_id).trim()) {
    return { ok: false, status: 400, error: 'Use metric and period for the heat map, not parent_id' }
  }

  const metric = parseHeatmapMetric(query.metric)
  if (!metric) {
    return { ok: false, status: 400, error: 'metric is required (created, closed, or open)' }
  }

  let period: HeatmapPeriod | null = null
  if (metric !== 'open') {
    period = parseHeatmapPeriod(query.period)
    if (!period) {
      return { ok: false, status: 400, error: 'period is required for created/closed (30d, 90d, or ytd)' }
    }
  } else if (query.period !== undefined && query.period !== null && String(query.period).trim()) {
    period = parseHeatmapPeriod(query.period)
    if (!period) {
      return { ok: false, status: 400, error: 'period must be 30d, 90d, or ytd when provided' }
    }
  }

  const window = computeHeatmapWindow(metric, period)

  return {
    ok: true,
    filters: {
      metric,
      period,
      ...window,
      scope: { role, auto_scoped_territory_id: null },
    },
  }
}

function resolveTicketDistrictId(
  ticketTerritoryId: string,
  byId: Map<string, TerritoryRow>,
): string | null {
  let cur = byId.get(ticketTerritoryId)
  if (!cur) return null

  while (cur.level_order > DISTRICT_LEVEL_ORDER) {
    const parentId = cur.parent_territory_id
    if (!parentId) return null
    const parent = byId.get(parentId)
    if (!parent) return null
    cur = parent
  }

  if (cur.level_order !== DISTRICT_LEVEL_ORDER) return null
  return cur.id
}

function rollupTerritoryCounts(
  rows: Array<{ territory_id: string; count: number }>,
  territoryRows: TerritoryRow[],
): Map<string, number> {
  const byId = new Map(territoryRows.map((r) => [r.id, r]))
  const districtCounts = new Map<string, number>()

  for (const row of rows) {
    const districtId = resolveTicketDistrictId(row.territory_id, byId)
    if (!districtId) continue
    districtCounts.set(districtId, (districtCounts.get(districtId) ?? 0) + row.count)
  }

  return districtCounts
}

async function loadDistrictRows(orgId: string): Promise<DistrictRow[]> {
  const bootstrap = await getTerritoryPickerBootstrap(orgId)
  if (!bootstrap?.districts?.length) {
    return []
  }
  return bootstrap.districts.map((d) => ({
    id: d.id,
    name: d.name,
    code: d.code ?? null,
  }))
}

async function aggregateCreatedCountsPg(
  orgId: string,
  filters: ResolvedDashboardWebHeatmapFilters,
): Promise<Array<{ territory_id: string; count: number }>> {
  const res = await dbQuery<{ territory_id: string; c: string }>(
    `SELECT t.territory_id, COUNT(*)::text AS c
     FROM tickets t
     WHERE t.organization_id = $1
       AND t.territory_id IS NOT NULL
       AND t.created_at >= $2
       AND t.created_at <= $3
     GROUP BY t.territory_id`,
    [orgId, filters.windowFrom!.toISOString(), filters.windowTo!.toISOString()],
  )
  return res.rows.map((r) => ({ territory_id: r.territory_id, count: Number(r.c) }))
}

async function aggregateClosedCountsPg(
  orgId: string,
  filters: ResolvedDashboardWebHeatmapFilters,
): Promise<Array<{ territory_id: string; count: number }>> {
  const res = await dbQuery<{ territory_id: string; c: string }>(
    `SELECT t.territory_id, COUNT(*)::text AS c
     FROM tickets t
     WHERE t.organization_id = $1
       AND t.territory_id IS NOT NULL
       AND t.stage = 'closed'
       AND t.closed_at IS NOT NULL
       AND t.closed_at >= $2
       AND t.closed_at <= $3
     GROUP BY t.territory_id`,
    [orgId, filters.windowFrom!.toISOString(), filters.windowTo!.toISOString()],
  )
  return res.rows.map((r) => ({ territory_id: r.territory_id, count: Number(r.c) }))
}

async function aggregateOpenCountsPg(
  orgId: string,
): Promise<Array<{ territory_id: string; count: number }>> {
  const res = await dbQuery<{ territory_id: string; c: string }>(
    `SELECT t.territory_id, COUNT(*)::text AS c
     FROM tickets t
     WHERE t.organization_id = $1
       AND t.territory_id IS NOT NULL
       AND t.stage = ANY($2::text[])
     GROUP BY t.territory_id`,
    [orgId, [...OPEN_STAGES]],
  )
  return res.rows.map((r) => ({ territory_id: r.territory_id, count: Number(r.c) }))
}

async function aggregateCountsSupabase(
  orgId: string,
  filters: ResolvedDashboardWebHeatmapFilters,
): Promise<Array<{ territory_id: string; count: number }>> {
  const supabase = createSupabaseServiceClient()

  if (filters.metric === 'created') {
    const { data } = await supabase
      .from('tickets')
      .select('territory_id')
      .eq('organization_id', orgId)
      .not('territory_id', 'is', null)
      .gte('created_at', filters.windowFrom!.toISOString())
      .lte('created_at', filters.windowTo!.toISOString())
    return countByTerritory(data)
  }

  if (filters.metric === 'closed') {
    const { data } = await supabase
      .from('tickets')
      .select('territory_id')
      .eq('organization_id', orgId)
      .not('territory_id', 'is', null)
      .eq('stage', 'closed')
      .not('closed_at', 'is', null)
      .gte('closed_at', filters.windowFrom!.toISOString())
      .lte('closed_at', filters.windowTo!.toISOString())
    return countByTerritory(data)
  }

  const { data } = await supabase
    .from('tickets')
    .select('territory_id')
    .eq('organization_id', orgId)
    .not('territory_id', 'is', null)
    .in('stage', [...OPEN_STAGES])
  return countByTerritory(data)
}

function countByTerritory(
  rows: Array<{ territory_id: string | null }> | null,
): Array<{ territory_id: string; count: number }> {
  const counts = new Map<string, number>()
  for (const row of rows ?? []) {
    const tid = row.territory_id
    if (!tid) continue
    counts.set(tid, (counts.get(tid) ?? 0) + 1)
  }
  return [...counts.entries()].map(([territory_id, count]) => ({ territory_id, count }))
}

async function aggregateTerritoryCounts(
  orgId: string,
  filters: ResolvedDashboardWebHeatmapFilters,
): Promise<Array<{ territory_id: string; count: number }>> {
  if (isPostgresMode()) {
    if (filters.metric === 'created') return aggregateCreatedCountsPg(orgId, filters)
    if (filters.metric === 'closed') return aggregateClosedCountsPg(orgId, filters)
    return aggregateOpenCountsPg(orgId)
  }
  return aggregateCountsSupabase(orgId, filters)
}

export async function getTerritoryHeatmapChart(
  orgId: string,
  filters: ResolvedDashboardWebHeatmapFilters,
): Promise<TerritoryHeatmapResponse> {
  const [districts, territoryRows, territoryCounts] = await Promise.all([
    loadDistrictRows(orgId),
    loadOrgTerritoryRowsCached(orgId),
    aggregateTerritoryCounts(orgId, filters),
  ])

  const districtCounts = rollupTerritoryCounts(territoryCounts, territoryRows)

  const entries: TerritoryHeatmapEntry[] = districts.map((district) => ({
    territory_id: district.id,
    dt_code: district.code,
    name: district.name,
    count: districtCounts.get(district.id) ?? 0,
  }))

  return {
    chart_type: 'territory_heatmap',
    metric: filters.metric,
    period: filters.period,
    level: 'district',
    entries,
    meta: {
      organization_id: orgId,
      generated_at: new Date().toISOString(),
      state: DEFAULT_TERRITORY_STATE_NAME,
      expected_districts: districts.length,
      window_from: filters.windowFromStr,
      window_to: filters.windowToStr,
      timezone: 'UTC',
      null_territory_policy: 'excluded',
      scope: filters.scope,
    },
  }
}
