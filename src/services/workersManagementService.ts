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

export async function getWorkersPageData(orgId: string): Promise<{
  workers: WorkerRow[]
  pending: PendingActivationRow[]
  territories: TerritoryOption[]
  roles: RoleOption[]
}> {
  if (isPostgresMode()) {
    return getWorkersPageDataPg(orgId)
  }
  return getWorkersPageDataSupabase(orgId)
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

async function getWorkersPageDataPg(orgId: string) {
  const workersRes = await dbQuery<WorkerRow>(
    `SELECT u.id, u.full_name, u.phone, u.email, u.active, u.last_login_at, u.created_at,
            jsonb_build_object('name', r.name, 'display_name', r.display_name) AS roles
     FROM users u
     INNER JOIN roles r ON r.id = u.role_id
     WHERE u.organization_id = $1
     ORDER BY u.full_name ASC
     LIMIT 200`,
    [orgId],
  )

  const pendingRes = await dbQuery<PendingActivationRow>(
    `SELECT war.id, war.full_name, war.phone, war.email, war.status, war.created_at,
            CASE WHEN t.id IS NULL THEN NULL
                 ELSE jsonb_build_object('name', t.name)
            END AS territories
     FROM worker_activation_requests war
     LEFT JOIN territories t ON t.id = war.territory_id
     WHERE war.organization_id = $1 AND war.status = 'pending'
     ORDER BY war.created_at DESC
     LIMIT 50`,
    [orgId],
  )

  const [territories, roles] = await Promise.all([listTerritories(orgId), listRoles()])
  return { workers: workersRes.rows, pending: pendingRes.rows, territories, roles }
}

async function getWorkersPageDataSupabase(orgId: string) {
  const supabase = createSupabaseServiceClient()
  const [workersRes, pendingRes, territories, roles] = await Promise.all([
    supabase
      .from('users')
      .select('id, full_name, phone, email, active, last_login_at, created_at, roles(name, display_name)')
      .eq('organization_id', orgId)
      .order('full_name', { ascending: true })
      .limit(200),
    supabase
      .from('worker_activation_requests')
      .select('id, full_name, phone, email, status, created_at, territories(name)')
      .eq('organization_id', orgId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(50),
    listTerritories(orgId),
    listRoles(),
  ])

  return {
    workers: (workersRes.data ?? []) as unknown as WorkerRow[],
    pending: (pendingRes.data ?? []) as unknown as PendingActivationRow[],
    territories,
    roles,
  }
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
