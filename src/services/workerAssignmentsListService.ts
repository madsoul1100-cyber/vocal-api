import { createSupabaseServiceClient } from '@/lib/supabase.js'
import { isPostgresMode, dbQuery } from '@/lib/db.js'
import { TICKETS_V2_SLA_AT_RISK_HOURS } from '@/services/ticketQueries.js'

export type WorkerAssignmentBucket = 'offered' | 'active' | 'closed'

export const WORKER_ASSIGNMENTS_DEFAULT_LIMIT = 20
export const WORKER_ASSIGNMENTS_MAX_LIMIT = 100

const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const
type Severity = (typeof SEVERITIES)[number]

export interface WorkerAssignmentsListOptions {
  limit: number
  offset: number
  keyword?: string
  severity?: Severity
  subStatus?: string
  slaBreached?: boolean
  slaFirstContactOverdue?: boolean
  slaResolutionOverdue?: boolean
  slaAtRisk?: boolean
  critical?: boolean
  sort: 'expires_at' | 'accepted_at' | 'updated_at' | 'closed_at' | 'created_at'
  order: 'asc' | 'desc'
}

export interface WorkerAssignmentsPagination {
  limit: number
  offset: number
  total: number
  hasNextPage: boolean
  hasPreviousPage: boolean
}

export interface WorkerTicketListItem {
  id: string
  ticket_number: string
  title: string | null
  original_issue_text: string | null
  location_text: string | null
  latitude?: number | null
  longitude?: number | null
  severity: string | null
  stage: string
  sub_status: string
  accepted_at: string | null
  closed_at?: string | null
  outcome?: string | null
  sla_first_contact_due_at: string | null
  sla_resolution_due_at: string | null
  citizen_phone: string | null
}

export interface WorkerOfferedListItem {
  id: string
  expires_at: string
  ticket: WorkerTicketListItem | null
}

export type WorkerAssignmentsListItem = WorkerOfferedListItem | WorkerTicketListItem

export interface WorkerAssignmentsListResult {
  bucket: WorkerAssignmentBucket
  items: WorkerAssignmentsListItem[]
  pagination: WorkerAssignmentsPagination
  filters: Record<string, unknown>
}

export interface WorkerAssignmentsSummary {
  counts: { offered: number; active: number; closed: number }
  telegramLinked: boolean
}

