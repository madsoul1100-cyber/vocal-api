import { createSupabaseServiceClient } from '@/lib/supabase.js'
import { isPostgresMode, dbQuery } from '@/lib/db.js'
import { hashPassword } from '@/services/authService.js'
import { normalizePhone } from '@/services/otpService.js'
import {
  canApproveStaffCreation,
  canAssignRoleLevel,
  hierarchyLevelForRoleName,
  requiresStaffCreationApproval,
} from '@/lib/roleHierarchy.js'
import {
  deriveUserStaffStatus,
  type StaffCategoryCounts,
  type StaffStatus,
} from '@/lib/staffStatus.js'
import { sanitizeKycDocumentsForDb, type StaffKycDocument } from '@/types/staffDocuments.js'
import {
  DEFAULT_STAFF_PROFILE_STORAGE_PATH,
  isDefaultStaffProfilePath,
} from '@/constants/staffProfileDefaults.js'
import {
  enrichStaffMediaUrls,
  ensureDefaultStaffProfileAsset,
  readStaffStorageObject,
  resolveStaffProfileStoragePath,
} from '@/services/staffStorageService.js'
import { listOrgTerritories, validateTerritoryIdsForOrg } from '@/services/territoryService.js'

export type { StaffStatus, StaffCategoryCounts }

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
  hierarchy_level: number
}

interface RoleRef {
  id: string
  name: string
  hierarchy_level: number
}

async function listAllRoles(): Promise<RoleOption[]> {
  if (isPostgresMode()) {
    const res = await dbQuery<RoleOption>(
      `SELECT id, name, display_name, hierarchy_level
       FROM roles WHERE active = true ORDER BY hierarchy_level ASC, display_name ASC`,
    )
    return res.rows.map(normalizeRoleOption)
  }
  const supabase = createSupabaseServiceClient()
  const { data } = await supabase
    .from('roles')
    .select('id, name, display_name, hierarchy_level')
    .eq('active', true)
    .order('hierarchy_level', { ascending: true })
    .order('display_name', { ascending: true })
  return ((data ?? []) as RoleOption[]).map(normalizeRoleOption)
}

function normalizeRoleOption(role: RoleOption): RoleOption {
  return {
    ...role,
    hierarchy_level: role.hierarchy_level ?? hierarchyLevelForRoleName(role.name) ?? 99,
  }
}

/** Roles the actor may assign when creating or editing staff (strictly below their level). */
export async function listAssignableRoles(actorRoleName: string | null | undefined): Promise<RoleOption[]> {
  const actorLevel = hierarchyLevelForRoleName(actorRoleName)
  if (actorLevel == null) return []
  const all = await listAllRoles()
  return all.filter((r) => canAssignRoleLevel(actorLevel, r.hierarchy_level))
}

async function loadRoleById(roleId: string): Promise<RoleRef | null> {
  if (isPostgresMode()) {
    const res = await dbQuery<RoleRef>(
      `SELECT id, name, hierarchy_level FROM roles WHERE id = $1 AND active = true`,
      [roleId],
    )
    const row = res.rows[0]
    if (!row) return null
    return {
      ...row,
      hierarchy_level: row.hierarchy_level ?? hierarchyLevelForRoleName(row.name) ?? 99,
    }
  }
  const supabase = createSupabaseServiceClient()
  const { data } = await supabase
    .from('roles')
    .select('id, name, hierarchy_level')
    .eq('id', roleId)
    .eq('active', true)
    .maybeSingle()
  if (!data) return null
  const row = data as RoleRef
  return {
    ...row,
    hierarchy_level: row.hierarchy_level ?? hierarchyLevelForRoleName(row.name) ?? 99,
  }
}

async function loadActorRole(
  user: { role_id?: string; roles?: { name: string; hierarchy_level?: number } | null },
): Promise<RoleRef | null> {
  if (user.roles?.name) {
    const level =
      user.roles.hierarchy_level ?? hierarchyLevelForRoleName(user.roles.name) ?? 99
    return {
      id: user.role_id ?? '',
      name: user.roles.name,
      hierarchy_level: level,
    }
  }
  if (user.role_id) return loadRoleById(user.role_id)
  return null
}

function assertCanAssignRole(
  actorRole: RoleRef,
  targetRole: RoleRef,
): { ok: true } | { ok: false; status: number; error: string } {
  if (!canAssignRoleLevel(actorRole.hierarchy_level, targetRole.hierarchy_level)) {
    return {
      ok: false,
      status: 403,
      error: `You cannot assign the role "${targetRole.name.replace(/_/g, ' ')}" — only roles below your level (${actorRole.name.replace(/_/g, ' ')})`,
    }
  }
  return { ok: true }
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
  approved_at: string | null
  staff_status: StaffStatus
  last_login_at: string | null
  created_at: string
  image_url: string | null
  profile_image_url: string | null
  roles: { name: string; display_name: string | null } | null
}

