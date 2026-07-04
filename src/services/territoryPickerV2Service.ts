/**
 * v2 territory picker — search + pagination for cascade UI.
 * v1 routes keep unpaginated behavior via territoryService directly.
 */

import {
  DEFAULT_TERRITORY_STATE_NAME,
  getTerritoryDescendantIds,
  getTerritoryPickerBootstrap,
  listTerritoryChildren,
  listTerritoryLevels,
  loadOrgTerritoryRowsCached,
  repairTelanganaDistrictParents,
  type TerritoryHierarchyNode,
  type TerritoryLevelInfo,
} from '@/services/territoryService.js'
import {
  filterTerritoryNodesForScope,
  isTerritoryNodeInScope,
  resolveTerritoryScopeIds,
} from '@/services/territoryScopeService.js'

export interface TerritoryPickerActor {
  roleName?: string | null
  userId?: string
}

export const TERRITORY_PICKER_DEFAULT_LIMIT = 50
export const TERRITORY_PICKER_MAX_LIMIT = 200

export interface TerritoryPickerListOptions {
  limit: number
  offset: number
  keyword?: string
}

export interface TerritoryPickerPagination {
  limit: number
  offset: number
  total: number
  has_more: boolean
}

export interface TerritoryDescendantNode {
  id: string
  name: string
  code: string | null
  level_order: number
  level_label: string
}

