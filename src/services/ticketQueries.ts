/**
 * Ticket Query Helpers
 *
 * Composable Supabase queries for ticket reads.
 * Always scoped by org. RLS adds additional user-level scoping.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { isPostgresMode, dbQuery } from '@/lib/db.js'
import { SQL_TICKET_LIST } from '@/lib/postgresCompat/embedSql.js'
import { createSupabaseServiceClient } from '@/lib/supabase.js'
import type { TicketStage, Severity, TicketSubStatus } from '@/types/database.js'
import { SUB_STATUS_LABELS } from '@/types/database.js'

export const TICKET_LIST_SELECT = `
  id, ticket_number, title, original_issue_text, stage, sub_status, severity,
  critical_flag, needs_triage, anonymous_flag, location_text, latitude, longitude,
  created_at, updated_at, accepted_at,
  sla_first_contact_due_at, sla_resolution_due_at, sla_breached_flag,
  territories(id, name),
  users!tickets_owner_user_id_fkey(id, full_name),
  issue_categories!tickets_category_id_fkey(id, name)
` as const

/** Duplicates ai_ticket_suggestions confirm state — omitted from v2 ticket JSON reads. */
const TICKET_AI_MIRROR_KEYS = [
  'ai_suggestions_confirmed',
  'ai_confirmed_by',
  'ai_confirmed_at',
] as const

export function stripTicketAiMirrorFields<T extends Record<string, unknown>>(ticket: T) {
  const out = { ...ticket }
  for (const key of TICKET_AI_MIRROR_KEYS) {
    delete out[key]
  }
  return out
}

export interface TicketCategoryRef {
  id: string
  name: string
}

export interface TicketClassificationBlock {
  category: TicketCategoryRef | null
  subcategory: TicketCategoryRef | null
  sub_status: string
  sub_status_label: string
  territory: TicketCategoryRef | null
  location: {
    text: string | null
    latitude: number | null
    longitude: number | null
    map_link: string | null
  }
  department: string | null
  /** Display label, e.g. "Telegram" */
  source: string
  source_channel: string
}

const CLASSIFICATION_ROOT_KEYS = [
  'category',
  'subcategory',
  'territories',
  'category_id',
  'subcategory_id',
  'territory_id',
  'sub_status',
  'location_text',
  'latitude',
  'longitude',
  'map_link',
  'address_text',
  'department',
  'source_channel',
] as const

function refFromEmbed(raw: unknown): TicketCategoryRef | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as { id?: string; name?: string }
  if (!o.id) return null
  return { id: o.id, name: o.name ?? '' }
}

function formatSourceChannel(channel: string): string {
  if (!channel) return ''
  return channel.charAt(0).toUpperCase() + channel.slice(1).replace(/_/g, ' ')
}

/** UI "Classification" section — built from ticket detail row before keys are lifted off the root. */
export function buildTicketClassification(row: Record<string, unknown>): TicketClassificationBlock {
  const subStatus = String(row.sub_status ?? '')
  const sourceChannel = String(row.source_channel ?? '')
  const label =
    subStatus in SUB_STATUS_LABELS
      ? SUB_STATUS_LABELS[subStatus as TicketSubStatus]
      : subStatus

  return {
    category: refFromEmbed(row.category),
    subcategory: refFromEmbed(row.subcategory),
    sub_status: subStatus,
    sub_status_label: label,
    territory: refFromEmbed(row.territories),
    location: {
      text: (row.location_text as string | null) ?? null,
      latitude: (row.latitude as number | null) ?? null,
      longitude: (row.longitude as number | null) ?? null,
      map_link: (row.map_link as string | null) ?? null,
    },
    department: (row.department as string | null) ?? null,
    source: formatSourceChannel(sourceChannel),
    source_channel: sourceChannel,
  }
}

/** Nest classification fields and remove them from the ticket root (v2 detail only). */
export function nestTicketClassification<T extends Record<string, unknown>>(
  ticket: T,
  sourceRow: Record<string, unknown>,
): T & { classification: TicketClassificationBlock } {
  const out = { ...ticket } as T & { classification: TicketClassificationBlock }
  for (const key of CLASSIFICATION_ROOT_KEYS) {
    delete (out as Record<string, unknown>)[key]
  }
  out.classification = buildTicketClassification(sourceRow)
  return out
}

export interface TicketSlaBlock {
  first_contact_due_at: string | null
  resolution_due_at: string | null
  breached_flag: boolean
}

const SLA_ROOT_KEYS = [
  'sla_first_contact_due_at',
  'sla_resolution_due_at',
  'sla_breached_flag',
] as const