function mapWorkerRow(raw: {
  id: string
  full_name: string
  phone: string | null
  email: string | null
  active: boolean
  approved_at?: string | null
  last_login_at: string | null
  created_at: string
  image_url?: string | null
  roles: WorkerRow['roles']
}): WorkerRow {
  const approved_at = raw.approved_at ?? null
  return {
    ...raw,
    approved_at,
    staff_status: deriveUserStaffStatus(raw.active === true, approved_at),
    image_url: raw.image_url ?? null,
    profile_image_url: null,
  }
}

async function enrichWorkerListRows<T extends { image_url?: string | null }>(
  rows: T[],
): Promise<(T & { image_url: string | null; profile_image_url: string | null })[]> {
  if (rows.length === 0) return []

  const needsDefaultAsset = rows.some((row) => isDefaultStaffProfilePath(row.image_url))
  if (needsDefaultAsset) {
    await ensureDefaultStaffProfileAsset()
  }

  return Promise.all(
    rows.map(async (row) => {
      const image_url =
        typeof row.image_url === 'string' && row.image_url.trim() ? row.image_url.trim() : null
      const { profile_image_url } = await enrichStaffMediaUrls({
        image_url,
        kyc_documents: [],
      })
      return { ...row, image_url, profile_image_url }
    }),
  )
}

export interface WorkerTerritoryRef {
  id: string
  name: string
  is_primary: boolean
}

export type StaffKycDocumentWithUrl = StaffKycDocument & { download_url: string | null }

export interface WorkerDetailRow extends WorkerRow {
  role_id: string
  clerk_user_id: string | null
  notes: string | null
  image_url: string | null
  profile_image_url: string | null
  kyc_documents: StaffKycDocumentWithUrl[]
  territories: WorkerTerritoryRef[]
}

export interface PendingActivationRow {
  id: string
  full_name: string
  phone: string | null
  email: string | null
  status: string
  staff_status: 'pending'
  created_at: string
  image_url: string | null
  profile_image_url: string | null
  territories: { name: string } | null
  roles: { name: string; display_name: string | null } | null
  requested_by_user: { full_name: string } | null
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
  /** When set, only activation requests submitted by this user (district leaders). */
  pendingRequestedBy?: string
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

  const workersRes = await dbQuery<WorkerRow & { approved_at: string | null }>(
    `SELECT u.id, u.full_name, u.phone, u.email, u.active, u.approved_at, u.last_login_at, u.created_at,
            u.image_url,
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
    const pendingWhere = opts.pendingRequestedBy
      ? `war.organization_id = $1 AND war.status = 'pending' AND war.requested_by = $2`
      : `war.organization_id = $1 AND war.status = 'pending'`
    const pendingCountParams = opts.pendingRequestedBy
      ? [orgId, opts.pendingRequestedBy]
      : [orgId]

    const pendingCountRes = await dbQuery<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM worker_activation_requests war WHERE ${pendingWhere}`,
      pendingCountParams,
    )
    pendingTotal = Number(pendingCountRes.rows[0]?.c ?? 0)

