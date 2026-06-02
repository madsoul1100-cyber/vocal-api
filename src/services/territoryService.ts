import { createSupabaseServiceClient } from '@/lib/supabase.js'
import { isPostgresMode, dbQuery } from '@/lib/db.js'
import { canAccessWorkersPage } from '@/lib/roleHierarchy.js'

export interface TerritoryOption {
  id: string
  name: string
}

export interface TerritoryLevelInfo {
  level_order: number
  label: string
}

export interface TerritoryHierarchyNode {
  id: string
  name: string
  code: string | null
  level_order: number
  level_label: string
  parent_territory_id: string | null
  has_children: boolean
}

type TerritoryRow = {
  id: string
  name: string
  code: string | null
  parent_territory_id: string | null
  level_order: number
  level_label: string
}

const WORKERS_PAGE_ROLES = ['super_admin', 'central_support', 'district_leader']

/** Product default: territory picker is Telangana-only until pan-India rollout. */
export const DEFAULT_TERRITORY_STATE_NAME = 'Telangana'

function canManageTerritories(role: string | null | undefined): boolean {
  return canAccessWorkersPage(role)
}

async function ensureDefaultTerritoryLevel(orgId: string): Promise<string> {
  const supabase = createSupabaseServiceClient()

  if (isPostgresMode()) {
    const existing = await dbQuery<{ id: string }>(
      `SELECT id FROM territory_level_definitions
       WHERE organization_id = $1 AND level_order = 1
       LIMIT 1`,
      [orgId],
    )
    if (existing.rows[0]?.id) return existing.rows[0].id

    const created = await dbQuery<{ id: string }>(
      `INSERT INTO territory_level_definitions (organization_id, level_order, label)
       VALUES ($1, 1, 'Area')
       RETURNING id`,
      [orgId],
    )
    return created.rows[0]!.id
  }

  const { data: existing } = await supabase
    .from('territory_level_definitions')
    .select('id')
    .eq('organization_id', orgId)
    .eq('level_order', 1)
    .maybeSingle()

  if (existing?.id) return existing.id as string

  const { data: created, error } = await supabase
    .from('territory_level_definitions')
    .insert({
      organization_id: orgId,
      level_order: 1,
      label: 'Area',
    })
    .select('id')
    .single()

  if (error || !created) {
    throw new Error(error?.message ?? 'Could not create territory level definition')
  }
  return created.id as string
}

type TerritoryNodeRow = TerritoryRow & { has_children: boolean }

/** Short-lived in-memory cache — avoids reloading the full tree on every dropdown. */
const territoryTreeCache = new Map<string, { expiresAt: number; rows: TerritoryRow[] }>()
const TREE_CACHE_TTL_MS = 60_000

export async function loadOrgTerritoryRowsCached(orgId: string): Promise<TerritoryRow[]> {
  const hit = territoryTreeCache.get(orgId)
  if (hit && hit.expiresAt > Date.now()) return hit.rows
  const rows = await loadOrgTerritoryRows(orgId)
  territoryTreeCache.set(orgId, { expiresAt: Date.now() + TREE_CACHE_TTL_MS, rows })
  return rows
}

export function invalidateTerritoryTreeCache(orgId?: string): void {
  if (orgId) territoryTreeCache.delete(orgId)
  else territoryTreeCache.clear()
}

async function loadOrgTerritoryRows(orgId: string): Promise<TerritoryRow[]> {
  if (isPostgresMode()) {
    const res = await dbQuery<TerritoryRow>(
      `SELECT t.id, t.name, t.code, t.parent_territory_id,
              tld.level_order, tld.label AS level_label
       FROM territories t
       INNER JOIN territory_level_definitions tld ON tld.id = t.level_definition_id
       WHERE t.organization_id = $1 AND t.active = true
       ORDER BY tld.level_order ASC, t.name ASC`,
      [orgId],
    )
    return res.rows
  }

  const supabase = createSupabaseServiceClient()
  const { data } = await supabase
    .from('territories')
    .select(
      `id, name, code, parent_territory_id,
       territory_level_definitions(level_order, label)`,
    )
    .eq('organization_id', orgId)
    .eq('active', true)

  const rows: TerritoryRow[] = []
  for (const t of data ?? []) {
    const level = t.territory_level_definitions as
      | { level_order: number; label: string }
      | { level_order: number; label: string }[]
      | null
    const lvl = Array.isArray(level) ? level[0] : level
    if (!lvl) continue
    rows.push({
      id: t.id as string,
      name: t.name as string,
      code: (t.code as string | null) ?? null,
      parent_territory_id: (t.parent_territory_id as string | null) ?? null,
      level_order: Number(lvl.level_order),
      level_label: lvl.label,
    })
  }
  rows.sort((a, b) => a.level_order - b.level_order || a.name.localeCompare(b.name))
  return rows
}

