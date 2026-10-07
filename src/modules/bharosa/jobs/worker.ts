import os from 'node:os'
import { dbQuery } from '@/lib/db.js'
import { enrichTicketFromIssueText } from '@/services/ticketIntakeAi.js'
import { expireStaleAssignments, intakeTerritoryAutoAssign } from '@/services/assignmentService.js'
import { claimJobs, completeJob, enqueueJob, failJob, requeueStaleJobs, type JobRow, type JobType } from './queue.js'
import { getBharosaSettings } from '../settings.js'
import { suggestAuthorities } from '../directory/routing.js'
import { refreshDueDirectorySources } from '../directory/sources.js'
import { generateResolutionPlan } from '../cases/plans.js'
import { retryAutomatedCall, startVerificationCall } from '../cases/verification.js'
import { sweepEscalations, sweepFollowUps } from '../cases/sweeps.js'
import { deliverCommunication } from '../comms/communications.js'
import { notifyCitizen } from '../comms/citizenNotify.js'
import { summarizeInboundReply } from '../ai/responseSummaryAgent.js'
import { refreshDueFeeds } from '../feed/feed.js'
import { processEmailSubmission } from '../citizen/submissions.js'

type Handler = (job: JobRow) => Promise<unknown>

function need(job: JobRow, key: string): string {
  const v = job.payload?.[key]
  if (typeof v !== 'string' || !v) throw new Error(`Job ${job.job_type} missing payload.${key}`)
  return v
}

function needOrg(job: JobRow): string {
  if (!job.organization_id) throw new Error(`Job ${job.job_type} has no organization_id`)
  return job.organization_id
}

/** After a citizen confirms: enrich, auto-assign, start verification, suggest routing. */
async function postCaseCreate(job: JobRow) {
  const orgId = needOrg(job)
  const ticketId = need(job, 'ticket_id')
  const t = (
    await dbQuery<{ ticket_number: string; original_issue_text: string | null; location_text: string | null; source_channel: string }>(
      `SELECT ticket_number, original_issue_text, location_text, source_channel FROM tickets WHERE id = $1 AND organization_id = $2`,
      [ticketId, orgId],
    )
  ).rows[0]
  if (!t) return { skipped: 'ticket_not_found' }
  const settings = await getBharosaSettings(orgId)
  const out: Record<string, unknown> = {}

  if (t.original_issue_text) {
    const r = await enrichTicketFromIssueText({ ticketId, organizationId: orgId, issueText: t.original_issue_text, overrideCategory: false })
    out.enrich = r.ok ? 'ok' : r.error
  }
  try {
    const r = await intakeTerritoryAutoAssign({
      ticketId, ticketNumber: t.ticket_number, organizationId: orgId, locationText: t.location_text,
      issueText: t.original_issue_text, source: `bharosa_${t.source_channel}`,
    })
    out.assign = r
  } catch (err) {
    out.assign = { error: err instanceof Error ? err.message : String(err) }
  }

  if (settings.verification.callAfterCreate || job.payload.force_verification_call === true) {
    const check = await startVerificationCall({ orgId, ticketId })
    out.verification = { check_id: check.id, mode: check.mode, status: check.status }
  }
  const routing = await suggestAuthorities(orgId, ticketId, { persist: true })
  out.routing = { status: routing.routing_status, candidates: routing.candidates.length }
  return out
}

async function maybeGeneratePlan(job: JobRow) {
  const orgId = needOrg(job)
  const ticketId = need(job, 'ticket_id')
  const existing = await dbQuery(
    `SELECT 1 FROM resolution_plans WHERE ticket_id = $1 AND status IN ('pending_approval','approved') LIMIT 1`,
    [ticketId],
  )
  if (existing.rowCount && job.payload.force !== true) return { skipped: 'plan_exists' }
  const plan = await generateResolutionPlan({ orgId, ticketId, requestedBy: (job.payload.requested_by as string) ?? null })
  return { plan_id: plan.id }
}