export function buildTicketSla(row: Record<string, unknown>): TicketSlaBlock {
  return {
    first_contact_due_at: (row.sla_first_contact_due_at as string | null) ?? null,
    resolution_due_at: (row.sla_resolution_due_at as string | null) ?? null,
    breached_flag: row.sla_breached_flag === true,
  }
}

export function nestTicketSla<T extends Record<string, unknown>>(
  ticket: T,
  sourceRow: Record<string, unknown>,
): T & { sla: TicketSlaBlock } {
  const out = { ...ticket } as T & { sla: TicketSlaBlock }
  for (const key of SLA_ROOT_KEYS) {
    delete (out as Record<string, unknown>)[key]
  }
  out.sla = buildTicketSla(sourceRow)
  return out
}

export interface TicketFilters {
  stage?: TicketStage
  severity?: Severity
  needsTriage?: boolean
  slaBreached?: boolean
  hasLocation?: boolean
  ownerId?: string
  search?: string
  limit?: number
  offset?: number
}

export async function queryTickets(
  supabase: SupabaseClient,
  orgId: string,
  filters: TicketFilters = {},
) {
  let query = supabase
    .from('tickets')
    .select(TICKET_LIST_SELECT, { count: 'exact' })
    .eq('organization_id', orgId)
    .order('created_at', { ascending: false })

  if (filters.stage)       query = query.eq('stage', filters.stage)
  if (filters.severity)    query = query.eq('severity', filters.severity)
  if (filters.needsTriage) query = query.eq('needs_triage', true)
  if (filters.slaBreached) query = query.eq('sla_breached_flag', true)
  if (filters.hasLocation) query = query.not('latitude', 'is', null)
  if (filters.ownerId)     query = query.eq('owner_user_id', filters.ownerId)
  if (filters.search) {
    query = query.or(`title.ilike.%${filters.search}%,original_issue_text.ilike.%${filters.search}%,ticket_number.ilike.%${filters.search}%`)
  }

  const limit = filters.limit ?? 50
  const offset = filters.offset ?? 0
  query = query.range(offset, offset + limit - 1)

  return query
}

// --- v2 list (pagination, sort, filters) ---

export const TICKETS_V2_DEFAULT_LIMIT = 20
export const TICKETS_V2_MAX_LIMIT = 100
export const TICKETS_V2_SLA_AT_RISK_HOURS = 24

const TICKET_STAGES: TicketStage[] = ['to_do', 'in_progress', 'on_hold', 'closed']
const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low']

export type TicketV2SortField = 'created_at' | 'updated_at' | 'accepted_at'

export interface TicketListV2Options {
  limit: number
  offset: number
  sort: TicketV2SortField
  order: 'asc' | 'desc'
  keyword?: string
  stage?: TicketStage
  severity?: Severity
  needsTriage?: boolean
  slaBreached?: boolean
  slaFirstContactOverdue?: boolean
  slaResolutionOverdue?: boolean
  slaAtRisk?: boolean
  hasLocation?: boolean
  critical?: boolean
  ownerId?: string
}

export interface TicketListV2Pagination {
  limit: number
  offset: number
  total: number
  hasNextPage: boolean
  hasPreviousPage: boolean
}

export interface TicketListV2Result {
  tickets: Record<string, unknown>[]
  pagination: TicketListV2Pagination
}

function sanitizeTicketKeyword(raw: string): string {
  return raw.replace(/[,()."'%_\\]/g, '').trim().slice(0, 100)
}

function parseBooleanQuery(value: unknown): boolean | undefined {
  if (value === 'true' || value === true || value === '1') return true
  if (value === 'false' || value === false || value === '0') return false
  return undefined
}

function parseTicketSort(raw: unknown): TicketV2SortField {
  const s = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (s === 'updated' || s === 'updated_at') return 'updated_at'
  if (s === 'accepted' || s === 'accepted_at') return 'accepted_at'
  return 'created_at'
}

function parseTicketOrder(raw: unknown): 'asc' | 'desc' {
  return typeof raw === 'string' && raw.trim().toLowerCase() === 'asc' ? 'asc' : 'desc'
}

function parseTicketStage(raw: unknown): TicketStage | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined
  const stage = raw.trim() as TicketStage
  return TICKET_STAGES.includes(stage) ? stage : undefined
}

function parseTicketSeverity(raw: unknown): Severity | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined
  const severity = raw.trim() as Severity
  return SEVERITIES.includes(severity) ? severity : undefined
}