export async function listTerritoryLevels(orgId: string): Promise<TerritoryLevelInfo[]> {
  if (isPostgresMode()) {
    const res = await dbQuery<TerritoryLevelInfo>(
      `SELECT level_order, label
       FROM territory_level_definitions
       WHERE organization_id = $1 AND active = true
       ORDER BY level_order ASC`,
      [orgId],
    )
    return res.rows
  }

  const supabase = createSupabaseServiceClient()
  const { data } = await supabase
    .from('territory_level_definitions')
    .select('level_order, label')
    .eq('organization_id', orgId)
    .eq('active', true)
    .order('level_order', { ascending: true })

  return (data ?? []) as TerritoryLevelInfo[]
}

function mapNodeRows(rows: TerritoryNodeRow[]): TerritoryHierarchyNode[] {
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    code: r.code,
    level_order: r.level_order,
    level_label: r.level_label,
    parent_territory_id: r.parent_territory_id,
    has_children: r.has_children,
  }))
}

async function listTerritoryChildrenPg(
  orgId: string,
  parentTerritoryId: string | null,
): Promise<TerritoryNodeRow[]> {
  if (!parentTerritoryId) {
    const res = await dbQuery<TerritoryNodeRow>(
      `SELECT t.id, t.name, t.code, t.parent_territory_id,
              tld.level_order, tld.label AS level_label,
              EXISTS (
                SELECT 1 FROM territories c
                WHERE c.parent_territory_id = t.id
                  AND c.organization_id = t.organization_id
                  AND c.active = true
              ) AS has_children
       FROM territories t
       INNER JOIN territory_level_definitions tld ON tld.id = t.level_definition_id
       WHERE t.organization_id = $1
         AND t.active = true
         AND t.parent_territory_id IS NULL
         AND lower(trim(t.name)) = lower(trim($2))
       ORDER BY t.name ASC`,
      [orgId, DEFAULT_TERRITORY_STATE_NAME],
    )
    return res.rows.map((r) => ({ ...r, has_children: Boolean(r.has_children) }))
  }

  const res = await dbQuery<TerritoryNodeRow>(
    `SELECT t.id, t.name, t.code, t.parent_territory_id,
            tld.level_order, tld.label AS level_label,
            EXISTS (
              SELECT 1 FROM territories c
              WHERE c.parent_territory_id = t.id
                AND c.organization_id = t.organization_id
                AND c.active = true
            ) AS has_children
     FROM territories t
     INNER JOIN territory_level_definitions tld ON tld.id = t.level_definition_id
     WHERE t.organization_id = $1
       AND t.active = true
       AND t.parent_territory_id = $2::uuid
     ORDER BY tld.level_order ASC, t.name ASC`,
    [orgId, parentTerritoryId],
  )
  let rows = res.rows.map((r) => ({ ...r, has_children: Boolean(r.has_children) }))

  // Fallback: districts imported with broken parent links still show under Telangana.
  const stateRow = await dbQuery<{ id: string; level_order: number }>(
    `SELECT t.id, tld.level_order
     FROM territories t
     INNER JOIN territory_level_definitions tld ON tld.id = t.level_definition_id
     WHERE t.id = $1::uuid AND t.organization_id = $2`,
    [parentTerritoryId, orgId],
  )
  const state = stateRow.rows[0]
  if (state && state.level_order === 1 && rows.length < 25) {
    const orphans = await dbQuery<TerritoryNodeRow>(
      `SELECT t.id, t.name, t.code, t.parent_territory_id,
              tld.level_order, tld.label AS level_label,
              EXISTS (
                SELECT 1 FROM territories c
                WHERE c.parent_territory_id = t.id
                  AND c.organization_id = t.organization_id
                  AND c.active = true
              ) AS has_children
       FROM territories t
       INNER JOIN territory_level_definitions tld ON tld.id = t.level_definition_id
       WHERE t.organization_id = $1
         AND t.active = true
         AND tld.level_order = 2
         AND (t.parent_territory_id IS NULL OR t.parent_territory_id <> $2::uuid)
       ORDER BY t.name ASC`,
      [orgId, parentTerritoryId],
    )
    const seen = new Set(rows.map((r) => r.id))
    for (const o of orphans.rows) {
      if (!seen.has(o.id)) {
        rows.push({ ...o, has_children: Boolean(o.has_children), parent_territory_id: parentTerritoryId })
      }
    }
    rows.sort((a, b) => a.name.localeCompare(b.name))
  }

  return rows
}

