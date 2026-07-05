/**
 * Shared filters for GET /v2/dashboard/web/* chart endpoints.
 *
 * Ticket → territory: uses tickets.territory_id (ward/mandal/district node set at intake
 * or via territoryResolveService). A ticket matches a filter node when its territory_id
 * equals that node (include_descendants=false) or lies in the node's subtree
 * (include_descendants=true). Whole-state views also include tickets with territory_id IS NULL.
 */

import {
  DEFAULT_TERRITORY_STATE_NAME,
  getTerritoryDescendantIds,
  getTerritoryPickerBootstrap,
  loadOrgTerritoryRowsCached,
} from '@/services/territoryService.js'
import {
  isTerritoryNodeInScope,
  loadUserTerritoryScopeIds,
  shouldScopeTerritoryPicker,
} from '@/services/territoryScopeService.js'
import { canAccessTerritoryFilter } from '@/lib/roleHierarchy.js'

export const DASHBOARD_WEB_DEFAULT_SEGMENT_LIMIT = 8
export const DASHBOARD_WEB_MAX_SEGMENT_LIMIT = 20
export const DASHBOARD_WEB_DEFAULT_REGION_LIMIT = 5
export const DASHBOARD_WEB_MAX_REGION_LIMIT = 10
export const DASHBOARD_WEB_DEFAULT_LEADERBOARD_LIMIT = 10
export const DASHBOARD_WEB_MAX_LEADERBOARD_LIMIT = 20
export const DASHBOARD_WEB_DEFAULT_MONTH_COUNT = 6
export const DASHBOARD_WEB_MAX_MONTH_COUNT = 12

export interface DashboardWebChartActor {
  id: string
  organization_id: string
  roles?: { name: string } | null
}

export interface DashboardWebDateRange {
  from: string
  to: string
  createdFrom: Date
  createdTo: Date
}

export interface DashboardWebTerritoryFilter {
  territory_id: string
  territory_name: string
  territory_level: string
  include_descendants: boolean
}

export interface DashboardWebScopeMeta {
  role: string
  auto_scoped_territory_id: string | null
}

export interface ResolvedDashboardWebFilters {
  dateRange: DashboardWebDateRange
  territory: DashboardWebTerritoryFilter
  /** Territory UUID from query (null = whole state / auto-scoped). */
  rawTerritoryId: string | null
  segmentLimit: number
  scope: DashboardWebScopeMeta
  /** Ticket territory_id values that match the filter (empty = no matches). */
  territoryIds: string[]
  includeNullTerritory: boolean
}

/** Territory-only filters for charts that ignore the dashboard date picker. */
export interface ResolvedDashboardWebTerritoryFilters {
  territory: DashboardWebTerritoryFilter
  rawTerritoryId: string | null
  segmentLimit: number
  monthCount: number
  scope: DashboardWebScopeMeta
  territoryIds: string[]
  includeNullTerritory: boolean
}

export type DashboardWebFilterResult =
  | { ok: true; filters: ResolvedDashboardWebFilters }
  | { ok: false; status: number; error: string }

export type DashboardWebTerritoryFilterResult =
  | { ok: true; filters: ResolvedDashboardWebTerritoryFilters }
  | { ok: false; status: number; error: string }

function parseIsoDate(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  const s = raw.trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null
  const d = new Date(`${s}T00:00:00.000Z`)
  if (Number.isNaN(d.getTime())) return null
  return s
}

function parseBooleanQuery(value: unknown, defaultValue: boolean): boolean {
  if (value === undefined || value === null || value === '') return defaultValue
  if (value === 'true' || value === true || value === '1') return true
  if (value === 'false' || value === false || value === '0') return false
  return defaultValue
}

function territoryLevelKey(levelOrder: number, levelLabel: string): string {
  const label = levelLabel.trim().toLowerCase()
  if (label.includes('state')) return 'state'
  if (label.includes('district')) return 'district'
  if (label.includes('mandal')) return 'mandal'
  if (label.includes('ward')) return 'ward'
  if (label.includes('area')) return 'area'
  return `level_${levelOrder}`
}

async function resolveStateRootTerritoryId(orgId: string): Promise<string | null> {
  const bootstrap = await getTerritoryPickerBootstrap(orgId)
  return bootstrap?.state.id ?? null
}

async function loadTerritoryMeta(
  orgId: string,
  territoryId: string,
): Promise<{ name: string; territory_level: string } | null> {
  const rows = await loadOrgTerritoryRowsCached(orgId)
  const row = rows.find((r) => r.id === territoryId)
  if (!row) return null
  return {
    name: row.name,
    territory_level: territoryLevelKey(row.level_order, row.level_label),
  }
}

