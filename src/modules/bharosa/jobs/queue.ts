import { dbQuery } from '@/lib/db.js'

export type JobType =
  | 'structure_submission'
  | 'post_case_create'
  | 'verification_call'
  | 'route_case'
  | 'generate_resolution_plan'
  | 'send_communication'
  | 'summarize_inbound_reply'
  | 'notify_citizen'
  | 'sweep_follow_ups'
  | 'sweep_escalations'
  | 'refresh_directory_sources'
  | 'refresh_feeds'
  | 'expire_assignments'

export interface JobRow {
  id: string
  organization_id: string | null
  job_type: JobType
  payload: Record<string, unknown>
  status: string
  attempts: number
  max_attempts: number
  run_at: string
}

export async function enqueueJob(args: {
  type: JobType
  orgId?: string | null
  payload?: Record<string, unknown>
  runAt?: Date
  idempotencyKey?: string
  maxAttempts?: number
}): Promise<string | null> {
  const res = await dbQuery<{ id: string }>(
    `INSERT INTO jobs (organization_id, job_type, payload, run_at, idempotency_key, max_attempts)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      args.orgId ?? null,
      args.type,
      JSON.stringify(args.payload ?? {}),
      (args.runAt ?? new Date()).toISOString(),
      args.idempotencyKey ?? null,
      args.maxAttempts ?? 5,
    ],
  )
  return res.rows[0]?.id ?? null
}

export async function claimJobs(workerId: string, limit: number): Promise<JobRow[]> {
  const res = await dbQuery<JobRow>(
    `UPDATE jobs SET status = 'running', locked_at = now(), locked_by = $1,
                     attempts = attempts + 1, updated_at = now()
     WHERE id IN (
       SELECT id FROM jobs
       WHERE status = 'queued' AND run_at <= now()
       ORDER BY run_at
       LIMIT $2
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, organization_id, job_type, payload, status, attempts, max_attempts, run_at`,
    [workerId, limit],
  )
  return res.rows
}

export async function completeJob(id: string, result: unknown): Promise<void> {
  await dbQuery(
    `UPDATE jobs SET status = 'succeeded', result_json = $2, locked_at = NULL, updated_at = now() WHERE id = $1`,
    [id, result === undefined ? null : JSON.stringify(result)],
  )
}

export async function failJob(job: JobRow, error: string): Promise<'retry' | 'dead'> {
  const dead = job.attempts >= job.max_attempts
  const backoffSeconds = Math.min(30 * 2 ** (job.attempts - 1), 6 * 3600)
  await dbQuery(
    `UPDATE jobs SET status = $2, last_error = $3, locked_at = NULL,
                     run_at = CASE WHEN $2::text = 'queued' THEN now() + make_interval(secs => $4::int) ELSE run_at END,
                     updated_at = now()
     WHERE id = $1`,
    [job.id, dead ? 'dead' : 'queued', error.slice(0, 2000), backoffSeconds],
  )
  return dead ? 'dead' : 'retry'
}

/** Jobs stuck in `running` (worker crashed) go back to the queue. */
export async function requeueStaleJobs(staleMinutes = 10): Promise<number> {
  const res = await dbQuery(
    `UPDATE jobs SET status = 'queued', locked_at = NULL, updated_at = now()
     WHERE status = 'running' AND locked_at < now() - make_interval(mins => $1::int)`,
    [staleMinutes],
  )
  return res.rowCount ?? 0
}

export async function listJobs(args: {
  orgId: string
  status?: string | null
  type?: string | null
  limit: number
  offset: number
}) {
  const params: unknown[] = [args.orgId]
  let where = '(organization_id = $1 OR organization_id IS NULL)'
  if (args.status) {
    params.push(args.status)
    where += ` AND status = $${params.length}`
  }
  if (args.type) {
    params.push(args.type)
    where += ` AND job_type = $${params.length}`
  }
  params.push(args.limit, args.offset)
  const res = await dbQuery(
    `SELECT id, job_type, status, attempts, max_attempts, run_at, last_error, created_at, updated_at
     FROM jobs WHERE ${where} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  )
  return res.rows
}

export async function retryJob(orgId: string, id: string): Promise<boolean> {
  const res = await dbQuery(
    `UPDATE jobs SET status = 'queued', run_at = now(), attempts = 0, last_error = NULL, updated_at = now()
     WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL) AND status IN ('dead','failed')`,
    [id, orgId],
  )
  return (res.rowCount ?? 0) > 0
}