function listTerritoryChildrenFromCache(
  orgId: string,
  parentTerritoryId: string | null,
  rows: TerritoryRow[],
): TerritoryNodeRow[] {
  const childCount = new Map<string, number>()
  for (const r of rows) {
    if (r.parent_territory_id) {
      childCount.set(r.parent_territory_id, (childCount.get(r.parent_territory_id) ?? 0) + 1)
    }
  }

  let children: TerritoryRow[]
  if (!parentTerritoryId) {
    children = rows.filter(
      (r) =>
        r.parent_territory_id == null &&
        r.name.trim().toLowerCase() === DEFAULT_TERRITORY_STATE_NAME.toLowerCase(),
    )
  } else {
    children = rows.filter((r) => r.parent_territory_id === parentTerritoryId)
    const state = rows.find((r) => r.id === parentTerritoryId)
    if (state?.level_order === 1 && children.length < 25) {
      const seen = new Set(children.map((c) => c.id))
      for (const r of rows) {
        if (r.level_order !== 2 || seen.has(r.id)) continue
        if (r.parent_territory_id === parentTerritoryId) continue
        children.push({ ...r, parent_territory_id: parentTerritoryId })
        seen.add(r.id)
      }
      children.sort((a, b) => a.name.localeCompare(b.name))
    }
  }

  return children.map((r) => ({
    ...r,
    has_children: (childCount.get(r.id) ?? 0) > 0,
  }))
}

export async function listTerritoryChildren(
  orgId: string,
  parentTerritoryId: string | null,
): Promise<TerritoryHierarchyNode[]> {
  const rows = isPostgresMode()
    ? await listTerritoryChildrenPg(orgId, parentTerritoryId)
    : listTerritoryChildrenFromCache(
        orgId,
        parentTerritoryId,
        await loadOrgTerritoryRowsCached(orgId),
      )
  return mapNodeRows(rows)
}

export interface TerritoryPickerBootstrap {
  levels: TerritoryLevelInfo[]
  state: TerritoryHierarchyNode
  districts: TerritoryHierarchyNode[]
}

/** One round-trip payload for the worker territory cascade (Telangana + all districts). */
export async function getTerritoryPickerBootstrap(
  orgId: string,
): Promise<TerritoryPickerBootstrap | null> {
  const [levels, states] = await Promise.all([
    listTerritoryLevels(orgId),
    listTerritoryChildren(orgId, null),
  ])
  const state = states[0]
  if (!state) return null
  let districts = await listTerritoryChildren(orgId, state.id)
  if (districts.length < 25) {
    const fixed = await repairTelanganaDistrictParents(orgId)
    if (fixed > 0) {
      districts = await listTerritoryChildren(orgId, state.id)
    }
  }
  return { levels, state, districts }
}

/** Re-link district rows that lost parent_territory_id (e.g. after partial import). */
export async function repairTelanganaDistrictParents(orgId: string): Promise<number> {
  const states = await listTerritoryChildren(orgId, null)
  const stateId = states[0]?.id
  if (!stateId) return 0

  if (isPostgresMode()) {
    const res = await dbQuery<{ id: string }>(
      `UPDATE territories t
       SET parent_territory_id = $2::uuid, updated_at = now()
       FROM territory_level_definitions tld
       WHERE t.level_definition_id = tld.id
         AND t.organization_id = $1
         AND t.active = true
         AND tld.level_order = 2
         AND (t.parent_territory_id IS NULL OR t.parent_territory_id <> $2::uuid)
       RETURNING t.id`,
      [orgId, stateId],
    )
    invalidateTerritoryTreeCache(orgId)
    return res.rowCount ?? res.rows.length
  }

  const rows = await loadOrgTerritoryRows(orgId)
  const orphans = rows.filter((r) => r.level_order === 2 && r.parent_territory_id !== stateId)
  if (orphans.length === 0) return 0

  const supabase = createSupabaseServiceClient()
  let fixed = 0
  for (const o of orphans) {
    const { error } = await supabase
      .from('territories')
      .update({ parent_territory_id: stateId, updated_at: new Date().toISOString() })
      .eq('id', o.id)
    if (!error) fixed++
  }
  invalidateTerritoryTreeCache(orgId)
  return fixed
}