const HANDLERS: Record<JobType, Handler> = {
  structure_submission: (job) => processEmailSubmission(need(job, 'submission_id')),
  post_case_create: postCaseCreate,
  verification_call: async (job) =>
    typeof job.payload.check_id === 'string'
      ? retryAutomatedCall(job.payload.check_id)
      : startVerificationCall({ orgId: needOrg(job), ticketId: need(job, 'ticket_id'), mode: job.payload.mode as 'manual' | 'automated' | undefined }).then((c) => ({ check_id: c.id })),
  route_case: async (job) => {
    const r = await suggestAuthorities(needOrg(job), need(job, 'ticket_id'), { persist: true })
    return { routing_status: r.routing_status, candidates: r.candidates.length }
  },
  generate_resolution_plan: maybeGeneratePlan,
  send_communication: (job) => deliverCommunication(needOrg(job), need(job, 'communication_id')),
  summarize_inbound_reply: (job) => summarizeInboundReply(need(job, 'communication_id')),
  notify_citizen: (job) => notifyCitizen(need(job, 'case_event_id')),
  sweep_follow_ups: (job) => sweepFollowUps(needOrg(job)),
  sweep_escalations: (job) => sweepEscalations(needOrg(job)),
  refresh_directory_sources: (job) => refreshDueDirectorySources(job.organization_id),
  refresh_feeds: (job) => refreshDueFeeds(job.organization_id),
  expire_assignments: () => expireStaleAssignments(),
}

async function runJob(job: JobRow) {
  const handler = HANDLERS[job.job_type]
  if (!handler) {
    await failJob({ ...job, attempts: job.max_attempts }, `No handler for ${job.job_type}`)
    return
  }
  try {
    const result = await handler(job)
    await completeJob(job.id, result)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const outcome = await failJob(job, msg)
    console.error(`[bharosa:jobs] ${job.job_type} ${job.id} failed (${outcome}, attempt ${job.attempts}/${job.max_attempts}): ${msg}`)
  }
}

/** Recurring work, bucketed by time so each run is enqueued once even with several API instances. */
const SCHEDULE: Array<{ type: JobType; everyMinutes: number; perOrg: boolean }> = [
  { type: 'sweep_follow_ups', everyMinutes: 15, perOrg: true },
  { type: 'sweep_escalations', everyMinutes: 15, perOrg: true },
  { type: 'refresh_feeds', everyMinutes: 10, perOrg: true },
  { type: 'refresh_directory_sources', everyMinutes: 60, perOrg: true },
]

async function scheduleRecurring() {
  const orgs = await dbQuery<{ id: string }>(`SELECT id FROM organizations WHERE active = true`)
  const now = Date.now()
  for (const s of SCHEDULE) {
    const bucket = Math.floor(now / (s.everyMinutes * 60_000))
    const targets = s.perOrg ? orgs.rows.map((o) => o.id) : [null]
    for (const orgId of targets) {
      await enqueueJob({ type: s.type, orgId, idempotencyKey: `${s.type}:${orgId ?? 'global'}:${bucket}`, maxAttempts: 2 })
    }
  }
}

export interface WorkerHandle {
  stop: () => Promise<void>
}

/**
 * In-process worker: polls the jobs table, runs handlers with bounded
 * concurrency, and enqueues the recurring sweeps. Safe to run on several
 * instances (FOR UPDATE SKIP LOCKED + idempotency keys).
 */
export function startBharosaWorker(opts: { concurrency?: number; pollMs?: number; scheduler?: boolean } = {}): WorkerHandle {
  const workerId = `${os.hostname()}:${process.pid}`
  const concurrency = opts.concurrency ?? Number(process.env.JOBS_CONCURRENCY ?? 4)
  const pollMs = opts.pollMs ?? Number(process.env.JOBS_POLL_MS ?? 2000)
  const scheduler = opts.scheduler ?? process.env.JOBS_SCHEDULER_ENABLED !== 'false'
  let running = 0
  let stopped = false
  let lastSchedule = 0
  let lastRequeue = 0
  const inflight = new Set<Promise<void>>()

  const tick = async () => {
    if (stopped) return
    try {
      const now = Date.now()
      if (scheduler && now - lastSchedule > 60_000) {
        lastSchedule = now
        await scheduleRecurring()
      }
      if (now - lastRequeue > 5 * 60_000) {
        lastRequeue = now
        const n = await requeueStaleJobs(10)
        if (n) console.warn(`[bharosa:jobs] requeued ${n} stale job(s)`)
      }
      const free = concurrency - running
      if (free > 0) {
        const jobs = await claimJobs(workerId, free)
        for (const job of jobs) {
          running++
          const p = runJob(job).finally(() => {
            running--
            inflight.delete(p)
          })
          inflight.add(p)
        }
      }
    } catch (err) {
      console.error('[bharosa:jobs] poll error:', err instanceof Error ? err.message : err)
    } finally {
      if (!stopped) timer = setTimeout(tick, pollMs)
    }
  }

  let timer: NodeJS.Timeout = setTimeout(tick, 1000)
  console.info(`[bharosa:jobs] worker ${workerId} started (concurrency=${concurrency}, poll=${pollMs}ms, scheduler=${scheduler})`)

  return {
    stop: async () => {
      stopped = true
      clearTimeout(timer)
      await Promise.allSettled([...inflight])
    },
  }
}