export function parseTicketsV2ListQuery(query: Record<string, unknown>): TicketListV2Options {
  let limit =
    parseInt(String(query.limit ?? TICKETS_V2_DEFAULT_LIMIT), 10) || TICKETS_V2_DEFAULT_LIMIT
  limit = Math.min(TICKETS_V2_MAX_LIMIT, Math.max(1, limit))
  const offset = Math.max(0, parseInt(String(query.offset ?? '0'), 10) || 0)

  const keywordRaw =
    (typeof query.keyword === 'string' && query.keyword) ||
    (typeof query.search === 'string' && query.search) ||
    undefined
  const keyword = keywordRaw ? sanitizeTicketKeyword(keywordRaw) : undefined

  const ownerId =
    typeof query.owner_id === 'string' && query.owner_id.trim()
      ? query.owner_id.trim()
      : undefined

  return {
    limit,
    offset,
    sort: parseTicketSort(query.sort),
    order: parseTicketOrder(query.order),
    keyword: keyword || undefined,
    stage: parseTicketStage(query.stage),
    severity: parseTicketSeverity(query.severity),
    needsTriage: parseBooleanQuery(query.needs_triage),
    slaBreached: parseBooleanQuery(query.sla_breached),
    slaFirstContactOverdue: parseBooleanQuery(query.sla_first_contact_overdue),
    slaResolutionOverdue: parseBooleanQuery(query.sla_resolution_overdue),
    slaAtRisk: parseBooleanQuery(query.sla_at_risk),
    hasLocation: parseBooleanQuery(query.has_location),
    critical: parseBooleanQuery(query.critical),
    ownerId,
  }
}

function buildTicketsV2Pagination(
  offset: number,
  limit: number,
  total: number,
): TicketListV2Pagination {
  return {
    limit,
    offset,
    total,
    hasNextPage: offset + limit < total,
    hasPreviousPage: offset > 0,
  }
}

function slaAtRiskWindow(): { now: string; soon: string } {
  const now = new Date()
  const soon = new Date(now.getTime() + TICKETS_V2_SLA_AT_RISK_HOURS * 3600000)
  return { now: now.toISOString(), soon: soon.toISOString() }
}

function appendTicketV2Filters(
  where: string,
  params: unknown[],
  paramIndex: { i: number },
  opts: TicketListV2Options,
  alias = 't',
): string {
  let clause = where

  if (opts.stage) {
    clause += ` AND ${alias}.stage = $${paramIndex.i++}`
    params.push(opts.stage)
  }
  if (opts.severity) {
    clause += ` AND ${alias}.severity = $${paramIndex.i++}`
    params.push(opts.severity)
  }
  if (opts.needsTriage === true) {
    clause += ` AND ${alias}.needs_triage = true`
  } else if (opts.needsTriage === false) {
    clause += ` AND ${alias}.needs_triage = false`
  }
  if (opts.critical === true) {
    clause += ` AND ${alias}.critical_flag = true`
  } else if (opts.critical === false) {
    clause += ` AND ${alias}.critical_flag = false`
  }
  if (opts.hasLocation === true) {
    clause += ` AND ${alias}.latitude IS NOT NULL`
  } else if (opts.hasLocation === false) {
    clause += ` AND ${alias}.latitude IS NULL`
  }
  if (opts.ownerId) {
    clause += ` AND ${alias}.owner_user_id = $${paramIndex.i++}`
    params.push(opts.ownerId)
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
    )`
    params.push(pattern)
    paramIndex.i++
  }

  return clause
}

function ticketV2OrderSql(sort: TicketV2SortField, order: 'asc' | 'desc'): string {
  const dir = order === 'asc' ? 'ASC' : 'DESC'
  if (sort === 'accepted_at') {
    return `t.accepted_at ${dir} NULLS LAST, t.created_at DESC`
  }
  return `t.${sort} ${dir}`
}

async function listTicketsV2Pg(
  orgId: string,
  opts: TicketListV2Options,
): Promise<TicketListV2Result> {
  const params: unknown[] = [orgId]
  const paramIndex = { i: 2 }
  let where = appendTicketV2Filters(
    't.organization_id = $1',
    params,
    paramIndex,
    opts,
  )

  const countRes = await dbQuery<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM tickets t WHERE ${where}`,
    params,
  )
  const total = Number(countRes.rows[0]?.c ?? 0)

  const listParams = [...params, opts.limit, opts.offset]
  const limitParam = paramIndex.i++
  const offsetParam = paramIndex.i++
  const orderSql = ticketV2OrderSql(opts.sort, opts.order)

  const res = await dbQuery<Record<string, unknown>>(
    `${SQL_TICKET_LIST} WHERE ${where} ORDER BY ${orderSql} LIMIT $${limitParam} OFFSET $${offsetParam}`,
    listParams,
  )

  return {
    tickets: res.rows,
    pagination: buildTicketsV2Pagination(opts.offset, opts.limit, total),
  }
}

