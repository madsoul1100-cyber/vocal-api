import { createSupabaseServiceClient } from '@/lib/supabase.js'
import { isPostgresMode, dbQuery } from '@/lib/db.js'
import {
  findNearestAvailableWorker,
  offerTicketToWorker,
  type CandidateWorker,
} from '@/services/assignmentService.js'

export const ASSIGN_TICKET_ROLES = ['super_admin', 'central_support'] as const

const GROUND_WORKER_ROLE_ID = '00000000-0000-0000-0000-000000000005'

type VocalUser = {
  id: string
  organization_id: string
  roles?: { name: string } | null
}

export function canAssignTickets(role: string | null | undefined): boolean {
  return !!role && (ASSIGN_TICKET_ROLES as readonly string[]).includes(role)
}

export interface TicketCurrentAssignment {
  id: string
  status: string
  offered_at: string
  expires_at: string | null
  worker: { id: string; full_name: string }
}

export interface AssignableWorker {
  id: string
  full_name: string
  territory_ids: string[]
}

export const ASSIGNABLE_WORKERS_DEFAULT_LIMIT = 20
export const ASSIGNABLE_WORKERS_MAX_LIMIT = 100

export interface AssignableWorkersListOptions {
  limit: number
  offset: number
  keyword?: string
  territoryId?: string
}

export interface AssignableWorkersPagination {
  limit: number
  offset: number
  total: number
  hasNextPage: boolean
  hasPreviousPage: boolean
}

export interface AssignableWorkersListResult {
  workers: AssignableWorker[]
  pagination: AssignableWorkersPagination
}