function sanitizeKeyword(raw: string): string {
  return raw.replace(/[,()."'%_\\]/g, '').trim().slice(0, 100)
}

function parseBooleanQuery(value: unknown): boolean | undefined {
  if (value === 'true' || value === true || value === '1') return true
  if (value === 'false' || value === false || value === '0') return false
  return undefined
}

function parseBucket(raw: unknown): WorkerAssignmentBucket | null {
  const b = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (b === 'offered' || b === 'active' || b === 'closed') return b
  return null
}

function defaultSortForBucket(bucket: WorkerAssignmentBucket): WorkerAssignmentsListOptions['sort'] {
  if (bucket === 'offered') return 'expires_at'
  if (bucket === 'closed') return 'closed_at'
  return 'accepted_at'
}

function parseSort(
  raw: unknown,
  bucket: WorkerAssignmentBucket,
): WorkerAssignmentsListOptions['sort'] {
  const s = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (s === 'expires' || s === 'expires_at') return 'expires_at'
  if (s === 'accepted' || s === 'accepted_at') return 'accepted_at'
  if (s === 'updated' || s === 'updated_at') return 'updated_at'
  if (s === 'closed' || s === 'closed_at') return 'closed_at'
  if (s === 'created' || s === 'created_at') return 'created_at'
  return defaultSortForBucket(bucket)
}

export function parseWorkerAssignmentsListQuery(
  query: Record<string, unknown>,
  bucket: WorkerAssignmentBucket,
): WorkerAssignmentsListOptions {
  let limit =
    parseInt(String(query.limit ?? WORKER_ASSIGNMENTS_DEFAULT_LIMIT), 10) ||
    WORKER_ASSIGNMENTS_DEFAULT_LIMIT
  limit = Math.min(WORKER_ASSIGNMENTS_MAX_LIMIT, Math.max(1, limit))
  const offset = Math.max(0, parseInt(String(query.offset ?? '0'), 10) || 0)

  const keywordRaw =
    (typeof query.keyword === 'string' && query.keyword) ||
    (typeof query.search === 'string' && query.search) ||
    undefined
  const keyword = keywordRaw ? sanitizeKeyword(keywordRaw) : undefined

  const severityRaw = typeof query.severity === 'string' ? query.severity.trim() : ''
  const severity = SEVERITIES.includes(severityRaw as Severity)
    ? (severityRaw as Severity)
    : undefined

  const subStatus =
    typeof query.sub_status === 'string' && query.sub_status.trim()
      ? query.sub_status.trim()
      : undefined

  const orderExplicit = typeof query.order === 'string' ? query.order.trim() : ''
  const defaultOrder: 'asc' | 'desc' =
    bucket === 'closed' ? 'desc' : bucket === 'offered' ? 'asc' : 'asc'
  const order =
    orderExplicit?.toLowerCase() === 'asc'
      ? 'asc'
      : orderExplicit?.toLowerCase() === 'desc'
        ? 'desc'
        : defaultOrder

  return {
    limit,
    offset,
    keyword: keyword || undefined,
    severity,
    subStatus,
    slaBreached: parseBooleanQuery(query.sla_breached),
    slaFirstContactOverdue: parseBooleanQuery(query.sla_first_contact_overdue),
    slaResolutionOverdue: parseBooleanQuery(query.sla_resolution_overdue),
    slaAtRisk: parseBooleanQuery(query.sla_at_risk),
    critical: parseBooleanQuery(query.critical),
    sort: parseSort(query.sort, bucket),
    order,
  }
}

export function parseWorkerAssignmentsBucketQuery(
  query: Record<string, unknown>,
): WorkerAssignmentBucket | null {
  return parseBucket(query.bucket)
}

function buildPagination(offset: number, limit: number, total: number): WorkerAssignmentsPagination {
  return {
    limit,
    offset,
    total,
    hasNextPage: offset + limit < total,
    hasPreviousPage: offset > 0,
  }
}

function filtersEcho(
  bucket: WorkerAssignmentBucket,
  opts: WorkerAssignmentsListOptions,
): Record<string, unknown> {
  return {
    bucket,
    limit: opts.limit,
    offset: opts.offset,
    sort: opts.sort,
    order: opts.order,
    ...(opts.keyword ? { keyword: opts.keyword } : {}),
    ...(opts.severity ? { severity: opts.severity } : {}),
    ...(opts.subStatus ? { sub_status: opts.subStatus } : {}),
    ...(opts.slaBreached !== undefined ? { sla_breached: opts.slaBreached } : {}),
    ...(opts.slaFirstContactOverdue !== undefined
      ? { sla_first_contact_overdue: opts.slaFirstContactOverdue }
      : {}),
    ...(opts.slaResolutionOverdue !== undefined
      ? { sla_resolution_overdue: opts.slaResolutionOverdue }
      : {}),
    ...(opts.slaAtRisk !== undefined ? { sla_at_risk: opts.slaAtRisk } : {}),
    ...(opts.critical !== undefined ? { critical: opts.critical } : {}),
  }
}

function slaAtRiskWindow(): { now: string; soon: string } {
  const now = new Date()
  const soon = new Date(now.getTime() + TICKETS_V2_SLA_AT_RISK_HOURS * 3600000)
  return { now: now.toISOString(), soon: soon.toISOString() }
}

function appendTicketFilters(
  where: string,
  params: unknown[],
  paramIndex: { i: number },
  opts: WorkerAssignmentsListOptions,
  alias = 't',
): string {
  let clause = where

  if (opts.severity) {
    clause += ` AND ${alias}.severity = $${paramIndex.i++}`
    params.push(opts.severity)
  }
  if (opts.subStatus) {
    clause += ` AND ${alias}.sub_status = $${paramIndex.i++}`
    params.push(opts.subStatus)
  }
  if (opts.critical === true) {
    clause += ` AND ${alias}.critical_flag = true`
  } else if (opts.critical === false) {
    clause += ` AND ${alias}.critical_flag = false`
  }
  if (opts.slaBreached === true) {
    clause += ` AND ${alias}.sla_breached_flag = true`
  } else if (opts.slaBreached === false) {
    clause += ` AND ${alias}.sla_breached_flag = false`
  }

  const nowIso = new Date().toISOString()

  if (opts.slaFirstContactOverdue === true) {
    clause += ` AND ${alias}.sla_first_contact_due_at IS NOT NULL
      AND ${alias}.sla_first_contact_due_at < $${paramIndex.i++}
      AND ${alias}.first_contacted_at IS NULL`
    params.push(nowIso)
  }

  if (opts.slaResolutionOverdue === true) {
    clause += ` AND ${alias}.sla_resolution_due_at IS NOT NULL
      AND ${alias}.sla_resolution_due_at < $${paramIndex.i++}
      AND ${alias}.closed_at IS NULL
      AND ${alias}.stage <> 'closed'`
    params.push(nowIso)
  }

  if (opts.slaAtRisk === true) {
    const { now, soon } = slaAtRiskWindow()
    clause += ` AND ${alias}.sla_breached_flag = false
      AND ${alias}.stage <> 'closed'
      AND (
        (
          ${alias}.sla_first_contact_due_at IS NOT NULL
          AND ${alias}.first_contacted_at IS NULL
          AND ${alias}.sla_first_contact_due_at >= $${paramIndex.i++}
          AND ${alias}.sla_first_contact_due_at <= $${paramIndex.i++}
        )
        OR (
          ${alias}.sla_resolution_due_at IS NOT NULL
          AND ${alias}.closed_at IS NULL
          AND ${alias}.sla_resolution_due_at >= $${paramIndex.i++}
          AND ${alias}.sla_resolution_due_at <= $${paramIndex.i++}
        )
      )`
    params.push(now, soon, now, soon)
  }

  if (opts.keyword) {
    const pattern = `%${opts.keyword}%`
    clause += ` AND (
      ${alias}.title ILIKE $${paramIndex.i}
      OR ${alias}.original_issue_text ILIKE $${paramIndex.i}
      OR ${alias}.ticket_number ILIKE $${paramIndex.i}
      OR ${alias}.location_text ILIKE $${paramIndex.i}
    )`
    params.push(pattern)
    paramIndex.i++
  }

  return clause
}

function orderSql(
  bucket: WorkerAssignmentBucket,
  sort: WorkerAssignmentsListOptions['sort'],
  order: 'asc' | 'desc',
  ticketAlias = 't',
  assignmentAlias = 'ta',
): string {
  const dir = order === 'asc' ? 'ASC' : 'DESC'
  if (bucket === 'offered' && sort === 'expires_at') {
    return `${assignmentAlias}.expires_at ${dir}`
  }
  if (sort === 'accepted_at') {
    return `${ticketAlias}.accepted_at ${dir} NULLS LAST, ${ticketAlias}.updated_at DESC`
  }
  if (sort === 'closed_at') {
    return `${ticketAlias}.closed_at ${dir} NULLS LAST, ${ticketAlias}.updated_at DESC`
  }
  if (sort === 'updated_at') {
    return `${ticketAlias}.updated_at ${dir}`
  }
  return `${ticketAlias}.created_at ${dir}`
}

async function loadCitizenPhones(
  rows: Array<{ citizen_id: string | null; citizen_identity_revealed_at: string | null }>,
): Promise<Record<string, string>> {
  const revealedIds = rows
    .filter((t) => t.citizen_id && t.citizen_identity_revealed_at)
    .map((t) => t.citizen_id as string)

  const phoneMap: Record<string, string> = {}
  if (revealedIds.length === 0) return phoneMap

  if (isPostgresMode()) {
    const phones = await dbQuery<{ citizen_id: string; phone: string }>(
      `SELECT citizen_id, phone FROM citizen_channel_identities
       WHERE citizen_id = ANY($1::uuid[]) AND phone IS NOT NULL`,
      [revealedIds],
    )
    for (const row of phones.rows) {
      if (!phoneMap[row.citizen_id]) phoneMap[row.citizen_id] = row.phone
    }
    return phoneMap
  }

  const supabase = createSupabaseServiceClient()
  const { data: identities } = await supabase
    .from('citizen_channel_identities')
    .select('citizen_id, phone')
    .in('citizen_id', revealedIds)
    .not('phone', 'is', null)

  for (const row of identities ?? []) {
    if (!phoneMap[row.citizen_id]) phoneMap[row.citizen_id] = row.phone
  }
  return phoneMap
}

function mapTicketRow(
  t: Record<string, unknown>,
  phoneMap: Record<string, string>,
  includeClosedFields: boolean,
): WorkerTicketListItem {
  const citizenId = t.citizen_id as string | null
  const item: WorkerTicketListItem = {
    id: String(t.id),
    ticket_number: String(t.ticket_number),
    title: (t.title as string | null) ?? null,
    original_issue_text: (t.original_issue_text as string | null) ?? null,
    location_text: (t.location_text as string | null) ?? null,
    severity: (t.severity as string | null) ?? null,
    stage: String(t.stage),
    sub_status: String(t.sub_status),
    accepted_at: (t.accepted_at as string | null) ?? null,
    sla_first_contact_due_at: (t.sla_first_contact_due_at as string | null) ?? null,
    sla_resolution_due_at: (t.sla_resolution_due_at as string | null) ?? null,
    citizen_phone: citizenId ? (phoneMap[citizenId] ?? null) : null,
  }
  if (t.latitude !== undefined) {
    item.latitude = (t.latitude as number | null) ?? null
    item.longitude = (t.longitude as number | null) ?? null
  }
  if (includeClosedFields) {
    item.closed_at = (t.closed_at as string | null) ?? null
    item.outcome = (t.outcome as string | null) ?? null
  }
  return item
}

async function listOfferedPg(
  workerId: string,
  opts: WorkerAssignmentsListOptions,
): Promise<WorkerAssignmentsListResult> {
  const nowISO = new Date().toISOString()
  const params: unknown[] = [workerId, nowISO]
  const paramIndex = { i: 3 }
  let where = `ta.worker_user_id = $1
    AND ta.is_current = true
    AND ta.status = 'offered'
    AND ta.expires_at > $2`
  where = appendTicketFilters(where, params, paramIndex, opts, 't')

  const countRes = await dbQuery<{ c: string }>(
    `SELECT COUNT(*)::text AS c
     FROM ticket_assignments ta
     INNER JOIN tickets t ON t.id = ta.ticket_id
     WHERE ${where}`,
    params,
  )
  const total = Number(countRes.rows[0]?.c ?? 0)

  const listParams = [...params, opts.limit, opts.offset]
  const limitParam = paramIndex.i++
  const offsetParam = paramIndex.i++
  const order = orderSql('offered', opts.sort, opts.order)

  const res = await dbQuery<Record<string, unknown>>(
    `SELECT ta.id, ta.expires_at,
            t.id AS ticket_id, t.ticket_number, t.title, t.original_issue_text,
            t.location_text, t.latitude, t.longitude, t.severity, t.stage, t.sub_status,
            t.accepted_at, t.sla_first_contact_due_at, t.sla_resolution_due_at,
            t.citizen_id, t.citizen_identity_revealed_at
     FROM ticket_assignments ta
     INNER JOIN tickets t ON t.id = ta.ticket_id
     WHERE ${where}
     ORDER BY ${order}
     LIMIT $${limitParam} OFFSET $${offsetParam}`,
    listParams,
  )

  const phoneMap = await loadCitizenPhones(
    res.rows as Array<{ citizen_id: string | null; citizen_identity_revealed_at: string | null }>,
  )
  const items: WorkerOfferedListItem[] = res.rows.map((row) => ({
    id: String(row.id),
    expires_at: String(row.expires_at),
    ticket: mapTicketRow(
      {
        id: row.ticket_id,
        ticket_number: row.ticket_number,
        title: row.title,
        original_issue_text: row.original_issue_text,
        location_text: row.location_text,
        latitude: row.latitude,
        longitude: row.longitude,
        severity: row.severity,
        stage: row.stage,
        sub_status: row.sub_status,
        accepted_at: row.accepted_at,
        sla_first_contact_due_at: row.sla_first_contact_due_at,
        sla_resolution_due_at: row.sla_resolution_due_at,
        citizen_id: row.citizen_id,
        citizen_identity_revealed_at: row.citizen_identity_revealed_at,
      },
      phoneMap,
      false,
    ),
  }))

  return {
    bucket: 'offered',
    items,
    pagination: buildPagination(opts.offset, opts.limit, total),
    filters: filtersEcho('offered', opts),
  }
}

async function listOwnedTicketsPg(
  workerId: string,
  bucket: 'active' | 'closed',
  opts: WorkerAssignmentsListOptions,
): Promise<WorkerAssignmentsListResult> {
  const params: unknown[] = [workerId]
  const paramIndex = { i: 2 }

  let where =
    bucket === 'active'
      ? `t.owner_user_id = $1
         AND t.stage IN ('in_progress', 'on_hold')
         AND t.sub_status <> 'assigned_awaiting_acceptance'`
      : `t.owner_user_id = $1 AND t.stage = 'closed'`

  where = appendTicketFilters(where, params, paramIndex, opts)

  const countRes = await dbQuery<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM tickets t WHERE ${where}`,
    params,
  )
  const total = Number(countRes.rows[0]?.c ?? 0)

  const listParams = [...params, opts.limit, opts.offset]
  const limitParam = paramIndex.i++
  const offsetParam = paramIndex.i++
  const order = orderSql(bucket, opts.sort, opts.order)

  const res = await dbQuery<Record<string, unknown>>(
    `SELECT t.id, t.ticket_number, t.title, t.original_issue_text, t.location_text,
            t.severity, t.stage, t.sub_status, t.accepted_at, t.closed_at, t.outcome,
            t.sla_first_contact_due_at, t.sla_resolution_due_at,
            t.citizen_id, t.citizen_identity_revealed_at
     FROM tickets t
     WHERE ${where}
     ORDER BY ${order}
     LIMIT $${limitParam} OFFSET $${offsetParam}`,
    listParams,
  )

  const phoneMap = await loadCitizenPhones(
    res.rows as Array<{ citizen_id: string | null; citizen_identity_revealed_at: string | null }>,
  )
  const items = res.rows.map((row) => mapTicketRow(row, phoneMap, bucket === 'closed'))

  return {
    bucket,
    items,
    pagination: buildPagination(opts.offset, opts.limit, total),
    filters: filtersEcho(bucket, opts),
  }
}

function normalizeTicketJoin(raw: unknown): Record<string, unknown> | null {
  if (!raw) return null
  if (Array.isArray(raw)) return (raw[0] as Record<string, unknown>) ?? null
  return raw as Record<string, unknown>
}

async function listOfferedSupabase(
  workerId: string,
  opts: WorkerAssignmentsListOptions,
): Promise<WorkerAssignmentsListResult> {
  const supabase = createSupabaseServiceClient()
  const nowISO = new Date().toISOString()

  let query = supabase
    .from('ticket_assignments')
    .select(
      `
      id, expires_at,
      tickets(
        id, ticket_number, title, original_issue_text,
        location_text, latitude, longitude, severity, stage, sub_status,
        accepted_at, sla_first_contact_due_at, sla_resolution_due_at,
        citizen_id, citizen_identity_revealed_at, critical_flag,
        sla_breached_flag, first_contacted_at, closed_at
      )
    `,
      { count: 'exact' },
    )
    .eq('worker_user_id', workerId)
    .eq('is_current', true)
    .eq('status', 'offered')
    .gt('expires_at', nowISO)

  if (opts.severity) query = query.eq('tickets.severity', opts.severity)
  if (opts.subStatus) query = query.eq('tickets.sub_status', opts.subStatus)
  if (opts.critical === true) query = query.eq('tickets.critical_flag', true)
  else if (opts.critical === false) query = query.eq('tickets.critical_flag', false)
  if (opts.slaBreached === true) query = query.eq('tickets.sla_breached_flag', true)
  else if (opts.slaBreached === false) query = query.eq('tickets.sla_breached_flag', false)

  if (opts.keyword) {
    const k = opts.keyword
    query = query.or(
      `title.ilike.%${k}%,original_issue_text.ilike.%${k}%,ticket_number.ilike.%${k}%,location_text.ilike.%${k}%`,
      { foreignTable: 'tickets' },
    )
  }

  const ascending = opts.order === 'asc'
  if (opts.sort === 'expires_at') {
    query = query.order('expires_at', { ascending })
  }

  const from = opts.offset
  const to = opts.offset + opts.limit - 1
  query = query.range(from, to)

  const { data, count, error } = await query
  if (error) throw new Error(error.message)

  const rows = (data ?? []).map((raw) => {
    const ticket = normalizeTicketJoin((raw as { tickets?: unknown }).tickets)
    return { raw, ticket }
  })

  const phoneMap = await loadCitizenPhones(
    rows.map((r) => (r.ticket ?? {}) as { citizen_id: string | null; citizen_identity_revealed_at: string | null }),
  )

  const items: WorkerOfferedListItem[] = rows.map(({ raw, ticket }) => ({
    id: raw.id as string,
    expires_at: raw.expires_at as string,
    ticket: ticket ? mapTicketRow(ticket, phoneMap, false) : null,
  }))

  const total = count ?? 0
  return {
    bucket: 'offered',
    items,
    pagination: buildPagination(opts.offset, opts.limit, total),
    filters: filtersEcho('offered', opts),
  }
}

async function listOwnedTicketsSupabase(
  workerId: string,
  bucket: 'active' | 'closed',
  opts: WorkerAssignmentsListOptions,
): Promise<WorkerAssignmentsListResult> {
  const supabase = createSupabaseServiceClient()

  let query = supabase
    .from('tickets')
    .select(
      `id, ticket_number, title, original_issue_text, location_text, severity,
       stage, sub_status, accepted_at, closed_at, outcome,
       sla_first_contact_due_at, sla_resolution_due_at,
       citizen_id, citizen_identity_revealed_at, critical_flag, sla_breached_flag,
       first_contacted_at, created_at, updated_at`,
      { count: 'exact' },
    )
    .eq('owner_user_id', workerId)

  if (bucket === 'active') {
    query = query.in('stage', ['in_progress', 'on_hold']).neq('sub_status', 'assigned_awaiting_acceptance')
  } else {
    query = query.eq('stage', 'closed')
  }

  if (opts.severity) query = query.eq('severity', opts.severity)
  if (opts.subStatus) query = query.eq('sub_status', opts.subStatus)
  if (opts.critical === true) query = query.eq('critical_flag', true)
  else if (opts.critical === false) query = query.eq('critical_flag', false)
  if (opts.slaBreached === true) query = query.eq('sla_breached_flag', true)
  else if (opts.slaBreached === false) query = query.eq('sla_breached_flag', false)

  if (opts.keyword) {
    const k = opts.keyword
    query = query.or(
      `title.ilike.%${k}%,original_issue_text.ilike.%${k}%,ticket_number.ilike.%${k}%,location_text.ilike.%${k}%`,
    )
  }

  const ascending = opts.order === 'asc'
  const sortCol =
    opts.sort === 'closed_at'
      ? 'closed_at'
      : opts.sort === 'updated_at'
        ? 'updated_at'
        : opts.sort === 'created_at'
          ? 'created_at'
          : 'accepted_at'

  query = query.order(sortCol, { ascending, nullsFirst: false })

  const from = opts.offset
  const to = opts.offset + opts.limit - 1
  query = query.range(from, to)

  const { data, count, error } = await query
  if (error) throw new Error(error.message)

  const phoneMap = await loadCitizenPhones(data ?? [])
  const items = (data ?? []).map((row) =>
    mapTicketRow(row as Record<string, unknown>, phoneMap, bucket === 'closed'),
  )

  const total = count ?? 0
  return {
    bucket,
    items,
    pagination: buildPagination(opts.offset, opts.limit, total),
    filters: filtersEcho(bucket, opts),
  }
}

export async function listWorkerAssignmentsV2(
  workerId: string,
  bucket: WorkerAssignmentBucket,
  opts: WorkerAssignmentsListOptions,
): Promise<WorkerAssignmentsListResult> {
  if (isPostgresMode()) {
    if (bucket === 'offered') return listOfferedPg(workerId, opts)
    return listOwnedTicketsPg(workerId, bucket, opts)
  }
  if (bucket === 'offered') return listOfferedSupabase(workerId, opts)
  return listOwnedTicketsSupabase(workerId, bucket, opts)
}

async function countOfferedPg(workerId: string): Promise<number> {
  const nowISO = new Date().toISOString()
  const res = await dbQuery<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM ticket_assignments ta
     WHERE ta.worker_user_id = $1 AND ta.is_current = true
       AND ta.status = 'offered' AND ta.expires_at > $2`,
    [workerId, nowISO],
  )
  return Number(res.rows[0]?.c ?? 0)
}

async function countActivePg(workerId: string): Promise<number> {
  const res = await dbQuery<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM tickets t
     WHERE t.owner_user_id = $1
       AND t.stage IN ('in_progress', 'on_hold')
       AND t.sub_status <> 'assigned_awaiting_acceptance'`,
    [workerId],
  )
  return Number(res.rows[0]?.c ?? 0)
}

async function countClosedPg(workerId: string): Promise<number> {
  const res = await dbQuery<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM tickets t
     WHERE t.owner_user_id = $1 AND t.stage = 'closed'`,
    [workerId],
  )
  return Number(res.rows[0]?.c ?? 0)
}