async function listTicketsV2Supabase(
  orgId: string,
  opts: TicketListV2Options,
): Promise<TicketListV2Result> {
  const supabase = createSupabaseServiceClient()

  let query = supabase
    .from('tickets')
    .select(TICKET_LIST_SELECT, { count: 'exact' })
    .eq('organization_id', orgId)

  if (opts.stage) query = query.eq('stage', opts.stage)
  if (opts.severity) query = query.eq('severity', opts.severity)
  if (opts.needsTriage === true) query = query.eq('needs_triage', true)
  else if (opts.needsTriage === false) query = query.eq('needs_triage', false)
  if (opts.critical === true) query = query.eq('critical_flag', true)
  else if (opts.critical === false) query = query.eq('critical_flag', false)
  if (opts.hasLocation === true) query = query.not('latitude', 'is', null)
  else if (opts.hasLocation === false) query = query.is('latitude', null)
  if (opts.ownerId) query = query.eq('owner_user_id', opts.ownerId)
  if (opts.slaBreached === true) query = query.eq('sla_breached_flag', true)
  else if (opts.slaBreached === false) query = query.eq('sla_breached_flag', false)

  const nowIso = new Date().toISOString()

  if (opts.slaFirstContactOverdue === true) {
    query = query
      .lt('sla_first_contact_due_at', nowIso)
      .not('sla_first_contact_due_at', 'is', null)
      .is('first_contacted_at', null)
  }

  if (opts.slaResolutionOverdue === true) {
    query = query
      .lt('sla_resolution_due_at', nowIso)
      .not('sla_resolution_due_at', 'is', null)
      .is('closed_at', null)
      .neq('stage', 'closed')
  }

  if (opts.slaAtRisk === true) {
    const { now, soon } = slaAtRiskWindow()
    query = query
      .eq('sla_breached_flag', false)
      .neq('stage', 'closed')
      .or(
        `and(sla_first_contact_due_at.gte.${now},sla_first_contact_due_at.lte.${soon},first_contacted_at.is.null),and(sla_resolution_due_at.gte.${now},sla_resolution_due_at.lte.${soon},closed_at.is.null)`,
      )
  }

  if (opts.keyword) {
    const safe = opts.keyword.replace(/[%_]/g, '\\$&')
    query = query.or(
      `title.ilike.%${safe}%,original_issue_text.ilike.%${safe}%,ticket_number.ilike.%${safe}%`,
    )
  }

  const ascending = opts.order === 'asc'
  if (opts.sort === 'accepted_at') {
    query = query.order('accepted_at', { ascending, nullsFirst: false })
    query = query.order('created_at', { ascending: false })
  } else {
    query = query.order(opts.sort, { ascending })
  }

  query = query.range(opts.offset, opts.offset + opts.limit - 1)

  const { data, error, count } = await query
  if (error) {
    throw new Error(error.message)
  }

  const total = count ?? 0
  return {
    tickets: (data ?? []) as Record<string, unknown>[],
    pagination: buildTicketsV2Pagination(opts.offset, opts.limit, total),
  }
}

export async function listTicketsV2(
  orgId: string,
  opts: TicketListV2Options,
): Promise<TicketListV2Result> {
  if (isPostgresMode()) {
    return listTicketsV2Pg(orgId, opts)
  }
  return listTicketsV2Supabase(orgId, opts)
}

export function ticketsV2FiltersEcho(opts: TicketListV2Options) {
  return {
    keyword: opts.keyword ?? null,
    stage: opts.stage ?? null,
    severity: opts.severity ?? null,
    needs_triage: opts.needsTriage ?? null,
    sla_breached: opts.slaBreached ?? null,
    sla_first_contact_overdue: opts.slaFirstContactOverdue ?? null,
    sla_resolution_overdue: opts.slaResolutionOverdue ?? null,
    sla_at_risk: opts.slaAtRisk ?? null,
    has_location: opts.hasLocation ?? null,
    critical: opts.critical ?? null,
    owner_id: opts.ownerId ?? null,
    sort: opts.sort,
    order: opts.order,
    limit: opts.limit,
    offset: opts.offset,
  }
}
