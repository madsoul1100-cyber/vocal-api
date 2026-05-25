import { createSupabaseServiceClient } from '@/lib/supabase.js'
import { isPostgresMode, dbQuery } from '@/lib/db.js'

export interface TerritoryOption {
  id: string
  name: string
}

const WORKERS_PAGE_ROLES = ['super_admin', 'central_support', 'district_leader']

function canManageTerritories(role: string | null | undefined): boolean {
  return !!role && WORKERS_PAGE_ROLES.includes(role)
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