export function assertDashboardWebChartAccess(
  roleName: string | null | undefined,
): { ok: true } | { ok: false; status: number; error: string } {
  if (!canAccessTerritoryFilter(roleName)) {
    return { ok: false, status: 403, error: 'Insufficient role' }
  }
  return { ok: true }
}

interface TerritoryScopeInput {
  orgId: string
  role: string
  rawTerritoryId: string | null
  includeDescendants: boolean
}

interface TerritoryScopeResolved {
  filterTerritoryId: string
  territoryName: string
  territoryLevel: string
  autoScopedTerritoryId: string | null
  territoryIds: string[]
  includeNullTerritory: boolean
}

async function resolveTerritoryScope(
  actor: DashboardWebChartActor,
  input: TerritoryScopeInput,
): Promise<
  | { ok: true; scope: TerritoryScopeResolved }
  | { ok: false; status: number; error: string }
> {
  const { orgId, role, rawTerritoryId, includeDescendants } = input
  let autoScopedTerritoryId: string | null = null
  let filterTerritoryId = rawTerritoryId
  let territoryIds: string[] = []
  let includeNullTerritory = false

  if (shouldScopeTerritoryPicker(role)) {
    const scopeIds = await loadUserTerritoryScopeIds(orgId, actor.id)
    if (scopeIds.size === 0) {
      return {
        ok: true,
        scope: {
          filterTerritoryId: rawTerritoryId ?? '',
          territoryName: rawTerritoryId ? 'Unknown' : DEFAULT_TERRITORY_STATE_NAME,
          territoryLevel: rawTerritoryId ? 'unknown' : 'state',
          autoScopedTerritoryId: null,
          territoryIds: [],
          includeNullTerritory: false,
        },
      }
    }

    if (filterTerritoryId) {
      const rows = await loadOrgTerritoryRowsCached(orgId)
      if (!isTerritoryNodeInScope(filterTerritoryId, scopeIds, rows)) {
        return {
          ok: false,
          status: 403,
          error: 'Territory not in your assigned scope',
        }
      }
      territoryIds = includeDescendants
        ? await getTerritoryDescendantIds(orgId, filterTerritoryId, true)
        : [filterTerritoryId]
    } else {
      territoryIds = [...scopeIds]
      autoScopedTerritoryId = null
      const stateId = await resolveStateRootTerritoryId(orgId)
      filterTerritoryId = stateId ?? [...scopeIds][0]!
    }
  } else {
    if (!filterTerritoryId) {
      filterTerritoryId = (await resolveStateRootTerritoryId(orgId)) ?? ''
      includeNullTerritory = true
    }
    if (!filterTerritoryId) {
      return {
        ok: false,
        status: 404,
        error: 'Telangana territory data not found. Run npm run seed:territories in vocal-api.',
      }
    }
    territoryIds = includeDescendants
      ? await getTerritoryDescendantIds(orgId, filterTerritoryId, true)
      : [filterTerritoryId]
    if (!rawTerritoryId) {
      includeNullTerritory = true
    }
  }

  const meta = filterTerritoryId
    ? await loadTerritoryMeta(orgId, filterTerritoryId)
    : null

  return {
    ok: true,
    scope: {
      filterTerritoryId,
      territoryName: meta?.name ?? DEFAULT_TERRITORY_STATE_NAME,
      territoryLevel: meta?.territory_level ?? 'state',
      autoScopedTerritoryId,
      territoryIds,
      includeNullTerritory,
    },
  }
}

