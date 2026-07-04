/**
 * District-leader territory scoping for cascade pickers (Workers + Dashboard filters).
 */

import { createSupabaseServiceClient } from '@/lib/supabase.js'
import { isPostgresMode, dbQuery } from '@/lib/db.js'
import {
  getTerritoryDescendantIds,
  loadOrgTerritoryRowsCached,
  type TerritoryHierarchyNode,
} from '@/services/territoryService.js'

export function shouldScopeTerritoryPicker(roleName: string | null | undefined): boolean {
  return roleName === 'district_leader'
}

/** Assigned territories plus all descendants (concrete nodes the leader may act on). */
export async function loadUserTerritoryScopeIds(
  orgId: string,
  userId: string,
): Promise<Set<string>> {
  let assigned: string[] = []

  if (isPostgresMode()) {
    const res = await dbQuery<{ territory_id: string }>(
      `SELECT ut.territory_id
       FROM user_territories ut
       INNER JOIN users u ON u.id = ut.user_id
       WHERE u.id = $1 AND u.organization_id = $2`,
      [userId, orgId],
    )
    assigned = res.rows.map((r) => r.territory_id)
  } else {
    const supabase = createSupabaseServiceClient()
    const { data } = await supabase
      .from('user_territories')
      .select('territory_id, users!inner(organization_id)')
      .eq('user_id', userId)
    assigned = (data ?? [])
      .filter((row) => {
        const users = row.users as { organization_id?: string } | { organization_id?: string }[]
        const u = Array.isArray(users) ? users[0] : users
        return u?.organization_id === orgId
      })
      .map((row) => row.territory_id as string)
  }

  const scope = new Set<string>()
  for (const tid of assigned) {
    scope.add(tid)
    const descendants = await getTerritoryDescendantIds(orgId, tid, false)
    for (const id of descendants) scope.add(id)
  }
  return scope
}

type TerritoryRow = {
  id: string
  parent_territory_id: string | null
}

function descendantIdsOf(nodeId: string, rows: TerritoryRow[]): Set<string> {
  const byParent = new Map<string, string[]>()
  for (const r of rows) {
    if (!r.parent_territory_id) continue
    if (!byParent.has(r.parent_territory_id)) byParent.set(r.parent_territory_id, [])
    byParent.get(r.parent_territory_id)!.push(r.id)
  }
  const out = new Set<string>()
  const stack = [...(byParent.get(nodeId) ?? [])]
  while (stack.length) {
    const id = stack.pop()!
    out.add(id)
    stack.push(...(byParent.get(id) ?? []))
  }
  return out
}

function isAncestorOf(ancestorId: string, nodeId: string, rows: TerritoryRow[]): boolean {
  const byId = new Map(rows.map((r) => [r.id, r]))
  let cur: string | null = nodeId
  while (cur) {
    if (cur === ancestorId) return true
    cur = byId.get(cur)?.parent_territory_id ?? null
  }
  return false
}

/** Node visible when assigned to it, a descendant, or an ancestor of an assigned node. */
export function isTerritoryNodeInScope(
  nodeId: string,
  scopeIds: Set<string>,
  rows: TerritoryRow[],
): boolean {
  if (scopeIds.size === 0) return false
  if (scopeIds.has(nodeId)) return true

  const descendants = descendantIdsOf(nodeId, rows)
  for (const s of scopeIds) {
    if (descendants.has(s)) return true
  }
  for (const s of scopeIds) {
    if (isAncestorOf(nodeId, s, rows)) return true
  }
  return false
}

export async function filterTerritoryNodesForScope(
  orgId: string,
  nodes: TerritoryHierarchyNode[],
  scopeIds: Set<string>,
): Promise<TerritoryHierarchyNode[]> {
  if (scopeIds.size === 0) return []
  const rows = await loadOrgTerritoryRowsCached(orgId)
  return nodes.filter((n) => isTerritoryNodeInScope(n.id, scopeIds, rows))
}

export async function resolveTerritoryScopeIds(
  orgId: string,
  roleName: string | null | undefined,
  userId: string | undefined,
): Promise<Set<string> | null> {
  if (!shouldScopeTerritoryPicker(roleName) || !userId) return null
  return loadUserTerritoryScopeIds(orgId, userId)
}