    const pendingLimitParam = pendingCountParams.length + 1
    const pendingOffsetParam = pendingCountParams.length + 2
    const pendingRes = await dbQuery<PendingActivationRow & { image_url: string | null }>(
      `SELECT war.id, war.full_name, war.phone, war.email, war.status, war.created_at, war.image_url,
              CASE WHEN t.id IS NULL THEN NULL
                   ELSE jsonb_build_object('name', t.name)
              END AS territories,
              CASE WHEN r.id IS NULL THEN NULL
                   ELSE jsonb_build_object('name', r.name, 'display_name', r.display_name)
              END AS roles,
              CASE WHEN ru.id IS NULL THEN NULL
                   ELSE jsonb_build_object('full_name', ru.full_name)
              END AS requested_by_user
       FROM worker_activation_requests war
       LEFT JOIN territories t ON t.id = war.territory_id
       LEFT JOIN roles r ON r.id = war.role_id
       LEFT JOIN users ru ON ru.id = war.requested_by
       WHERE ${pendingWhere}
       ORDER BY war.created_at DESC
       LIMIT $${pendingLimitParam} OFFSET $${pendingOffsetParam}`,
      [...pendingCountParams, opts.pendingLimit, opts.pendingOffset],
    )
    pending = pendingRes.rows.map((row) => ({
      ...row,
      staff_status: 'pending' as const,
      profile_image_url: null,
    }))
  }

  const workers = await enrichWorkerListRows(workersRes.rows.map(mapWorkerRow))
  const pendingEnriched = await enrichWorkerListRows(pending)

  return {
    workers,
    pagination: buildWorkersV2Pagination(opts.offset, opts.limit, total),
    pending: pendingEnriched,
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
    'id, full_name, phone, email, active, approved_at, last_login_at, created_at, image_url',
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
    let pendingQuery = supabase
      .from('worker_activation_requests')
      .select(
        'id, full_name, phone, email, status, created_at, image_url, territories(name), roles(name, display_name), users!requested_by(full_name)',
        { count: 'exact' },
      )
      .eq('organization_id', orgId)
      .eq('status', 'pending')
    if (opts.pendingRequestedBy) {
      pendingQuery = pendingQuery.eq('requested_by', opts.pendingRequestedBy)
    }
    pendingQuery = pendingQuery
      .order('created_at', { ascending: false })
      .range(opts.pendingOffset, opts.pendingOffset + opts.pendingLimit - 1)

    const pendingRes = await pendingQuery
    if (pendingRes.error) throw new Error(pendingRes.error.message)
    pending = ((pendingRes.data ?? []) as Array<Record<string, unknown>>).map((row) => {
      const requester = row.users as { full_name?: string } | { full_name?: string }[] | null
      const requesterName = Array.isArray(requester)
        ? requester[0]?.full_name
        : requester?.full_name
      return {
        ...(row as unknown as PendingActivationRow),
        staff_status: 'pending' as const,
        image_url: (row.image_url as string | null) ?? null,
        profile_image_url: null,
        requested_by_user: requesterName ? { full_name: requesterName } : null,
      }
    })
    pendingTotal = pendingRes.count ?? 0
  }

  const workersMapped = ((data ?? []) as unknown as Array<Record<string, unknown>>).map((row) =>
    mapWorkerRow({
      id: row.id as string,
      full_name: row.full_name as string,
      phone: (row.phone as string | null) ?? null,
      email: (row.email as string | null) ?? null,
      active: row.active === true,
      approved_at: (row.approved_at as string | null) ?? null,
      last_login_at: (row.last_login_at as string | null) ?? null,
      created_at: row.created_at as string,
      image_url: (row.image_url as string | null) ?? null,
      roles: row.roles as WorkerRow['roles'],
    }),
  )

  const workers = await enrichWorkerListRows(workersMapped)
  const pendingEnriched = await enrichWorkerListRows(pending)

  return {
    workers,
    pagination: buildWorkersV2Pagination(opts.offset, opts.limit, count ?? 0),
    pending: pendingEnriched,
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
  actorRoleName?: string | null,
): Promise<WorkersListV2Result> {
  const [listPart, summary, territories, roles] = await Promise.all([
    isPostgresMode() ? listWorkersV2Pg(orgId, opts) : listWorkersV2Supabase(orgId, opts),
    isPostgresMode() ? getWorkersOrgSummaryPg(orgId) : getWorkersOrgSummarySupabase(orgId),
    listTerritories(orgId),
    listAssignableRoles(actorRoleName),
  ])

  return { ...listPart, summary, territories, roles }
}

function buildStaffCategories(
  workers: WorkerRow[],
  pendingRequests: PendingActivationRow[],
): StaffCategoryCounts {
  const active = workers.filter((w) => w.staff_status === 'active').length
  const inactive = workers.filter((w) => w.staff_status === 'inactive').length
  const awaitingApproval = workers.filter((w) => w.staff_status === 'pending').length
  const pending = pendingRequests.length + awaitingApproval
  return {
    pending,
    active,
    inactive,
    total: workers.length + pendingRequests.length,
  }
}

/** @deprecated Use listWorkersV2 — kept for v1 compat (first 200 workers, 50 pending). */
export async function getWorkersPageData(
  orgId: string,
  actor?: { roleName?: string | null; userId?: string },
): Promise<{
  workers: WorkerRow[]
  active_workers: WorkerRow[]
  inactive_workers: WorkerRow[]
  awaiting_approval_workers: WorkerRow[]
  pending: PendingActivationRow[]
  categories: StaffCategoryCounts
  territories: TerritoryOption[]
  roles: RoleOption[]
  can_approve_staff: boolean
}> {
  const actorRoleName = actor?.roleName
  const canApprove = canApproveStaffCreation(actorRoleName)

  const result = await listWorkersV2(
    orgId,
    {
      limit: 200,
      offset: 0,
      sort: 'full_name',
      order: 'asc',
      includePending: true,
      pendingLimit: 50,
      pendingOffset: 0,
      pendingRequestedBy: canApprove ? undefined : actor?.userId,
    },
    actorRoleName,
  )

  const active_workers = result.workers.filter((w) => w.staff_status === 'active')
  const inactive_workers = result.workers.filter((w) => w.staff_status === 'inactive')
  const awaiting_approval_workers = result.workers.filter((w) => w.staff_status === 'pending')

  return {
    workers: result.workers,
    active_workers,
    inactive_workers,
    awaiting_approval_workers,
    pending: result.pending,
    categories: buildStaffCategories(result.workers, result.pending),
    territories: result.territories,
    roles: result.roles,
    can_approve_staff: canApprove,
  }
}

async function listTerritories(orgId: string): Promise<TerritoryOption[]> {
  return listOrgTerritories(orgId)
}