export async function resolveDashboardWebTerritoryChartFilters(
  actor: DashboardWebChartActor,
  query: Record<string, unknown>,
  options?: { defaultLimit?: number; maxLimit?: number; defaultMonths?: number; maxMonths?: number },
): Promise<DashboardWebTerritoryFilterResult> {
  const defaultLimit = options?.defaultLimit ?? DASHBOARD_WEB_DEFAULT_SEGMENT_LIMIT
  const maxLimit = options?.maxLimit ?? DASHBOARD_WEB_MAX_SEGMENT_LIMIT
  const defaultMonths = options?.defaultMonths ?? DASHBOARD_WEB_DEFAULT_MONTH_COUNT
  const maxMonths = options?.maxMonths ?? DASHBOARD_WEB_MAX_MONTH_COUNT
  const role = actor.roles?.name ?? ''

  if (query.from !== undefined && query.from !== null && String(query.from).trim()) {
    return {
      ok: false,
      status: 400,
      error: 'from and to are not supported on this chart; use months instead',
    }
  }
  if (query.to !== undefined && query.to !== null && String(query.to).trim()) {
    return {
      ok: false,
      status: 400,
      error: 'from and to are not supported on this chart; use months instead',
    }
  }
  if (query.parent_id !== undefined && query.parent_id !== null && String(query.parent_id).trim()) {
    return {
      ok: false,
      status: 400,
      error: 'Use territory_id for dashboard charts, not parent_id',
    }
  }

  const includeDescendants = parseBooleanQuery(query.include_descendants, true)

  let segmentLimit =
    parseInt(String(query.limit ?? defaultLimit), 10) || defaultLimit
  segmentLimit = Math.min(maxLimit, Math.max(1, segmentLimit))

  let monthCount =
    parseInt(String(query.months ?? defaultMonths), 10) || defaultMonths
  monthCount = Math.min(maxMonths, Math.max(1, monthCount))

  const orgId = actor.organization_id
  const rawTerritoryId =
    typeof query.territory_id === 'string' && query.territory_id.trim()
      ? query.territory_id.trim()
      : null

  const territory = await resolveTerritoryScope(actor, {
    orgId,
    role,
    rawTerritoryId,
    includeDescendants,
  })
  if (!territory.ok) {
    return territory
  }

  const { scope } = territory
  return {
    ok: true,
    filters: {
      territory: {
        territory_id: scope.filterTerritoryId,
        territory_name: scope.territoryName,
        territory_level: scope.territoryLevel,
        include_descendants: includeDescendants,
      },
      rawTerritoryId,
      segmentLimit,
      monthCount,
      scope: {
        role,
        auto_scoped_territory_id: scope.autoScopedTerritoryId,
      },
      territoryIds: scope.territoryIds,
      includeNullTerritory: scope.includeNullTerritory,
    },
  }
}

export async function resolveDashboardWebChartFilters(
  actor: DashboardWebChartActor,
  query: Record<string, unknown>,
  options?: { defaultLimit?: number; maxLimit?: number },
): Promise<DashboardWebFilterResult> {
  const defaultLimit = options?.defaultLimit ?? DASHBOARD_WEB_DEFAULT_SEGMENT_LIMIT
  const maxLimit = options?.maxLimit ?? DASHBOARD_WEB_MAX_SEGMENT_LIMIT
  const role = actor.roles?.name ?? ''

  if (query.parent_id !== undefined && query.parent_id !== null && String(query.parent_id).trim()) {
    return {
      ok: false,
      status: 400,
      error: 'Use territory_id for dashboard charts, not parent_id',
    }
  }

  const from = parseIsoDate(query.from)
  const to = parseIsoDate(query.to)
  if (!from || !to) {
    return {
      ok: false,
      status: 400,
      error: 'from and to are required as ISO dates (YYYY-MM-DD)',
    }
  }
  if (from > to) {
    return { ok: false, status: 400, error: 'from must be on or before to' }
  }

  const includeDescendants = parseBooleanQuery(query.include_descendants, true)

  let segmentLimit =
    parseInt(String(query.limit ?? defaultLimit), 10) || defaultLimit
  segmentLimit = Math.min(maxLimit, Math.max(1, segmentLimit))

  const orgId = actor.organization_id
  const rawTerritoryId =
    typeof query.territory_id === 'string' && query.territory_id.trim()
      ? query.territory_id.trim()
      : null

  const territory = await resolveTerritoryScope(actor, {
    orgId,
    role,
    rawTerritoryId,
    includeDescendants,
  })
  if (!territory.ok) {
    return territory
  }

  const { scope } = territory
  return {
    ok: true,
    filters: buildResolvedFilters({
      orgId,
      role,
      from,
      to,
      rawTerritoryId,
      segmentLimit,
      includeDescendants,
      territoryId: scope.filterTerritoryId,
      territoryName: scope.territoryName,
      territoryLevel: scope.territoryLevel,
      autoScopedTerritoryId: scope.autoScopedTerritoryId,
      territoryIds: scope.territoryIds,
      includeNullTerritory: scope.includeNullTerritory,
    }),
  }
}

function buildResolvedFilters(input: {
  orgId: string
  role: string
  from: string
  to: string
  rawTerritoryId: string | null
  segmentLimit: number
  includeDescendants: boolean
  territoryId: string
  territoryName: string
  territoryLevel: string
  autoScopedTerritoryId: string | null
  territoryIds: string[]
  includeNullTerritory: boolean
}): ResolvedDashboardWebFilters {
  return {
    dateRange: {
      from: input.from,
      to: input.to,
      createdFrom: new Date(`${input.from}T00:00:00.000Z`),
      createdTo: new Date(`${input.to}T23:59:59.999Z`),
    },
    territory: {
      territory_id: input.territoryId,
      territory_name: input.territoryName,
      territory_level: input.territoryLevel,
      include_descendants: input.includeDescendants,
    },
    rawTerritoryId: input.rawTerritoryId,
    segmentLimit: input.segmentLimit,
    scope: {
      role: input.role,
      auto_scoped_territory_id: input.autoScopedTerritoryId,
    },
    territoryIds: input.territoryIds,
    includeNullTerritory: input.includeNullTerritory,
  }
}

