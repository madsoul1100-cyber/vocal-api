import { createSupabaseServiceClient } from '@/lib/supabase.js'
import { isPostgresMode, dbQuery } from '@/lib/db.js'
import { createClerkUser, deleteClerkUser, findClerkUserIdByEmail } from '@/lib/clerkAdmin.js'

export const WORKERS_PAGE_ROLES = ['super_admin', 'central_support', 'district_leader']
const AUTO_APPROVE_ROLES = ['super_admin', 'central_support']

export function canAccessWorkersPage(role: string | null | undefined): boolean {
  return !!role && WORKERS_PAGE_ROLES.includes(role)
}

export interface TerritoryOption {
  id: string
  name: string
}

export interface RoleOption {
  id: string
  name: string
  display_name: string
}

async function listRoles(): Promise<RoleOption[]> {
  if (isPostgresMode()) {
    const res = await dbQuery<RoleOption>(
      `SELECT id, name, display_name FROM roles WHERE active = true ORDER BY display_name ASC`,
    )
    return res.rows
  }
  const supabase = createSupabaseServiceClient()
  const { data } = await supabase
    .from('roles')
    .select('id, name, display_name')
    .eq('active', true)
    .order('display_name', { ascending: true })
  return (data ?? []) as RoleOption[]
}

function clean(v: unknown, max = 200): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim().slice(0, max)
  return s.length ? s : null
}

export interface WorkerRow {
  id: string
  full_name: string
  phone: string | null
  email: string | null
  active: boolean
  last_login_at: string | null
  created_at: string
  roles: { name: string; display_name: string | null } | null
}

export interface PendingActivationRow {
  id: string
  full_name: string
  phone: string
  email: string | null
  status: string
  created_at: string
  territories: { name: string } | null
}

// --- v2 list (pagination, sort, filters) ---

export const WORKERS_V2_DEFAULT_LIMIT = 20
export const WORKERS_V2_MAX_LIMIT = 100
export const WORKERS_V2_PENDING_DEFAULT_LIMIT = 20
export const WORKERS_V2_PENDING_MAX_LIMIT = 50

export type WorkersV2SortField = 'full_name' | 'created_at' | 'last_login_at'

export interface WorkersListV2Options {
  limit: number
  offset: number
  sort: WorkersV2SortField
  order: 'asc' | 'desc'
  active?: boolean
  keyword?: string
  role?: string
  roleId?: string
  territoryId?: string
  includePending: boolean
  pendingLimit: number
  pendingOffset: number
}

export interface WorkersListV2Pagination {
  limit: number
  offset: number
  total: number
  hasNextPage: boolean
  hasPreviousPage: boolean
}

export interface WorkersOrgSummary {
  active: number
  inactive: number
  total: number
}

export interface WorkersListV2Result {
  workers: WorkerRow[]
  pagination: WorkersListV2Pagination
  pending: PendingActivationRow[]
  pending_pagination: WorkersListV2Pagination
  summary: WorkersOrgSummary
  territories: TerritoryOption[]
  roles: RoleOption[]
}