/** All descendant territory IDs (optionally including the root). */
export async function getTerritoryDescendantIds(
  orgId: string,
  territoryId: string,
  includeSelf = true,
): Promise<string[]> {
  const rows = await loadOrgTerritoryRowsCached(orgId)
  const byParent = new Map<string, string[]>()
  for (const r of rows) {
    if (!r.parent_territory_id) continue
    if (!byParent.has(r.parent_territory_id)) byParent.set(r.parent_territory_id, [])
    byParent.get(r.parent_territory_id)!.push(r.id)
  }

  const descendants: string[] = []
  const stack = [...(byParent.get(territoryId) ?? [])]
  while (stack.length) {
    const id = stack.pop()!
    descendants.push(id)
    stack.push(...(byParent.get(id) ?? []))
  }
  return includeSelf ? [territoryId, ...descendants] : descendants
}

export async function countTerritoryDescendants(
  orgId: string,
  territoryId: string,
): Promise<number> {
  const ids = await getTerritoryDescendantIds(orgId, territoryId, false)
  return ids.length
}

export interface TerritoryAssignmentInput {
  territory_id: string
  include_descendants?: boolean
}

/** Expand UI selections into concrete territory IDs for user_territories. */
export async function expandTerritoryAssignmentIds(
  orgId: string,
  assignments: TerritoryAssignmentInput[],
): Promise<string[]> {
  const ids = new Set<string>()
  for (const a of assignments) {
    const tid = a.territory_id?.trim()
    if (!tid) continue
    if (a.include_descendants) {
      const expanded = await getTerritoryDescendantIds(orgId, tid, true)
      for (const id of expanded) ids.add(id)
    } else {
      ids.add(tid)
    }
  }
  return [...ids]
}

/** Ancestor chain for a territory: [self, parent, grandparent, …]. */
export function buildTerritoryAncestorChain(
  territoryId: string,
  parentOf: Map<string, string | null>,
): string[] {
  const chain: string[] = []
  let cursor: string | null = territoryId
  const seen = new Set<string>()
  while (cursor && !seen.has(cursor)) {
    chain.push(cursor)
    seen.add(cursor)
    cursor = parentOf.get(cursor) ?? null
  }
  return chain
}

export async function loadTerritoryParentMap(orgId: string): Promise<Map<string, string | null>> {
  const rows = await loadOrgTerritoryRowsCached(orgId)
  const parentOf = new Map<string, string | null>()
  for (const r of rows) parentOf.set(r.id, r.parent_territory_id)
  return parentOf
}

/** True when any of workerTerritoryIds is the ticket territory or an ancestor of it. */
export function workerTerritoryCoversTicket(
  workerTerritoryIds: string[],
  ticketTerritoryId: string,
  parentOf: Map<string, string | null>,
): boolean {
  const chain = buildTerritoryAncestorChain(ticketTerritoryId, parentOf)
  const chainSet = new Set(chain)
  return workerTerritoryIds.some((id) => chainSet.has(id))
}

export async function listOrgTerritories(orgId: string): Promise<TerritoryOption[]> {
  if (isPostgresMode()) {
    const res = await dbQuery<TerritoryOption>(
      `SELECT id, name FROM territories
       WHERE organization_id = $1 AND active = true
       ORDER BY name ASC`,
      [orgId],
    )
    return res.rows
  }

  const supabase = createSupabaseServiceClient()
  const { data } = await supabase
    .from('territories')
    .select('id, name')
    .eq('organization_id', orgId)
    .eq('active', true)
    .order('name', { ascending: true })

  return (data ?? []) as TerritoryOption[]
}