function sanitizeAssignableKeyword(raw: string): string {
  return raw
    .replace(/[,()."'\\]/g, ' ')
    .replace(/[%_]/g, '')
    .trim()
    .slice(0, 100)
}

export function parseAssignableWorkersQuery(query: Record<string, unknown>): AssignableWorkersListOptions {
  let limit =
    parseInt(String(query.limit ?? ASSIGNABLE_WORKERS_DEFAULT_LIMIT), 10) ||
    ASSIGNABLE_WORKERS_DEFAULT_LIMIT
  limit = Math.min(ASSIGNABLE_WORKERS_MAX_LIMIT, Math.max(1, limit))
  const offset = Math.max(0, parseInt(String(query.offset ?? '0'), 10) || 0)
  const keywordRaw =
    (typeof query.keyword === 'string' && query.keyword) ||
    (typeof query.search === 'string' && query.search) ||
    undefined
  const keyword = keywordRaw ? sanitizeAssignableKeyword(keywordRaw) : undefined
  const territoryId =
    typeof query.territory_id === 'string' && query.territory_id.trim()
      ? query.territory_id.trim()
      : undefined
  return { limit, offset, keyword: keyword || undefined, territoryId }
}

export function assignableWorkersFiltersEcho(opts: AssignableWorkersListOptions) {
  return {
    limit: opts.limit,
    offset: opts.offset,
    keyword: opts.keyword ?? null,
    territory_id: opts.territoryId ?? null,
  }
}

function mapWorkerRows(
  rows: Array<{ id: string; full_name: string; user_territories?: Array<{ territory_id: string }> | null }>,
): AssignableWorker[] {
  return rows.map((w) => {
    const territories = (w.user_territories ?? []) as Array<{ territory_id: string }>
    return {
      id: w.id,
      full_name: w.full_name,
      territory_ids: territories.map((t) => t.territory_id),
    }
  })
}

export async function countAssignableWorkers(organizationId: string): Promise<number> {
  if (isPostgresMode()) {
    const res = await dbQuery<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM users
       WHERE organization_id = $1 AND role_id = $2 AND active = true`,
      [organizationId, GROUND_WORKER_ROLE_ID],
    )
    return Number(res.rows[0]?.c ?? 0)
  }
  const supabase = createSupabaseServiceClient()
  const { count } = await supabase
    .from('users')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', organizationId)
    .eq('role_id', GROUND_WORKER_ROLE_ID)
    .eq('active', true)
  return count ?? 0
}

export async function listAssignableWorkersPaginated(
  organizationId: string,
  opts: AssignableWorkersListOptions,
): Promise<AssignableWorkersListResult> {
  if (isPostgresMode()) return listAssignableWorkersPaginatedPg(organizationId, opts)
  return listAssignableWorkersPaginatedSupabase(organizationId, opts)
}

async function listAssignableWorkersPaginatedPg(
  organizationId: string,
  opts: AssignableWorkersListOptions,
): Promise<AssignableWorkersListResult> {
  const params: unknown[] = [organizationId, GROUND_WORKER_ROLE_ID]
  const paramIndex = { i: 3 }
  let where = 'u.organization_id = $1 AND u.role_id = $2 AND u.active = true'

  if (opts.territoryId) {
    where += ` AND EXISTS (
      SELECT 1 FROM user_territories ut
      WHERE ut.user_id = u.id AND ut.territory_id = $${paramIndex.i++}
    )`
    params.push(opts.territoryId)
  }
  if (opts.keyword) {
    where += ` AND (
      u.full_name ILIKE $${paramIndex.i}
      OR COALESCE(u.email, '') ILIKE $${paramIndex.i}
      OR COALESCE(u.phone, '') ILIKE $${paramIndex.i}
    )`
    params.push(`%${opts.keyword}%`)
    paramIndex.i++
  }

  const countRes = await dbQuery<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM users u WHERE ${where}`,
    params,
  )
  const total = Number(countRes.rows[0]?.c ?? 0)

  const listParams = [...params, opts.limit, opts.offset]
  const limitParam = paramIndex.i++
  const offsetParam = paramIndex.i++

  const listRes = await dbQuery<{
    id: string
    full_name: string
    territory_ids: string[] | null
  }>(
    `SELECT u.id, u.full_name,
            COALESCE(
              (SELECT array_agg(ut.territory_id) FROM user_territories ut WHERE ut.user_id = u.id),
              ARRAY[]::uuid[]
            ) AS territory_ids
     FROM users u
     WHERE ${where}
     ORDER BY u.full_name ASC
     LIMIT $${limitParam} OFFSET $${offsetParam}`,
    listParams,
  )

  const workers: AssignableWorker[] = listRes.rows.map((r) => ({
    id: r.id,
    full_name: r.full_name,
    territory_ids: (r.territory_ids ?? []).map(String),
  }))

  return {
    workers,
    pagination: buildAssignablePagination(opts.offset, opts.limit, total),
  }
}

async function listAssignableWorkersPaginatedSupabase(
  organizationId: string,
  opts: AssignableWorkersListOptions,
): Promise<AssignableWorkersListResult> {
  const supabase = createSupabaseServiceClient()
  const selectCols = opts.territoryId
    ? 'id, full_name, user_territories!inner(territory_id)'
    : 'id, full_name, user_territories(territory_id)'

  let query = supabase
    .from('users')
    .select(selectCols, { count: 'exact' })
    .eq('organization_id', organizationId)
    .eq('role_id', GROUND_WORKER_ROLE_ID)
    .eq('active', true)
    .order('full_name', { ascending: true })
    .range(opts.offset, opts.offset + opts.limit - 1)

  if (opts.territoryId) query = query.eq('user_territories.territory_id', opts.territoryId)
  if (opts.keyword) {
    const pattern = `%${opts.keyword}%`
    query = query.or(`full_name.ilike.${pattern},email.ilike.${pattern},phone.ilike.${pattern}`)
  }

  const { data, count, error } = await query
  if (error) throw new Error(error.message)

  const workers = mapWorkerRows(
    (data ?? []) as Array<{ id: string; full_name: string; user_territories?: Array<{ territory_id: string }> }>,
  )

  return {
    workers,
    pagination: buildAssignablePagination(opts.offset, opts.limit, count ?? 0),
  }
}

function buildAssignablePagination(
  offset: number,
  limit: number,
  total: number,
): AssignableWorkersPagination {
  return {
    limit,
    offset,
    total,
    hasNextPage: offset + limit < total,
    hasPreviousPage: offset > 0,
  }
}

export async function getCurrentAssignment(
  ticketId: string,
  organizationId: string,
): Promise<TicketCurrentAssignment | null> {
  const supabase = createSupabaseServiceClient()
  const { data: ticket } = await supabase
    .from('tickets')
    .select('id')
    .eq('id', ticketId)
    .eq('organization_id', organizationId)
    .maybeSingle()
  if (!ticket) return null

  const { data: row } = await supabase
    .from('ticket_assignments')
    .select(
      `
      id, status, offered_at, expires_at, worker_user_id,
      worker:users!ticket_assignments_worker_user_id_fkey(id, full_name)
    `,
    )
    .eq('ticket_id', ticketId)
    .eq('is_current', true)
    .maybeSingle()

  if (!row) return null

  const rawWorker = row.worker as { id: string; full_name: string } | { id: string; full_name: string }[] | null
  const worker = Array.isArray(rawWorker) ? rawWorker[0] : rawWorker
  if (!worker?.id) return null

  return {
    id: row.id as string,
    status: row.status as string,
    offered_at: row.offered_at as string,
    expires_at: (row.expires_at as string | null) ?? null,
    worker: { id: worker.id, full_name: worker.full_name },
  }
}

async function validateWorkerForAssign(
  organizationId: string,
  workerId: string,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const supabase = createSupabaseServiceClient()
  const { data: worker } = await supabase
    .from('users')
    .select('id, organization_id, active, role_id')
    .eq('id', workerId)
    .maybeSingle()

  if (!worker) return { ok: false, status: 404, error: 'Worker not found' }
  if (worker.organization_id !== organizationId) {
    return { ok: false, status: 403, error: 'Worker is not in your organization' }
  }
  if (!worker.active) return { ok: false, status: 400, error: 'Worker is not active' }
  if (worker.role_id !== GROUND_WORKER_ROLE_ID) {
    return { ok: false, status: 400, error: 'User is not a ground worker' }
  }
  return { ok: true }
}

async function assertTicketInOrg(
  ticketId: string,
  organizationId: string,
): Promise<
  | { ok: true; territory_id: string | null }
  | { ok: false; status: number; error: string }
> {
  const supabase = createSupabaseServiceClient()
  const { data: ticket } = await supabase
    .from('tickets')
    .select('id, territory_id')
    .eq('id', ticketId)
    .eq('organization_id', organizationId)
    .maybeSingle()
  if (!ticket) return { ok: false, status: 404, error: 'Ticket not found' }
  return { ok: true, territory_id: (ticket.territory_id as string | null) ?? null }
}

export async function listAssignableWorkersForTicket(
  user: VocalUser,
  ticketId: string,
  query: Record<string, unknown>,
): Promise<
  | { ok: true; result: AssignableWorkersListResult; filters: ReturnType<typeof assignableWorkersFiltersEcho> }
  | { ok: false; status: number; error: string }
> {
  if (!canAssignTickets(user.roles?.name)) {
    return { ok: false, status: 403, error: 'Forbidden — central support or super admin only' }
  }

  const ticketCheck = await assertTicketInOrg(ticketId, user.organization_id)
  if (!ticketCheck.ok) return { ok: false, status: ticketCheck.status, error: ticketCheck.error }

  const opts = parseAssignableWorkersQuery(query)
  const inTicketTerritory =
    query.in_ticket_territory === 'true' || query.in_ticket_territory === true
  if (inTicketTerritory && ticketCheck.territory_id) {
    opts.territoryId = ticketCheck.territory_id
  }

  const result = await listAssignableWorkersPaginated(user.organization_id, opts)
  return { ok: true, result, filters: assignableWorkersFiltersEcho(opts) }
}

function mapOfferError(error: string): { status: number; message: string } {
  if (error === 'ticket_not_found') return { status: 404, message: 'Ticket not found' }
  return { status: 500, message: error || 'Assignment failed' }
}

export async function assignTicketToWorker(
  user: VocalUser,
  ticketId: string,
  workerId: string,
): Promise<
  | { ok: true; assignment_id: string; expires_at: string }
  | { ok: false; status: number; error: string }
> {
  if (!canAssignTickets(user.roles?.name)) {
    return { ok: false, status: 403, error: 'Forbidden — central support or super admin only' }
  }

  const ticketCheck = await assertTicketInOrg(ticketId, user.organization_id)
  if (!ticketCheck.ok) return { ok: false, status: ticketCheck.status, error: ticketCheck.error }

  const workerCheck = await validateWorkerForAssign(user.organization_id, workerId)
  if (!workerCheck.ok) return { ok: false, status: workerCheck.status, error: workerCheck.error }

  const offer = await offerTicketToWorker({
    ticketId,
    workerId,
    assignedByUserId: user.id,
    reason: 'Manual assignment by central support',
  })

  if (!offer.ok) {
    const mapped = mapOfferError(offer.error)
    return { ok: false, status: mapped.status, error: mapped.message }
  }

  return {
    ok: true,
    assignment_id: offer.assignmentId,
    expires_at: offer.expiresAt,
  }
}

export async function autoAssignTicket(
  user: VocalUser,
  ticketId: string,
): Promise<
  | { ok: true; assignment_id: string; expires_at: string; worker: CandidateWorker }
  | { ok: false; status: number; error: string }
> {
  if (!canAssignTickets(user.roles?.name)) {
    return { ok: false, status: 403, error: 'Forbidden — central support or super admin only' }
  }

  const ticketCheck = await assertTicketInOrg(ticketId, user.organization_id)
  if (!ticketCheck.ok) return { ok: false, status: ticketCheck.status, error: ticketCheck.error }

  const candidate = await findNearestAvailableWorker(ticketId)
  if (!candidate) {
    return {
      ok: false,
      status: 409,
      error: "No eligible workers in this ticket's territory.",
    }
  }

  const offer = await offerTicketToWorker({
    ticketId,
    workerId: candidate.id,
    assignedByUserId: user.id,
    reason: 'Auto-assigned to nearest available worker',
  })

  if (!offer.ok) {
    const mapped = mapOfferError(offer.error)
    return { ok: false, status: mapped.status, error: mapped.message }
  }

  return {
    ok: true,
    assignment_id: offer.assignmentId,
    expires_at: offer.expiresAt,
    worker: candidate,
  }
}

/** Whether the logged-in worker may accept/reject the current offer on this ticket. */
export function workerCanRespondToOffer(
  role: string | null | undefined,
  userId: string,
  assignment: TicketCurrentAssignment | null,
): boolean {
  return (
    role === 'ground_worker' &&
    assignment?.status === 'offered' &&
    assignment.worker.id === userId
  )
}