export async function getWorkerAssignmentsSummary(workerId: string): Promise<WorkerAssignmentsSummary> {
  if (isPostgresMode()) {
    const [offered, active, closed] = await Promise.all([
      countOfferedPg(workerId),
      countActivePg(workerId),
      countClosedPg(workerId),
    ])
    const userRes = await dbQuery<{ metadata_json: Record<string, unknown> | null }>(
      `SELECT metadata_json FROM users WHERE id = $1`,
      [workerId],
    )
    const meta = userRes.rows[0]?.metadata_json
    return {
      counts: { offered, active, closed },
      telegramLinked: typeof meta?.telegram_chat_id === 'number',
    }
  }

  const supabase = createSupabaseServiceClient()
  const nowISO = new Date().toISOString()

  const [offeredRes, activeRes, closedRes, userRes] = await Promise.all([
    supabase
      .from('ticket_assignments')
      .select('id', { count: 'exact', head: true })
      .eq('worker_user_id', workerId)
      .eq('is_current', true)
      .eq('status', 'offered')
      .gt('expires_at', nowISO),
    supabase
      .from('tickets')
      .select('id', { count: 'exact', head: true })
      .eq('owner_user_id', workerId)
      .in('stage', ['in_progress', 'on_hold'])
      .neq('sub_status', 'assigned_awaiting_acceptance'),
    supabase
      .from('tickets')
      .select('id', { count: 'exact', head: true })
      .eq('owner_user_id', workerId)
      .eq('stage', 'closed'),
    supabase.from('users').select('metadata_json').eq('id', workerId).single(),
  ])

  const meta = userRes.data?.metadata_json as Record<string, unknown> | null
  return {
    counts: {
      offered: offeredRes.count ?? 0,
      active: activeRes.count ?? 0,
      closed: closedRes.count ?? 0,
    },
    telegramLinked: typeof meta?.telegram_chat_id === 'number',
  }
}