function sanitizeTerritoryNamePattern(raw: string): string {
  return raw
    .replace(/[,()."'\\]/g, ' ')
    .replace(/[%_]/g, '')
    .trim()
    .slice(0, 100)
}

/** Territory IDs whose name partially matches (case-insensitive). */
export async function listTerritoryIdsByNamePattern(
  orgId: string,
  rawPattern: string,
): Promise<string[]> {
  const pattern = sanitizeTerritoryNamePattern(rawPattern)
  if (!pattern) return []

  const ilike = `%${pattern}%`

  if (isPostgresMode()) {
    const res = await dbQuery<{ id: string }>(
      `SELECT id FROM territories
       WHERE organization_id = $1 AND active = true AND name ILIKE $2`,
      [orgId, ilike],
    )
    return res.rows.map((r) => r.id)
  }

  const supabase = createSupabaseServiceClient()
  const safe = pattern.replace(/[%_]/g, '\\$&')
  const { data } = await supabase
    .from('territories')
    .select('id')
    .eq('organization_id', orgId)
    .eq('active', true)
    .ilike('name', `%${safe}%`)

  return ((data ?? []) as Array<{ id: string }>).map((r) => r.id)
}

/** User IDs linked to any territory whose name partially matches. */
export async function listUserIdsWithTerritoryNameMatch(
  orgId: string,
  rawPattern: string,
): Promise<string[]> {
  const pattern = sanitizeTerritoryNamePattern(rawPattern)
  if (!pattern) return []

  const ilike = `%${pattern}%`

  if (isPostgresMode()) {
    const res = await dbQuery<{ user_id: string }>(
      `SELECT DISTINCT ut.user_id
       FROM user_territories ut
       INNER JOIN territories t ON t.id = ut.territory_id
       WHERE t.organization_id = $1 AND t.active = true AND t.name ILIKE $2`,
      [orgId, ilike],
    )
    return res.rows.map((r) => r.user_id)
  }

  const territoryIds = await listTerritoryIdsByNamePattern(orgId, pattern)
  if (territoryIds.length === 0) return []

  const supabase = createSupabaseServiceClient()
  const { data } = await supabase
    .from('user_territories')
    .select('user_id')
    .in('territory_id', territoryIds)

  return [...new Set(((data ?? []) as Array<{ user_id: string }>).map((r) => r.user_id))]
}

export async function createOrgTerritory(
  actor: { organization_id: string; roles?: { name: string } | null },
  rawName: string,
): Promise<
  { ok: true; territory: TerritoryOption } | { ok: false; error: string; status: number }
> {
  if (!canManageTerritories(actor.roles?.name)) {
    return { ok: false, error: 'Insufficient role', status: 403 }
  }

  const name = rawName.trim()
  if (!name) {
    return { ok: false, error: 'Territory name is required', status: 400 }
  }
  if (name.length > 200) {
    return { ok: false, error: 'Territory name is too long', status: 400 }
  }

  const orgId = actor.organization_id
  const supabase = createSupabaseServiceClient()

  if (isPostgresMode()) {
    const dup = await dbQuery<{ id: string }>(
      `SELECT id FROM territories
       WHERE organization_id = $1 AND lower(trim(name)) = lower(trim($2))
       LIMIT 1`,
      [orgId, name],
    )
    if (dup.rows[0]) {
      return { ok: false, error: 'A territory with this name already exists', status: 409 }
    }
  } else {
    const { data: existing } = await supabase
      .from('territories')
      .select('id, name')
      .eq('organization_id', orgId)

    const duplicate = (existing ?? []).some(
      (t) => typeof t.name === 'string' && t.name.trim().toLowerCase() === name.toLowerCase(),
    )
    if (duplicate) {
      return { ok: false, error: 'A territory with this name already exists', status: 409 }
    }
  }

  try {
    const levelId = await ensureDefaultTerritoryLevel(orgId)
    const now = new Date().toISOString()

    const { data, error } = await supabase
      .from('territories')
      .insert({
        organization_id: orgId,
        name,
        level_definition_id: levelId,
        active: true,
        updated_at: now,
      })
      .select('id, name')
      .single()

    if (error || !data) {
      return { ok: false, error: error?.message ?? 'Failed to create territory', status: 500 }
    }

    return { ok: true, territory: { id: data.id as string, name: data.name as string } }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to create territory'
    return { ok: false, error: msg, status: 500 }
  }
}

export async function validateTerritoryIdsForOrg(
  orgId: string,
  territoryIds: string[],
): Promise<{ ok: true; ids: string[] } | { ok: false; error: string }> {
  const unique = [...new Set(territoryIds.filter((id) => typeof id === 'string' && id.trim()))]
  if (unique.length === 0) return { ok: true, ids: [] }

  if (isPostgresMode()) {
    const res = await dbQuery<{ id: string }>(
      `SELECT id FROM territories WHERE organization_id = $1 AND id = ANY($2::uuid[])`,
      [orgId, unique],
    )
    if (res.rows.length !== unique.length) {
      return { ok: false, error: 'One or more territories are invalid for this organization' }
    }
    return { ok: true, ids: unique }
  }

  const supabase = createSupabaseServiceClient()
  const { data } = await supabase
    .from('territories')
    .select('id')
    .eq('organization_id', orgId)
    .in('id', unique)

  if ((data ?? []).length !== unique.length) {
    return { ok: false, error: 'One or more territories are invalid for this organization' }
  }
  return { ok: true, ids: unique }
}