function sanitizePickerKeyword(raw: string): string {
  return raw
    .replace(/[,()."'\\]/g, ' ')
    .replace(/[%_]/g, '')
    .trim()
    .slice(0, 100)
}

export function parseTerritoryPickerQuery(
  query: Record<string, unknown>,
): TerritoryPickerListOptions {
  let limit =
    parseInt(String(query.limit ?? TERRITORY_PICKER_DEFAULT_LIMIT), 10) ||
    TERRITORY_PICKER_DEFAULT_LIMIT
  limit = Math.min(TERRITORY_PICKER_MAX_LIMIT, Math.max(1, limit))
  const offset = Math.max(0, parseInt(String(query.offset ?? '0'), 10) || 0)
  const keywordRaw =
    (typeof query.keyword === 'string' && query.keyword) ||
    (typeof query.search === 'string' && query.search) ||
    undefined
  const keyword = keywordRaw ? sanitizePickerKeyword(keywordRaw) : undefined
  return { limit, offset, keyword: keyword || undefined }
}

export function territoryPickerFiltersEcho(
  opts: TerritoryPickerListOptions,
  extra?: Record<string, unknown>,
) {
  return {
    limit: opts.limit,
    offset: opts.offset,
    keyword: opts.keyword ?? null,
    ...extra,
  }
}

function matchesKeyword(node: { name: string; code?: string | null }, keyword: string): boolean {
  const k = keyword.toLowerCase()
  if (node.name.toLowerCase().includes(k)) return true
  if (node.code && node.code.toLowerCase().includes(k)) return true
  return false
}

function filterByKeyword<T extends { name: string; code?: string | null }>(
  items: T[],
  keyword?: string,
): T[] {
  if (!keyword) return items
  return items.filter((n) => matchesKeyword(n, keyword))
}

function paginate<T>(
  items: T[],
  opts: TerritoryPickerListOptions,
): { items: T[]; pagination: TerritoryPickerPagination } {
  const total = items.length
  const slice = items.slice(opts.offset, opts.offset + opts.limit)
  return {
    items: slice,
    pagination: {
      limit: opts.limit,
      offset: opts.offset,
      total,
      has_more: opts.offset + slice.length < total,
    },
  }
}

function filterLevels(levels: TerritoryLevelInfo[], keyword?: string): TerritoryLevelInfo[] {
  if (!keyword) return levels
  const k = keyword.toLowerCase()
  return levels.filter(
    (l) =>
      l.label.toLowerCase().includes(k) || String(l.level_order).includes(k),
  )
}

export async function listTerritoryLevelsV2(
  orgId: string,
  opts: TerritoryPickerListOptions,
): Promise<{
  levels: TerritoryLevelInfo[]
  pagination: TerritoryPickerPagination
  filters: ReturnType<typeof territoryPickerFiltersEcho>
}> {
  const all = await listTerritoryLevels(orgId)
  const filtered = filterLevels(all, opts.keyword)
  const { items, pagination } = paginate(filtered, opts)
  return {
    levels: items,
    pagination,
    filters: territoryPickerFiltersEcho(opts),
  }
}

export async function listTerritoryChildrenV2(
  orgId: string,
  parentTerritoryId: string | null,
  opts: TerritoryPickerListOptions,
  actor?: TerritoryPickerActor,
): Promise<{
  children: TerritoryHierarchyNode[]
  pagination: TerritoryPickerPagination
  filters: ReturnType<typeof territoryPickerFiltersEcho>
  parent_forbidden?: boolean
}> {
  const scopeIds = await resolveTerritoryScopeIds(orgId, actor?.roleName, actor?.userId)

  if (scopeIds && parentTerritoryId) {
    const rows = await loadOrgTerritoryRowsCached(orgId)
    if (!isTerritoryNodeInScope(parentTerritoryId, scopeIds, rows)) {
      return {
        children: [],
        pagination: {
          limit: opts.limit,
          offset: opts.offset,
          total: 0,
          has_more: false,
        },
        filters: territoryPickerFiltersEcho(opts, { parent_id: parentTerritoryId }),
        parent_forbidden: true,
      }
    }
  }

  let all = await listTerritoryChildren(orgId, parentTerritoryId)
  if (scopeIds) {
    all = await filterTerritoryNodesForScope(orgId, all, scopeIds)
  }
  const filtered = filterByKeyword(all, opts.keyword)
  const { items, pagination } = paginate(filtered, opts)
  return {
    children: items,
    pagination,
    filters: territoryPickerFiltersEcho(opts, {
      parent_id: parentTerritoryId,
    }),
  }
}

export async function getTerritoryPickerBootstrapV2(
  orgId: string,
  opts: TerritoryPickerListOptions,
  actor?: TerritoryPickerActor,
): Promise<
  | {
      ok: true
      levels: TerritoryLevelInfo[]
      state: TerritoryHierarchyNode
      districts: TerritoryHierarchyNode[]
      pagination: TerritoryPickerPagination
      filters: ReturnType<typeof territoryPickerFiltersEcho>
    }
  | { ok: false }
> {
  const raw = await getTerritoryPickerBootstrap(orgId)
  if (!raw) return { ok: false }

  const scopeIds = await resolveTerritoryScopeIds(orgId, actor?.roleName, actor?.userId)

  const levelsAll = await listTerritoryLevels(orgId)
  const levelsFiltered = filterLevels(levelsAll, opts.keyword)

  let districts = raw.districts
  if (districts.length < 25) {
    const fixed = await repairTelanganaDistrictParents(orgId)
    if (fixed > 0) {
      const refreshed = await getTerritoryPickerBootstrap(orgId)
      if (refreshed) districts = refreshed.districts
    }
  }

  if (scopeIds) {
    districts = await filterTerritoryNodesForScope(orgId, districts, scopeIds)
  }

  const districtsFiltered = filterByKeyword(districts, opts.keyword)
  const { items, pagination } = paginate(districtsFiltered, opts)

  return {
    ok: true,
    levels: levelsFiltered,
    state: raw.state,
    districts: items,
    pagination,
    filters: territoryPickerFiltersEcho(opts, {
      state_id: raw.state.id,
      state_name: DEFAULT_TERRITORY_STATE_NAME,
    }),
  }
}

export async function listTerritoryDescendantsV2(
  orgId: string,
  territoryId: string,
  opts: TerritoryPickerListOptions,
  includeSelf: boolean,
): Promise<{
  territory_id: string
  descendant_count: number
  territory_ids: string[]
  nodes: TerritoryDescendantNode[]
  pagination: TerritoryPickerPagination
  filters: ReturnType<typeof territoryPickerFiltersEcho>
}> {
  const rows = await loadOrgTerritoryRowsCached(orgId)
  type Row = (typeof rows)[number]
  const byId = new Map<string, Row>(rows.map((r) => [r.id, r]))
  const descendantOnlyIds = await getTerritoryDescendantIds(orgId, territoryId, false)
  const allIds = includeSelf ? [territoryId, ...descendantOnlyIds] : descendantOnlyIds

  let nodes: TerritoryDescendantNode[] = allIds
    .map((id) => byId.get(id))
    .filter((r): r is NonNullable<typeof r> => !!r)
    .map((r) => ({
      id: r.id,
      name: r.name,
      code: r.code,
      level_order: r.level_order,
      level_label: r.level_label,
    }))

  nodes.sort((a, b) => a.level_order - b.level_order || a.name.localeCompare(b.name))
  nodes = filterByKeyword(nodes, opts.keyword)

  const { items, pagination } = paginate(nodes, opts)

  return {
    territory_id: territoryId,
    descendant_count: descendantOnlyIds.length,
    territory_ids: items.map((n) => n.id),
    nodes: items,
    pagination,
    filters: territoryPickerFiltersEcho(opts, {
      territory_id: territoryId,
      include_self: includeSelf,
    }),
  }
}
