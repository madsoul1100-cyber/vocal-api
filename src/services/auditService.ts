import { createSupabaseServiceClient } from '@/lib/supabase.js'
import { isPostgresMode, dbQuery } from '@/lib/db.js'

export const AUDIT_ALLOWED_ROLES = ['super_admin', 'central_support']

export function canAccessAudit(role: string | null | undefined): boolean {
  return !!role && AUDIT_ALLOWED_ROLES.includes(role)
}

export interface AuditLogRow {
  id: string
  event_type: string
  entity_type: string | null
  entity_id: string | null
  actor_type: string
  created_at: string
  source_ip: string | null
  metadata_json: Record<string, unknown> | null
  users: { full_name: string } | null
}

export interface ListAuditLogsOpts {
  actor?: string
  event?: string
  page?: number
  limit?: number
}

export interface ListAuditLogsResult {
  events: AuditLogRow[]
  count: number
  page: number
  limit: number
}

function sanitizeEventFilter(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const safe = raw.replace(/[,()."'\\%_]/g, '').trim().slice(0, 80)
  return safe.length ? safe : undefined
}

export async function listAuditLogs(
  orgId: string,
  opts: ListAuditLogsOpts = {},
): Promise<ListAuditLogsResult> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100)
  const page = Math.max(opts.page ?? 1, 1)
  const offset = (page - 1) * limit
  const eventFilter = sanitizeEventFilter(opts.event)
  const actor = opts.actor && opts.actor !== 'all' ? opts.actor : undefined

  if (isPostgresMode()) {
    return listAuditLogsPg(orgId, { actor, eventFilter, page, limit, offset })
  }
  return listAuditLogsSupabase(orgId, { actor, eventFilter, page, limit, offset })
}

async function listAuditLogsPg(
  orgId: string,
  opts: {
    actor?: string
    eventFilter?: string
    page: number
    limit: number
    offset: number
  },
): Promise<ListAuditLogsResult> {
  const params: unknown[] = [orgId]
  let where = 'a.organization_id = $1'
  let i = 2

  if (opts.actor) {
    where += ` AND a.actor_type = $${i++}`
    params.push(opts.actor)
  }
  if (opts.eventFilter) {
    where += ` AND a.event_type ILIKE $${i++}`
    params.push(`%${opts.eventFilter}%`)
  }

  const countRes = await dbQuery<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM audit_logs a WHERE ${where}`,
    params,
  )
  const count = Number(countRes.rows[0]?.c ?? 0)

  const listParams = [...params, opts.limit, opts.offset]
  const res = await dbQuery<AuditLogRow>(
    `SELECT
       a.id, a.event_type, a.entity_type, a.entity_id, a.actor_type, a.created_at,
       a.source_ip, a.metadata_json,
       CASE WHEN u.id IS NOT NULL THEN jsonb_build_object('full_name', u.full_name) END AS users
     FROM audit_logs a
     LEFT JOIN users u ON u.id = a.actor_user_id
     WHERE ${where}
     ORDER BY a.created_at DESC
     LIMIT $${i++} OFFSET $${i}`,
    listParams,
  )

  return {
    events: res.rows.map((row) => ({
      ...row,
      metadata_json: (row.metadata_json as Record<string, unknown> | null) ?? null,
    })),
    count,
    page: opts.page,
    limit: opts.limit,
  }
}

async function listAuditLogsSupabase(
  orgId: string,
  opts: {
    actor?: string
    eventFilter?: string
    page: number
    limit: number
    offset: number
  },
): Promise<ListAuditLogsResult> {
  const supabase = createSupabaseServiceClient()

  let query = supabase
    .from('audit_logs')
    .select(
      `
      id, event_type, entity_type, entity_id, actor_type, created_at,
      source_ip, metadata_json,
      users!audit_logs_actor_user_id_fkey(full_name)
    `,
      { count: 'exact' },
    )
    .eq('organization_id', orgId)
    .order('created_at', { ascending: false })
    .range(opts.offset, opts.offset + opts.limit - 1)

  if (opts.actor) {
    query = query.eq('actor_type', opts.actor)
  }
  if (opts.eventFilter) {
    query = query.ilike('event_type', `%${opts.eventFilter}%`)
  }

  const { data, count } = await query

  return {
    events: (data ?? []) as unknown as AuditLogRow[],
    count: count ?? 0,
    page: opts.page,
    limit: opts.limit,
  }
}