function sanitizeWorkersKeyword(raw: string): string {
  return raw
    .replace(/[,()."'\\]/g, ' ')
    .replace(/[%_]/g, '')
    .trim()
    .slice(0, 100)
}

function parseBooleanQuery(value: unknown): boolean | undefined {
  if (value === 'true' || value === true || value === '1') return true
  if (value === 'false' || value === false || value === '0') return false
  return undefined
}

function parseWorkersSort(raw: unknown): WorkersV2SortField {
  const s = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (s === 'created' || s === 'created_at') return 'created_at'
  if (s === 'last_login' || s === 'last_login_at') return 'last_login_at'
  return 'full_name'
}

function parseWorkersOrder(raw: unknown, sort: WorkersV2SortField): 'asc' | 'desc' {
  if (typeof raw === 'string') {
    const o = raw.trim().toLowerCase()
    if (o === 'asc') return 'asc'
    if (o === 'desc') return 'desc'
  }
  return sort === 'full_name' ? 'asc' : 'desc'
}

function parseIncludePending(raw: unknown): boolean {
  if (raw === 'false' || raw === false || raw === '0') return false
  return true
}

export function parseWorkersV2ListQuery(query: Record<string, unknown>): WorkersListV2Options {
  let limit =
    parseInt(String(query.limit ?? WORKERS_V2_DEFAULT_LIMIT), 10) || WORKERS_V2_DEFAULT_LIMIT
  limit = Math.min(WORKERS_V2_MAX_LIMIT, Math.max(1, limit))
  const offset = Math.max(0, parseInt(String(query.offset ?? '0'), 10) || 0)

  let pendingLimit =
    parseInt(String(query.pending_limit ?? WORKERS_V2_PENDING_DEFAULT_LIMIT), 10) ||
    WORKERS_V2_PENDING_DEFAULT_LIMIT
  pendingLimit = Math.min(WORKERS_V2_PENDING_MAX_LIMIT, Math.max(1, pendingLimit))
  const pendingOffset = Math.max(0, parseInt(String(query.pending_offset ?? '0'), 10) || 0)

  const keywordRaw =
    (typeof query.keyword === 'string' && query.keyword) ||
    (typeof query.search === 'string' && query.search) ||
    undefined
  const keyword = keywordRaw ? sanitizeWorkersKeyword(keywordRaw) : undefined

  const role =
    typeof query.role === 'string' && query.role.trim() ? query.role.trim().toLowerCase() : undefined
  const roleId =
    typeof query.role_id === 'string' && query.role_id.trim() ? query.role_id.trim() : undefined
  const territoryId =
    typeof query.territory_id === 'string' && query.territory_id.trim()
      ? query.territory_id.trim()
      : undefined

  const sort = parseWorkersSort(query.sort)
  return {
    limit,
    offset,
    sort,
    order: parseWorkersOrder(query.order, sort),
    active: parseBooleanQuery(query.active),
    keyword: keyword || undefined,
    role,
    roleId,
    territoryId,
    includePending: parseIncludePending(query.include_pending),
    pendingLimit,
    pendingOffset,
  }
}

export function workersV2FiltersEcho(opts: WorkersListV2Options) {
  return {
    limit: opts.limit,
    offset: opts.offset,
    sort: opts.sort,
    order: opts.order,
    active: opts.active ?? null,
    keyword: opts.keyword ?? null,
    role: opts.role ?? null,
    role_id: opts.roleId ?? null,
    territory_id: opts.territoryId ?? null,
    include_pending: opts.includePending,
    pending_limit: opts.pendingLimit,
    pending_offset: opts.pendingOffset,
  }
}

function buildWorkersV2Pagination(
  offset: number,
  limit: number,
  total: number,
): WorkersListV2Pagination {
  return {
    limit,
    offset,
    total,
    hasNextPage: offset + limit < total,
    hasPreviousPage: offset > 0,
  }
}

function workersV2OrderSql(sort: WorkersV2SortField, order: 'asc' | 'desc'): string {
  const dir = order === 'asc' ? 'ASC' : 'DESC'
  if (sort === 'last_login_at') {
    return `u.last_login_at ${dir} NULLS LAST, u.full_name ASC`
  }
  if (sort === 'created_at') {
    return `u.created_at ${dir}, u.full_name ASC`
  }
  return `u.full_name ${dir}`
}

function appendWorkersV2Filters(
  where: string,
  params: unknown[],
  paramIndex: { i: number },
  opts: WorkersListV2Options,
): string {
  let clause = where

  if (opts.active === true) {
    clause += ` AND u.active = true`
  } else if (opts.active === false) {
    clause += ` AND u.active = false`
  }
  if (opts.roleId) {
    clause += ` AND u.role_id = $${paramIndex.i++}`
    params.push(opts.roleId)
  } else if (opts.role) {
    clause += ` AND r.name = $${paramIndex.i++}`
    params.push(opts.role)
  }
  if (opts.territoryId) {
    clause += ` AND EXISTS (
      SELECT 1 FROM user_territories ut
      WHERE ut.user_id = u.id AND ut.territory_id = $${paramIndex.i++}
    )`
    params.push(opts.territoryId)
  }
  if (opts.keyword) {
    const pattern = `%${opts.keyword}%`
    clause += ` AND (
      u.full_name ILIKE $${paramIndex.i}
      OR u.email ILIKE $${paramIndex.i}
      OR COALESCE(u.phone, '') ILIKE $${paramIndex.i}
    )`
    params.push(pattern)
    paramIndex.i++
  }

  return clause
}

async function getWorkersOrgSummaryPg(orgId: string): Promise<WorkersOrgSummary> {
  const res = await dbQuery<{ active: string; inactive: string }>(
    `SELECT
       COUNT(*) FILTER (WHERE active = true)::text AS active,
       COUNT(*) FILTER (WHERE active = false)::text AS inactive
     FROM users WHERE organization_id = $1`,
    [orgId],
  )
  const active = Number(res.rows[0]?.active ?? 0)
  const inactive = Number(res.rows[0]?.inactive ?? 0)
  return { active, inactive, total: active + inactive }
}

async function getWorkersOrgSummarySupabase(orgId: string): Promise<WorkersOrgSummary> {
  const supabase = createSupabaseServiceClient()
  const [activeRes, inactiveRes] = await Promise.all([
    supabase
      .from('users')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .eq('active', true),
    supabase
      .from('users')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .eq('active', false),
  ])
  const active = activeRes.count ?? 0
  const inactive = inactiveRes.count ?? 0
  return { active, inactive, total: active + inactive }
}

async function listWorkersV2Pg(
  orgId: string,
  opts: WorkersListV2Options,
): Promise<Pick<WorkersListV2Result, 'workers' | 'pagination' | 'pending' | 'pending_pagination'>> {
  const params: unknown[] = [orgId]
  const paramIndex = { i: 2 }
  const where = appendWorkersV2Filters('u.organization_id = $1', params, paramIndex, opts)

  const countRes = await dbQuery<{ c: string }>(
    `SELECT COUNT(*)::text AS c
     FROM users u
     INNER JOIN roles r ON r.id = u.role_id
     WHERE ${where}`,
    params,
  )
  const total = Number(countRes.rows[0]?.c ?? 0)

  const listParams = [...params, opts.limit, opts.offset]
  const limitParam = paramIndex.i++
  const offsetParam = paramIndex.i++
  const orderSql = workersV2OrderSql(opts.sort, opts.order)

  const workersRes = await dbQuery<WorkerRow>(
    `SELECT u.id, u.full_name, u.phone, u.email, u.active, u.last_login_at, u.created_at,
            jsonb_build_object('name', r.name, 'display_name', r.display_name) AS roles
     FROM users u
     INNER JOIN roles r ON r.id = u.role_id
     WHERE ${where}
     ORDER BY ${orderSql}
     LIMIT $${limitParam} OFFSET $${offsetParam}`,
    listParams,
  )

  let pending: PendingActivationRow[] = []
  let pendingTotal = 0
  if (opts.includePending) {
    const pendingCountRes = await dbQuery<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM worker_activation_requests
       WHERE organization_id = $1 AND status = 'pending'`,
      [orgId],
    )
    pendingTotal = Number(pendingCountRes.rows[0]?.c ?? 0)

    const pendingRes = await dbQuery<PendingActivationRow>(
      `SELECT war.id, war.full_name, war.phone, war.email, war.status, war.created_at,
              CASE WHEN t.id IS NULL THEN NULL
                   ELSE jsonb_build_object('name', t.name)
              END AS territories
       FROM worker_activation_requests war
       LEFT JOIN territories t ON t.id = war.territory_id
       WHERE war.organization_id = $1 AND war.status = 'pending'
       ORDER BY war.created_at DESC
       LIMIT $2 OFFSET $3`,
      [orgId, opts.pendingLimit, opts.pendingOffset],
    )
    pending = pendingRes.rows
  }

  return {
    workers: workersRes.rows,
    pagination: buildWorkersV2Pagination(opts.offset, opts.limit, total),
    pending,
    pending_pagination: buildWorkersV2Pagination(
      opts.pendingOffset,
      opts.pendingLimit,
      pendingTotal,
    ),
  }
}

function workersV2SupabaseSelect(opts: WorkersListV2Options): string {
  const rolesEmbed = opts.role
    ? 'roles!inner(name, display_name)'
    : 'roles(name, display_name)'
  const parts = [
    'id, full_name, phone, email, active, last_login_at, created_at',
    rolesEmbed,
  ]
  if (opts.territoryId) parts.push('user_territories!inner(territory_id)')
  return parts.join(', ')
}

async function listWorkersV2Supabase(
  orgId: string,
  opts: WorkersListV2Options,
): Promise<Pick<WorkersListV2Result, 'workers' | 'pagination' | 'pending' | 'pending_pagination'>> {
  const supabase = createSupabaseServiceClient()

  let query = supabase
    .from('users')
    .select(workersV2SupabaseSelect(opts), { count: 'exact' })
    .eq('organization_id', orgId)

  if (opts.active === true) query = query.eq('active', true)
  else if (opts.active === false) query = query.eq('active', false)
  if (opts.roleId) query = query.eq('role_id', opts.roleId)
  if (opts.role) query = query.eq('roles.name', opts.role)
  if (opts.territoryId) query = query.eq('user_territories.territory_id', opts.territoryId)
  if (opts.keyword) {
    const safe = opts.keyword.replace(/[%_]/g, '\\$&')
    query = query.or(
      `full_name.ilike.%${safe}%,email.ilike.%${safe}%,phone.ilike.%${safe}%`,
    )
  }

  const ascending = opts.order === 'asc'
  if (opts.sort === 'created_at') {
    query = query.order('created_at', { ascending }).order('full_name', { ascending: true })
  } else if (opts.sort === 'last_login_at') {
    query = query
      .order('last_login_at', { ascending, nullsFirst: false })
      .order('full_name', { ascending: true })
  } else {
    query = query.order('full_name', { ascending })
  }

  query = query.range(opts.offset, opts.offset + opts.limit - 1)

  const { data, error, count } = await query
  if (error) throw new Error(error.message)

  let pending: PendingActivationRow[] = []
  let pendingTotal = 0
  if (opts.includePending) {
    const pendingQuery = supabase
      .from('worker_activation_requests')
      .select('id, full_name, phone, email, status, created_at, territories(name)', {
        count: 'exact',
      })
      .eq('organization_id', orgId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .range(opts.pendingOffset, opts.pendingOffset + opts.pendingLimit - 1)

    const pendingRes = await pendingQuery
    if (pendingRes.error) throw new Error(pendingRes.error.message)
    pending = (pendingRes.data ?? []) as unknown as PendingActivationRow[]
    pendingTotal = pendingRes.count ?? 0
  }

  return {
    workers: (data ?? []) as unknown as WorkerRow[],
    pagination: buildWorkersV2Pagination(opts.offset, opts.limit, count ?? 0),
    pending,
    pending_pagination: buildWorkersV2Pagination(
      opts.pendingOffset,
      opts.pendingLimit,
      pendingTotal,
    ),
  }
}

export async function listWorkersV2(
  orgId: string,
  opts: WorkersListV2Options,
): Promise<WorkersListV2Result> {
  const [listPart, summary, territories, roles] = await Promise.all([
    isPostgresMode() ? listWorkersV2Pg(orgId, opts) : listWorkersV2Supabase(orgId, opts),
    isPostgresMode() ? getWorkersOrgSummaryPg(orgId) : getWorkersOrgSummarySupabase(orgId),
    listTerritories(orgId),
    listRoles(),
  ])

  return { ...listPart, summary, territories, roles }
}

/** @deprecated Use listWorkersV2 — kept for v1 compat (first 200 workers, 50 pending). */
export async function getWorkersPageData(orgId: string): Promise<{
  workers: WorkerRow[]
  pending: PendingActivationRow[]
  territories: TerritoryOption[]
  roles: RoleOption[]
}> {
  const result = await listWorkersV2(orgId, {
    limit: 200,
    offset: 0,
    sort: 'full_name',
    order: 'asc',
    includePending: true,
    pendingLimit: 50,
    pendingOffset: 0,
  })
  return {
    workers: result.workers,
    pending: result.pending,
    territories: result.territories,
    roles: result.roles,
  }
}

async function listTerritories(orgId: string): Promise<TerritoryOption[]> {
  if (isPostgresMode()) {
    const res = await dbQuery<TerritoryOption>(
      `SELECT id, name FROM territories WHERE organization_id = $1 ORDER BY name ASC`,
      [orgId],
    )
    return res.rows
  }
  const supabase = createSupabaseServiceClient()
  const { data } = await supabase
    .from('territories')
    .select('id, name')
    .eq('organization_id', orgId)
    .order('name', { ascending: true })
  return (data ?? []) as TerritoryOption[]
}

function parseMetadata(raw: unknown): Record<string, unknown> | null | { error: string } {
  if (raw === undefined || raw === null || raw === '') return null
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  if (typeof raw !== 'string') return { error: 'metadata_json must be valid JSON' }
  const s = raw.trim()
  if (!s) return null
  try {
    const v = JSON.parse(s) as unknown
    if (v === null || typeof v !== 'object' || Array.isArray(v)) {
      return { error: 'metadata_json must be a JSON object' }
    }
    return v as Record<string, unknown>
  } catch {
    return { error: 'metadata_json must be valid JSON' }
  }
}

export async function createOrgUser(
  user: { id: string; organization_id: string; roles?: { name: string } | null },
  body: Record<string, unknown>,
) {
  if (!canAccessWorkersPage(user.roles?.name)) {
    return { ok: false as const, status: 403, error: 'Insufficient role' }
  }

  const full_name = clean(body.full_name, 200)
  if (!full_name) {
    return { ok: false as const, status: 400, error: 'full_name is required' }
  }

  const role_id =
    typeof body.role_id === 'string' && body.role_id.trim() ? body.role_id.trim() : null
  if (!role_id) {
    return { ok: false as const, status: 400, error: 'role_id is required' }
  }

  const phone = clean(body.phone, 40)
  const emailRaw = clean(body.email, 200)
  const email = emailRaw ? emailRaw.toLowerCase() : null
  const password =
    typeof body.password === 'string' && body.password.length >= 8
      ? body.password
      : typeof body.password === 'string' && body.password.length > 0
        ? null
        : null

  let clerk_user_id = clean(body.clerk_user_id, 120)
  const active = body.active === true || body.active === 'true' || body.active === 'on'
  const territory_id =
    typeof body.territory_id === 'string' && body.territory_id.trim()
      ? body.territory_id.trim()
      : null

  const metadata = parseMetadata(body.metadata_json)
  if (metadata && 'error' in metadata) {
    return { ok: false as const, status: 400, error: metadata.error }
  }

  const supabase = createSupabaseServiceClient()
  const now = new Date().toISOString()

  const { data: role } = await supabase.from('roles').select('id').eq('id', role_id).maybeSingle()
  if (!role) {
    return { ok: false as const, status: 400, error: 'Invalid role_id' }
  }

  if (territory_id) {
    const { data: territory } = await supabase
      .from('territories')
      .select('id')
      .eq('id', territory_id)
      .eq('organization_id', user.organization_id)
      .maybeSingle()
    if (!territory) {
      return { ok: false as const, status: 400, error: 'Invalid territory' }
    }
  }

  let clerkCreatedNew = false

  if (!clerk_user_id) {
    if (!email) {
      return { ok: false as const, status: 400, error: 'email is required for sign-in' }
    }
    if (!password) {
      return {
        ok: false as const,
        status: 400,
        error: 'password is required (min 8 characters) to create Clerk account',
      }
    }

    const existingClerkId = await findClerkUserIdByEmail(email)
    try {
      clerk_user_id = await createClerkUser({
        email,
        password,
        fullName: full_name,
      })
      clerkCreatedNew = !existingClerkId
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Clerk user creation failed'
      return { ok: false as const, status: 502, error: `Clerk: ${msg}` }
    }
  }

  if (clerk_user_id) {
    const { data: existingClerk } = await supabase
      .from('users')
      .select('id')
      .eq('clerk_user_id', clerk_user_id)
      .maybeSingle()
    if (existingClerk) {
      return { ok: false as const, status: 409, error: 'clerk_user_id already linked to a user' }
    }
  }

  if (phone) {
    const { data: existingPhone } = await supabase
      .from('users')
      .select('id')
      .eq('organization_id', user.organization_id)
      .eq('phone', phone)
      .maybeSingle()
    if (existingPhone) {
      return { ok: false as const, status: 409, error: 'A user with this phone already exists' }
    }
  }

  if (email) {
    const { data: existingEmail } = await supabase
      .from('users')
      .select('id')
      .eq('organization_id', user.organization_id)
      .eq('email', email)
      .maybeSingle()
    if (existingEmail) {
      return { ok: false as const, status: 409, error: 'A user with this email already exists' }
    }
  }

  const insert: Record<string, unknown> = {
    organization_id: user.organization_id,
    full_name,
    phone,
    email,
    role_id,
    active,
    clerk_user_id,
    metadata_json: metadata,
    updated_at: now,
  }

  if (active && AUTO_APPROVE_ROLES.includes(user.roles?.name ?? '')) {
    insert.approved_by = user.id
    insert.approved_at = now
  }

  const { data, error } = await supabase.from('users').insert(insert).select('id').single()

  if (error || !data) {
    if (clerkCreatedNew && clerk_user_id) {
      await deleteClerkUser(clerk_user_id)
    }
    return { ok: false as const, status: 500, error: error?.message ?? 'Insert failed' }
  }

  if (territory_id) {
    await supabase.from('user_territories').insert({
      user_id: data.id,
      territory_id,
      is_primary: true,
    })
  }

  await supabase.from('audit_logs').insert({
    organization_id: user.organization_id,
    event_type: 'user_created',
    entity_type: 'user',
    entity_id: data.id,
    actor_type: 'user',
    actor_user_id: user.id,
    new_value_json: { full_name, phone, email, role_id, active },
  })

  return { ok: true as const, id: data.id as string }
}

export async function processActivationRequest(
  user: { id: string; organization_id: string; roles?: { name: string } | null },
  requestId: string,
  body: { action?: string; note?: string },
) {
  if (!canAccessWorkersPage(user.roles?.name)) {
    return { ok: false as const, status: 403, error: 'Insufficient role' }
  }

  const action = body.action
  if (action !== 'approve' && action !== 'reject') {
    return { ok: false as const, status: 400, error: "action must be 'approve' or 'reject'" }
  }

  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : null
  if (action === 'reject' && !note) {
    return { ok: false as const, status: 400, error: 'A reason is required to reject' }
  }

  const supabase = createSupabaseServiceClient()
  const { data: request } = await supabase
    .from('worker_activation_requests')
    .select('id, organization_id, status, full_name, phone, email, territory_id')
    .eq('id', requestId)
    .single()

  if (!request || request.organization_id !== user.organization_id) {
    return { ok: false as const, status: 404, error: 'Request not found' }
  }

  if (request.status !== 'pending') {
    return { ok: false as const, status: 409, error: `Request already ${request.status}` }
  }

  const now = new Date().toISOString()
  const newStatus = action === 'approve' ? 'approved' : 'rejected'

  const { error } = await supabase
    .from('worker_activation_requests')
    .update({
      status: newStatus,
      reviewed_by: user.id,
      review_note: note,
      reviewed_at: now,
    })
    .eq('id', requestId)
    .eq('organization_id', user.organization_id)
    .eq('status', 'pending')

  if (error) return { ok: false as const, status: 500, error: error.message }

  await supabase.from('audit_logs').insert({
    organization_id: user.organization_id,
    event_type:
      action === 'approve' ? 'worker_activation_approved' : 'worker_activation_rejected',
    entity_type: 'worker_activation_request',
    entity_id: requestId,
    actor_type: 'user',
    actor_user_id: user.id,
    new_value_json: {
      status: newStatus,
      full_name: request.full_name,
      review_note: note,
    },
  })

  return { ok: true as const }
}
