import { createSupabaseServiceClient } from '@/lib/supabase.js'
import { isPostgresMode, dbQuery } from '@/lib/db.js'
import { expireStaleAssignments } from '@/services/assignmentService.js'

export const JOBS_ALLOWED_ROLES = ['super_admin', 'central_support']

export function canAccessJobs(role: string | null | undefined): boolean {
  return !!role && JOBS_ALLOWED_ROLES.includes(role)
}

export interface JobRunRow {
  id: string
  created_at: string
  actor_name: string
  payload: Record<string, unknown> | null
}

export interface ExpireJobResult {
  ok: boolean
  ran_at: string
  expired: number
  reoffered: number
  escalated: number
  sla_breached: number
}

export async function listExpireJobRuns(orgId: string): Promise<JobRunRow[]> {
  if (isPostgresMode()) {
    return listExpireJobRunsPg(orgId)
  }
  return listExpireJobRunsSupabase(orgId)
}

async function listExpireJobRunsPg(orgId: string): Promise<JobRunRow[]> {
  const res = await dbQuery<{
    id: string
    created_at: string
    new_value_json: Record<string, unknown> | null
    users: { full_name: string } | null
  }>(
    `SELECT
       a.id, a.created_at, a.new_value_json,
       CASE WHEN u.id IS NOT NULL THEN jsonb_build_object('full_name', u.full_name) END AS users
     FROM audit_logs a
     LEFT JOIN users u ON u.id = a.actor_user_id
     WHERE a.organization_id = $1
       AND a.event_type = 'job_expire_assignments_run'
     ORDER BY a.created_at DESC
     LIMIT 50`,
    [orgId],
  )

  return res.rows.map((r) => ({
    id: r.id,
    created_at: r.created_at,
    actor_name: r.users?.full_name ?? '—',
    payload: r.new_value_json,
  }))
}

async function listExpireJobRunsSupabase(orgId: string): Promise<JobRunRow[]> {
  const supabase = createSupabaseServiceClient()
  const { data } = await supabase
    .from('audit_logs')
    .select('id, created_at, new_value_json, users:actor_user_id(full_name)')
    .eq('organization_id', orgId)
    .eq('event_type', 'job_expire_assignments_run')
    .order('created_at', { ascending: false })
    .limit(50)

  return (data ?? []).map((r: {
    id: string
    created_at: string
    new_value_json: Record<string, unknown> | null
    users?: { full_name: string } | { full_name: string }[] | null
  }) => {
    const user = Array.isArray(r.users) ? r.users[0] : r.users
    return {
      id: r.id,
      created_at: r.created_at,
      actor_name: user?.full_name ?? '—',
      payload: r.new_value_json,
    }
  })
}

export async function runExpireAssignmentsJob(user: {
  id: string
  organization_id: string
}): Promise<ExpireJobResult | { ok: false; error: string }> {
  const startedAt = new Date()
  const supabase = createSupabaseServiceClient()

  try {
    const summary = await expireStaleAssignments()

    await supabase.from('audit_logs').insert({
      organization_id: user.organization_id,
      event_type: 'job_expire_assignments_run',
      entity_type: 'job',
      entity_id: null,
      actor_type: 'user',
      actor_user_id: user.id,
      new_value_json: {
        ...summary,
        started_at: startedAt.toISOString(),
        finished_at: new Date().toISOString(),
        ok: true,
      },
    })

    return {
      ok: true,
      ran_at: startedAt.toISOString(),
      ...summary,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await supabase.from('audit_logs').insert({
      organization_id: user.organization_id,
      event_type: 'job_expire_assignments_run',
      entity_type: 'job',
      entity_id: null,
      actor_type: 'user',
      actor_user_id: user.id,
      new_value_json: {
        started_at: startedAt.toISOString(),
        finished_at: new Date().toISOString(),
        ok: false,
        error: message,
      },
    })
    return { ok: false, error: message }
  }
}