export function buildDashboardWebMeta(
  orgId: string,
  resolved: ResolvedDashboardWebFilters,
  extraFilters?: Record<string, unknown>,
  options?: { omitLimit?: boolean },
) {
  const echoTerritory = resolved.rawTerritoryId
    ? {
        territory_id: resolved.territory.territory_id,
        territory_name: resolved.territory.territory_name,
        territory_level: resolved.territory.territory_level,
      }
    : {
        territory_id: null,
        territory_name: null,
        territory_level: null,
      }

  const filters: Record<string, unknown> = {
    ...echoTerritory,
    include_descendants: resolved.territory.include_descendants,
    from: resolved.dateRange.from,
    to: resolved.dateRange.to,
    ...extraFilters,
  }
  if (!options?.omitLimit) {
    filters.limit = resolved.segmentLimit
  }

  return {
    organization_id: orgId,
    generated_at: new Date().toISOString(),
    filters,
    scope: resolved.scope,
  }
}

export function buildDashboardWebTerritoryMeta(
  orgId: string,
  resolved: ResolvedDashboardWebTerritoryFilters,
  extraFilters?: Record<string, unknown>,
  options?: { omitLimit?: boolean },
) {
  const echoTerritory = resolved.rawTerritoryId
    ? {
        territory_id: resolved.territory.territory_id,
        territory_name: resolved.territory.territory_name,
        territory_level: resolved.territory.territory_level,
      }
    : {
        territory_id: null,
        territory_name: null,
        territory_level: null,
      }

  const filters: Record<string, unknown> = {
    ...echoTerritory,
    include_descendants: resolved.territory.include_descendants,
    months: resolved.monthCount,
    timezone: 'UTC',
    ...extraFilters,
  }
  if (!options?.omitLimit) {
    filters.limit = resolved.segmentLimit
  }

  return {
    organization_id: orgId,
    generated_at: new Date().toISOString(),
    filters,
    scope: resolved.scope,
  }
}

/** SQL territory predicate for tickets alias (e.g. `t`). Returns FALSE when no IDs and no null allowance. */
export function buildDashboardWebTerritorySqlClause(
  resolved: Pick<ResolvedDashboardWebFilters, 'territoryIds' | 'includeNullTerritory'>,
  alias: string,
  paramIndex: number,
): { clause: string; params: unknown[] } {
  const { territoryIds, includeNullTerritory } = resolved
  if (territoryIds.length === 0 && !includeNullTerritory) {
    return { clause: 'FALSE', params: [] }
  }
  if (territoryIds.length === 0) {
    return { clause: `${alias}.territory_id IS NULL`, params: [] }
  }
  if (includeNullTerritory) {
    return {
      clause: `(${alias}.territory_id IS NULL OR ${alias}.territory_id = ANY($${paramIndex}::uuid[]))`,
      params: [territoryIds],
    }
  }
  return {
    clause: `${alias}.territory_id = ANY($${paramIndex}::uuid[])`,
    params: [territoryIds],
  }
}

export interface DashboardWebPreviousPeriod {
  previous_from: string
  previous_to: string
  createdFrom: Date
  createdTo: Date
}

/** Same-length calendar window immediately before `from`. */
export function computePreviousPeriod(from: string, to: string): DashboardWebPreviousPeriod {
  const fromDate = new Date(`${from}T00:00:00.000Z`)
  const toDate = new Date(`${to}T00:00:00.000Z`)
  const durationDays =
    Math.round((toDate.getTime() - fromDate.getTime()) / (24 * 60 * 60 * 1000)) + 1

  const previousToDate = new Date(fromDate.getTime() - 24 * 60 * 60 * 1000)
  const previousFromDate = new Date(
    previousToDate.getTime() - (durationDays - 1) * 24 * 60 * 60 * 1000,
  )

  const previous_to = previousToDate.toISOString().slice(0, 10)
  const previous_from = previousFromDate.toISOString().slice(0, 10)

  return {
    previous_from,
    previous_to,
    createdFrom: new Date(`${previous_from}T00:00:00.000Z`),
    createdTo: new Date(`${previous_to}T23:59:59.999Z`),
  }
}

export type DashboardWebTrend = 'up' | 'down' | 'neutral'

export function computeDashboardWebTrend(
  current: number,
  previous: number,
): DashboardWebTrend {
  if (current > previous) return 'up'
  if (current < previous) return 'down'
  return 'neutral'
}