/** Parse territory_ids from multipart/JSON body (supports legacy territory_id). */
export function parseTerritoryIdsFromBody(body: Record<string, unknown>): string[] {
  const ids: string[] = []
  const raw = body.territory_ids

  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw) as unknown
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (typeof item === 'string' && item.trim()) ids.push(item.trim())
        }
      }
    } catch {
      for (const part of raw.split(',')) {
        const t = part.trim()
        if (t) ids.push(t)
      }
    }
  } else if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === 'string' && item.trim()) ids.push(item.trim())
    }
  }

  if (ids.length === 0) {
    const legacy = body.territory_id
    if (typeof legacy === 'string' && legacy.trim()) ids.push(legacy.trim())
  }

  return [...new Set(ids)]
}

function resolvePrimaryTerritoryId(
  body: Record<string, unknown>,
  territoryIds: string[],
): string | null {
  const raw = body.primary_territory_id
  if (typeof raw === 'string' && raw.trim()) {
    const id = raw.trim()
    if (territoryIds.includes(id)) return id
  }
  return territoryIds[0] ?? null
}

function cleanNotes(raw: unknown): string | null {
  return clean(raw, 5000)
}

function parseStaffProfileFromBody(body: Record<string, unknown>): {
  notes: string | null
  image_url: string | null
  kyc_documents: StaffKycDocument[]
} {
  const notes = cleanNotes(body.notes)
  const image_url =
    typeof body.image_url === 'string' && body.image_url.trim() ? body.image_url.trim() : null
  const kyc_documents = sanitizeKycDocumentsForDb(body.kyc_documents)
  return { notes, image_url, kyc_documents }
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

async function assertUniqueStaffContact(
  orgId: string,
  phone: string | null,
  email: string | null,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const supabase = createSupabaseServiceClient()
  if (phone) {
    const { data: existingPhone } = await supabase
      .from('users')
      .select('id')
      .eq('organization_id', orgId)
      .eq('phone', phone)
      .maybeSingle()
    if (existingPhone) {
      return { ok: false, status: 409, error: 'A user with this phone already exists' }
    }
  }
  if (email) {
    const { data: existingEmail } = await supabase
      .from('users')
      .select('id')
      .eq('organization_id', orgId)
      .eq('email', email)
      .maybeSingle()
    if (existingEmail) {
      return { ok: false, status: 409, error: 'A user with this email already exists' }
    }
    const { data: pendingEmail } = await supabase
      .from('worker_activation_requests')
      .select('id')
      .eq('organization_id', orgId)
      .eq('email', email)
      .eq('status', 'pending')
      .maybeSingle()
    if (pendingEmail) {
      return {
        ok: false,
        status: 409,
        error: 'A pending activation request already exists for this email',
      }
    }
  }
  return { ok: true }
}

export async function createOrgUser(
  user: {
    id: string
    organization_id: string
    role_id?: string
    roles?: { name: string; hierarchy_level?: number } | null
  },
  body: Record<string, unknown>,
) {
  if (!canAccessWorkersPage(user.roles?.name)) {
    return { ok: false as const, status: 403, error: 'Insufficient role' }
  }

  const actorRole = await loadActorRole(user)
  if (!actorRole) {
    return { ok: false as const, status: 403, error: 'Could not resolve your role' }
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

  const targetRole = await loadRoleById(role_id)
  if (!targetRole) {
    return { ok: false as const, status: 400, error: 'Invalid role_id' }
  }

  const assignCheck = assertCanAssignRole(actorRole, targetRole)
  if (!assignCheck.ok) {
    return { ok: false as const, status: assignCheck.status, error: assignCheck.error }
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

  const active = body.active === true || body.active === 'true' || body.active === 'on'
  const territoryIdsParsed = parseTerritoryIdsFromBody(body)
  const territoryCheck = await validateTerritoryIdsForOrg(
    user.organization_id,
    territoryIdsParsed,
  )
  if (!territoryCheck.ok) {
    return { ok: false as const, status: 400, error: territoryCheck.error }
  }
  const territory_ids = territoryCheck.ids
  const territory_id = resolvePrimaryTerritoryId(body, territory_ids)

  const profile = parseStaffProfileFromBody(body)
  if (!profile.image_url) {
    const asset = await ensureDefaultStaffProfileAsset()
    if (!asset.ok) {
      return { ok: false as const, status: 500, error: asset.error }
    }
    profile.image_url = asset.storage_path
  }

  const supabase = createSupabaseServiceClient()
  const now = new Date().toISOString()

  if (!email) {
    return { ok: false as const, status: 400, error: 'email is required for sign-in' }
  }

  if (!password && !phone) {
    return {
      ok: false as const,
      status: 400,
      error: 'phone is required when no password is set (staff will sign in via OTP)',
    }
  }

  let password_hash: string | null = null
  if (password) {
    try {
      password_hash = await hashPassword(password)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Password hashing failed'
      return { ok: false as const, status: 500, error: msg }
    }
  }

  const uniqueCheck = await assertUniqueStaffContact(user.organization_id, phone, email)
  if (!uniqueCheck.ok) {
    return { ok: false as const, status: uniqueCheck.status, error: uniqueCheck.error }
  }

  if (requiresStaffCreationApproval(user.roles?.name)) {
    const { data: requestRow, error: requestError } = await supabase
      .from('worker_activation_requests')
      .insert({
        organization_id: user.organization_id,
        requested_by: user.id,
        full_name,
        phone,
        email,
        territory_id,
        role_id,
        password_hash,
        notes: profile.notes,
        image_url: profile.image_url,
        kyc_documents: profile.kyc_documents,
        active_requested: active,
        status: 'pending',
        metadata_json: territory_ids.length ? { territory_ids } : null,
      })
      .select('id')
      .single()

    if (requestError || !requestRow) {
      return {
        ok: false as const,
        status: 500,
        error: requestError?.message ?? 'Failed to submit activation request',
      }
    }

    await supabase.from('audit_logs').insert({
      organization_id: user.organization_id,
      event_type: 'worker_activation_requested',
      entity_type: 'worker_activation_request',
      entity_id: requestRow.id,
      actor_type: 'user',
      actor_user_id: user.id,
      new_value_json: { full_name, phone, email, role_id, active_requested: active },
    })

    return {
      ok: true as const,
      pending_approval: true as const,
      request_id: requestRow.id as string,
    }
  }

  const insert: Record<string, unknown> = {
    organization_id: user.organization_id,
    full_name,
    phone,
    email,
    role_id,
    active,
    password_hash,
    notes: profile.notes,
    image_url: profile.image_url,
    kyc_documents: profile.kyc_documents,
    updated_at: now,
  }

  if (active && AUTO_APPROVE_ROLES.includes(user.roles?.name ?? '')) {
    insert.approved_by = user.id
    insert.approved_at = now
  }

  const { data, error } = await supabase.from('users').insert(insert).select('id').single()

  if (error || !data) {
    return { ok: false as const, status: 500, error: error?.message ?? 'Insert failed' }
  }

  await syncUserTerritories(user.organization_id, data.id as string, territory_ids, territory_id)

  await supabase.from('audit_logs').insert({
    organization_id: user.organization_id,
    event_type: 'user_created',
    entity_type: 'user',
    entity_id: data.id,
    actor_type: 'user',
    actor_user_id: user.id,
    new_value_json: { full_name, phone, email, role_id, active, territory_ids },
  })

  return { ok: true as const, id: data.id as string, pending_approval: false as const }
}

const WORKER_DETAIL_SELECT = `
  id, full_name, phone, email, active, approved_at, last_login_at, created_at, role_id, clerk_user_id,
  notes, image_url, kyc_documents,
  roles(name, display_name),
  user_territories(territory_id, is_primary, territories(id, name))
`

function mapWorkerDetailRow(raw: Record<string, unknown>): WorkerDetailRow {
  const ut = (raw.user_territories ?? []) as Array<{
    territory_id?: string
    is_primary?: boolean
    territories?: { id?: string; name?: string } | null
  }>
  const territories: WorkerTerritoryRef[] = ut
    .map((row) => {
      const t = row.territories
      if (!t?.id) return null
      return {
        id: t.id,
        name: t.name ?? '',
        is_primary: row.is_primary === true,
      }
    })
    .filter((t): t is WorkerTerritoryRef => t !== null)

  const rolesRaw = raw.roles as { name?: string; display_name?: string | null } | null
  const approved_at = (raw.approved_at as string | null) ?? null
  const active = raw.active === true

  return {
    id: raw.id as string,
    full_name: raw.full_name as string,
    phone: (raw.phone as string | null) ?? null,
    email: (raw.email as string | null) ?? null,
    active,
    approved_at,
    staff_status: deriveUserStaffStatus(active, approved_at),
    last_login_at: (raw.last_login_at as string | null) ?? null,
    created_at: raw.created_at as string,
    role_id: raw.role_id as string,
    clerk_user_id: (raw.clerk_user_id as string | null) ?? null,
    notes: (raw.notes as string | null) ?? null,
    image_url: (raw.image_url as string | null) ?? null,
    kyc_documents: Array.isArray(raw.kyc_documents)
      ? (raw.kyc_documents as StaffKycDocument[]).map((d) => ({ ...d, download_url: null }))
      : [],
    profile_image_url: null,
    roles: rolesRaw?.name
      ? { name: rolesRaw.name, display_name: rolesRaw.display_name ?? null }
      : null,
    territories,
  }
}

async function loadOrgUserRow(
  orgId: string,
  userId: string,
): Promise<WorkerDetailRow | { error: string } | null> {
  const supabase = createSupabaseServiceClient()
  const { data, error } = await supabase
    .from('users')
    .select(WORKER_DETAIL_SELECT)
    .eq('id', userId)
    .eq('organization_id', orgId)
    .maybeSingle()

  if (error) return { error: error.message }
  if (!data) return null
  return mapWorkerDetailRow(data as Record<string, unknown>)
}

export async function getOrgUserById(
  actor: { organization_id: string; roles?: { name: string } | null },
  userId: string,
) {
  if (!canAccessWorkersPage(actor.roles?.name)) {
    return { ok: false as const, status: 403, error: 'Insufficient role' }
  }

  const row = await loadOrgUserRow(actor.organization_id, userId)
  if (row && 'error' in row) {
    return { ok: false as const, status: 500, error: row.error }
  }
  if (!row) {
    return { ok: false as const, status: 404, error: 'User not found' }
  }
  const worker = await enrichStaffMediaUrls(row)
  return { ok: true as const, worker }
}

export async function streamWorkerStaffMedia(
  actor: { organization_id: string; roles?: { name: string } | null },
  userId: string,
  kind: 'profile' | 'kyc',
  docIndex?: number,
): Promise<
  | { ok: true; data: Buffer; contentType: string; fileName?: string }
  | { ok: false; status: number; error: string }
> {
  if (!canAccessWorkersPage(actor.roles?.name)) {
    return { ok: false, status: 403, error: 'Insufficient role' }
  }

  const row = await loadOrgUserRow(actor.organization_id, userId)
  if (row && 'error' in row) {
    return { ok: false, status: 500, error: row.error }
  }
  if (!row) {
    return { ok: false, status: 404, error: 'User not found' }
  }

  let storagePath: string | null = null
  let fileName: string | undefined
  let contentType: string | undefined

  if (kind === 'profile') {
    storagePath = resolveStaffProfileStoragePath(row.image_url)
    fileName = 'profile.png'
  } else {
    const idx = docIndex ?? -1
    const doc = row.kyc_documents[idx]
    if (!doc) {
      return { ok: false, status: 404, error: 'KYC document not found' }
    }
    storagePath = doc.storage_path
    fileName = doc.file_name
    contentType = doc.mime_type ?? undefined
  }

  if (isDefaultStaffProfilePath(storagePath)) {
    await ensureDefaultStaffProfileAsset()
  }

  const file = await readStaffStorageObject(storagePath)
  if (!file) {
    return { ok: false, status: 404, error: 'File could not be read from storage' }
  }

  return {
    ok: true,
    data: file.data,
    contentType: contentType ?? file.contentType,
    fileName,
  }
}

async function syncUserTerritories(
  orgId: string,
  userId: string,
  territoryIds: string[],
  primaryTerritoryId: string | null,
) {
  const supabase = createSupabaseServiceClient()
  await supabase.from('user_territories').delete().eq('user_id', userId)

  if (territoryIds.length === 0) return

  const primary =
    primaryTerritoryId && territoryIds.includes(primaryTerritoryId)
      ? primaryTerritoryId
      : territoryIds[0]!

  for (const territory_id of territoryIds) {
    await supabase.from('user_territories').insert({
      user_id: userId,
      territory_id,
      is_primary: territory_id === primary,
    })
  }
}

export async function updateOrgUser(
  actor: { id: string; organization_id: string; roles?: { name: string } | null },
  userId: string,
  body: Record<string, unknown>,
) {
  if (!canAccessWorkersPage(actor.roles?.name)) {
    return { ok: false as const, status: 403, error: 'Insufficient role' }
  }

  const supabase = createSupabaseServiceClient()
  const { data: current } = await supabase
    .from('users')
    .select('id, organization_id, active, approved_at')
    .eq('id', userId)
    .eq('organization_id', actor.organization_id)
    .maybeSingle()

  if (!current) {
    return { ok: false as const, status: 404, error: 'User not found' }
  }

  const now = new Date().toISOString()
  const updates: Record<string, unknown> = { updated_at: now }
  const auditChanges: Record<string, unknown> = {}

  if ('full_name' in body) {
    const full_name = clean(body.full_name, 200)
    if (!full_name) {
      return { ok: false as const, status: 400, error: 'full_name cannot be empty' }
    }
    updates.full_name = full_name
    auditChanges.full_name = full_name
  }

  if ('phone' in body) {
    const phoneRaw = clean(body.phone, 40)
    const phone = phoneRaw ? normalizePhone(phoneRaw) ?? phoneRaw : null
    if (phone) {
      const { data: existingPhone } = await supabase
        .from('users')
        .select('id')
        .eq('organization_id', actor.organization_id)
        .eq('phone', phone)
        .neq('id', userId)
        .maybeSingle()
      if (existingPhone) {
        return { ok: false as const, status: 409, error: 'A user with this phone already exists' }
      }
    }
    updates.phone = phone
    auditChanges.phone = phone
  }

  if ('email' in body) {
    const emailRaw = clean(body.email, 200)
    const email = emailRaw ? emailRaw.toLowerCase() : null
    if (email) {
      const { data: existingEmail } = await supabase
        .from('users')
        .select('id')
        .eq('organization_id', actor.organization_id)
        .eq('email', email)
        .neq('id', userId)
        .maybeSingle()
      if (existingEmail) {
        return { ok: false as const, status: 409, error: 'A user with this email already exists' }
      }
    }
    updates.email = email
    auditChanges.email = email
  }

  if ('role_id' in body) {
    const role_id =
      typeof body.role_id === 'string' && body.role_id.trim() ? body.role_id.trim() : null
    if (!role_id) {
      return { ok: false as const, status: 400, error: 'role_id cannot be empty' }
    }
    const actorRole = await loadActorRole(actor)
    const targetRole = await loadRoleById(role_id)
    if (!actorRole) {
      return { ok: false as const, status: 403, error: 'Could not resolve your role' }
    }
    if (!targetRole) {
      return { ok: false as const, status: 400, error: 'Invalid role_id' }
    }
    const assignCheck = assertCanAssignRole(actorRole, targetRole)
    if (!assignCheck.ok) {
      return { ok: false as const, status: assignCheck.status, error: assignCheck.error }
    }
    updates.role_id = role_id
    auditChanges.role_id = role_id
  }

  const canApprove = AUTO_APPROVE_ROLES.includes(actor.roles?.name ?? '')

  if ('staff_status' in body) {
    const raw = typeof body.staff_status === 'string' ? body.staff_status.trim().toLowerCase() : ''
    if (raw !== 'active' && raw !== 'pending' && raw !== 'inactive') {
      return { ok: false as const, status: 400, error: 'staff_status must be active, pending, or inactive' }
    }

    if (raw === 'inactive') {
      updates.active = false
      auditChanges.staff_status = raw
    } else if (raw === 'pending') {
      if (!canApprove) {
        return {
          ok: false as const,
          status: 403,
          error: 'Only Super Admin or Central Support can set pending status',
        }
      }
      updates.active = true
      updates.approved_at = null
      updates.approved_by = null
      auditChanges.staff_status = raw
    } else {
      updates.active = true
      if (current.approved_at) {
        auditChanges.staff_status = raw
      } else if (canApprove) {
        updates.approved_by = actor.id
        updates.approved_at = now
        auditChanges.staff_status = raw
      } else {
        return {
          ok: false as const,
          status: 403,
          error: 'Only Super Admin or Central Support can approve and activate workers',
        }
      }
    }
  } else if ('active' in body) {
    const active = body.active === true || body.active === 'true' || body.active === 'on'
    updates.active = active
    auditChanges.active = active
    if (active && canApprove && (!current.approved_at || !current.active)) {
      updates.approved_by = actor.id
      updates.approved_at = now
    }
  }

  if ('notes' in body) {
    updates.notes = cleanNotes(body.notes)
    auditChanges.notes = updates.notes
  }

  if ('image_url' in body) {
    const image_url =
      typeof body.image_url === 'string' && body.image_url.trim() ? body.image_url.trim() : null
    updates.image_url = image_url
    auditChanges.image_url = image_url
  }

  if ('kyc_documents' in body) {
    const kyc_documents = sanitizeKycDocumentsForDb(body.kyc_documents)
    updates.kyc_documents = kyc_documents
    auditChanges.kyc_documents = kyc_documents
  }

  if ('password' in body) {
    const pwd =
      typeof body.password === 'string' && body.password.length >= 8 ? body.password : null
    if (!pwd) {
      return {
        ok: false as const,
        status: 400,
        error: 'password must be at least 8 characters',
      }
    }
    try {
      updates.password_hash = await hashPassword(pwd)
      auditChanges.password_reset = true
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Password hashing failed'
      return { ok: false as const, status: 500, error: msg }
    }
  }

  const territoriesInBody = 'territory_ids' in body || 'territory_id' in body
  let territoryIdsToSync: string[] | undefined
  let primaryTerritoryId: string | null | undefined
  if (territoriesInBody) {
    const parsed = parseTerritoryIdsFromBody(body)
    const territoryCheck = await validateTerritoryIdsForOrg(actor.organization_id, parsed)
    if (!territoryCheck.ok) {
      return { ok: false as const, status: 400, error: territoryCheck.error }
    }
    territoryIdsToSync = territoryCheck.ids
    primaryTerritoryId = resolvePrimaryTerritoryId(body, territoryIdsToSync)
    auditChanges.territory_ids = territoryIdsToSync
    auditChanges.primary_territory_id = primaryTerritoryId
  }

  if (Object.keys(updates).length === 1 && !territoriesInBody) {
    return { ok: false as const, status: 400, error: 'No fields to update' }
  }

  if (Object.keys(updates).length > 1) {
    const { error } = await supabase
      .from('users')
      .update(updates)
      .eq('id', userId)
      .eq('organization_id', actor.organization_id)

    if (error) return { ok: false as const, status: 500, error: error.message }
  }

  if (territoriesInBody && territoryIdsToSync !== undefined) {
    await syncUserTerritories(
      actor.organization_id,
      userId,
      territoryIdsToSync,
      primaryTerritoryId ?? null,
    )
  }

  if (Object.keys(auditChanges).length > 0) {
    await supabase.from('audit_logs').insert({
      organization_id: actor.organization_id,
      event_type: 'user_updated',
      entity_type: 'user',
      entity_id: userId,
      actor_type: 'user',
      actor_user_id: actor.id,
      new_value_json: auditChanges,
    })
  }

  const refreshed = await loadOrgUserRow(actor.organization_id, userId)
  if (!refreshed || 'error' in refreshed) {
    return { ok: false as const, status: 500, error: 'User updated but reload failed' }
  }

  const worker = await enrichStaffMediaUrls(refreshed)
  return { ok: true as const, worker }
}

/** Soft-deactivate staff (sets active=false; does not delete the users row). */
export async function deactivateOrgUser(
  actor: { id: string; organization_id: string; roles?: { name: string } | null },
  userId: string,
) {
  if (!canAccessWorkersPage(actor.roles?.name)) {
    return { ok: false as const, status: 403, error: 'Insufficient role' }
  }

  if (actor.id === userId) {
    return { ok: false as const, status: 400, error: 'Cannot deactivate your own account' }
  }

  const supabase = createSupabaseServiceClient()
  const { data: current } = await supabase
    .from('users')
    .select('id, organization_id, active, full_name')
    .eq('id', userId)
    .eq('organization_id', actor.organization_id)
    .maybeSingle()

  if (!current) {
    return { ok: false as const, status: 404, error: 'User not found' }
  }

  if (!current.active) {
    return { ok: true as const, already_inactive: true as const }
  }

  const now = new Date().toISOString()
  const { error } = await supabase
    .from('users')
    .update({ active: false, updated_at: now })
    .eq('id', userId)
    .eq('organization_id', actor.organization_id)

  if (error) return { ok: false as const, status: 500, error: error.message }

  await supabase.from('audit_logs').insert({
    organization_id: actor.organization_id,
    event_type: 'user_deactivated',
    entity_type: 'user',
    entity_id: userId,
    actor_type: 'user',
    actor_user_id: actor.id,
    new_value_json: { full_name: current.full_name, active: false },
  })

  return { ok: true as const }
}

export async function processActivationRequest(
  user: { id: string; organization_id: string; roles?: { name: string } | null },
  requestId: string,
  body: { action?: string; note?: string },
) {
  if (!canApproveStaffCreation(user.roles?.name)) {
    return {
      ok: false as const,
      status: 403,
      error: 'Only Super Admin or Central Support can approve worker requests',
    }
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
    .select(
      'id, organization_id, status, full_name, phone, email, territory_id, role_id, password_hash, notes, image_url, kyc_documents, active_requested, metadata_json',
    )
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

  if (action === 'approve') {
    if (!request.role_id) {
      return {
        ok: false as const,
        status: 400,
        error: 'Request is missing role — cannot approve',
      }
    }

    if (!request.password_hash && !request.phone) {
      return {
        ok: false as const,
        status: 400,
        error: 'Request must include phone for OTP sign-in when no password was set',
      }
    }

    const email = request.email ? String(request.email).toLowerCase() : null
    if (!email) {
      return { ok: false as const, status: 400, error: 'Request is missing sign-in email' }
    }

    const uniqueCheck = await assertUniqueStaffContact(
      user.organization_id,
      request.phone as string | null,
      email,
    )
    if (!uniqueCheck.ok) {
      return { ok: false as const, status: uniqueCheck.status, error: uniqueCheck.error }
    }

    const active = request.active_requested === true
    const insert: Record<string, unknown> = {
      organization_id: user.organization_id,
      full_name: request.full_name,
      phone: request.phone,
      email,
      role_id: request.role_id,
      active,
      password_hash: request.password_hash,
      notes: request.notes,
      image_url: request.image_url,
      kyc_documents: request.kyc_documents ?? [],
      approved_by: user.id,
      approved_at: now,
      updated_at: now,
    }

    const { data: created, error: createError } = await supabase
      .from('users')
      .insert(insert)
      .select('id')
      .single()

    if (createError || !created) {
      return { ok: false as const, status: 500, error: createError?.message ?? 'User create failed' }
    }

    const meta = request.metadata_json as { territory_ids?: string[] } | null
    const activationTerritoryIds = Array.isArray(meta?.territory_ids)
      ? meta!.territory_ids!.filter((id) => typeof id === 'string')
      : request.territory_id
        ? [request.territory_id as string]
        : []
    const territoryCheck = await validateTerritoryIdsForOrg(
      user.organization_id,
      activationTerritoryIds,
    )
    if (!territoryCheck.ok) {
      return { ok: false as const, status: 400, error: territoryCheck.error }
    }
    await syncUserTerritories(
      user.organization_id,
      created.id as string,
      territoryCheck.ids,
      (request.territory_id as string | null) ?? territoryCheck.ids[0] ?? null,
    )

    await supabase.from('audit_logs').insert({
      organization_id: user.organization_id,
      event_type: 'user_created',
      entity_type: 'user',
      entity_id: created.id,
      actor_type: 'user',
      actor_user_id: user.id,
      new_value_json: {
        from_activation_request: requestId,
        full_name: request.full_name,
        email,
        role_id: request.role_id,
        active,
      },
    })
  }

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
