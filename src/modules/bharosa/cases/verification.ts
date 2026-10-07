import crypto from 'node:crypto'
import { dbQuery } from '@/lib/db.js'
import { updateTicketStage } from '@/services/ticketService.js'
import { HttpError, type StaffUser } from '../common.js'
import { getBharosaSettings } from '../settings.js'
import { recordCaseEvent } from './events.js'
import { createEscalation } from './escalations.js'
import { createTask } from './tasks.js'
import { enqueueJob } from '../jobs/queue.js'
import { buildCallScript, extractCallOutcome, type CallScript } from '../ai/verificationCallAgent.js'

export type VerificationMethod = 'otp' | 'call' | 'media' | 'field' | 'document'
export type VerificationResult = 'passed' | 'failed' | 'inconclusive'

const MAX_AUTOMATED_ATTEMPTS = 3

export interface VerificationCheckRow {
  id: string
  organization_id: string
  ticket_id: string
  citizen_id: string | null
  method: VerificationMethod
  status: string
  mode: 'manual' | 'automated'
  provider: string | null
  provider_ref: string | null
  attempt_count: number
  script_json: CallScript | null
  checklist_json: unknown
  result_json: unknown
  transcript: string | null
  notes: string | null
  assigned_user_id: string | null
  performed_by: string | null
  ai_run_id: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
}

function voiceProviderConfigured(): boolean {
  return !!process.env.VOICE_AGENT_PROVIDER_URL?.trim()
}

function callbackSecret(): string {
  return process.env.VOICE_AGENT_CALLBACK_SECRET?.trim() || process.env.JWT_SECRET || 'dev-voice-secret'
}

export function voiceCallbackToken(checkId: string): string {
  return crypto.createHmac('sha256', callbackSecret()).update(checkId).digest('hex').slice(0, 40)
}

export function verifyVoiceCallbackToken(checkId: string, token: string): boolean {
  const expected = voiceCallbackToken(checkId)
  return token.length === expected.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected))
}

async function getCheck(orgId: string, id: string): Promise<VerificationCheckRow> {
  const res = await dbQuery<VerificationCheckRow>(`SELECT * FROM verification_checks WHERE id = $1 AND organization_id = $2`, [id, orgId])
  if (!res.rows[0]) throw new HttpError(404, 'Verification check not found')
  return res.rows[0]
}

export async function listChecksForTicket(orgId: string, ticketId: string): Promise<VerificationCheckRow[]> {
  const res = await dbQuery<VerificationCheckRow>(
    `SELECT * FROM verification_checks WHERE organization_id = $1 AND ticket_id = $2 ORDER BY created_at DESC`,
    [orgId, ticketId],
  )
  return res.rows
}

/** Assisted-verification queue: pending/in-progress checks with case + citizen context. */
export async function listVerificationQueue(args: { orgId: string; status?: string | null; mine?: string | null; limit: number; offset: number }) {
  const params: unknown[] = [args.orgId]
  let where = `v.organization_id = $1 AND v.method <> 'otp'`
  if (args.status) {
    params.push(args.status)
    where += ` AND v.status = $${params.length}`
  } else {
    where += ` AND v.status IN ('pending','in_progress')`
  }
  if (args.mine) {
    params.push(args.mine)
    where += ` AND v.assigned_user_id = $${params.length}`
  }
  params.push(args.limit, args.offset)
  const res = await dbQuery(
    `SELECT v.id, v.ticket_id, v.method, v.status, v.mode, v.provider, v.attempt_count, v.script_json, v.assigned_user_id,
            v.created_at, t.ticket_number, t.title, t.severity, t.language, t.location_text,
            c.display_name AS citizen_name, c.phone_e164 AS citizen_phone, c.preferred_language AS citizen_language,
            u.full_name AS assigned_user_name
     FROM verification_checks v
     JOIN tickets t ON t.id = v.ticket_id
     LEFT JOIN citizens c ON c.id = v.citizen_id
     LEFT JOIN users u ON u.id = v.assigned_user_id
     WHERE ${where}
     ORDER BY CASE t.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, v.created_at
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  )
  return res.rows
}

async function setTicketVerification(ticketId: string, status: 'in_verification' | 'verified' | 'failed') {
  await dbQuery(
    `UPDATE tickets SET verification_status = $2, verified_at = CASE WHEN $2 = 'verified' THEN now() ELSE verified_at END WHERE id = $1`,
    [ticketId, status],
  )
}

async function dispatchAutomatedCall(check: VerificationCheckRow, phone: string, language: string): Promise<{ ok: boolean; ref?: string; error?: string }> {
  const url = process.env.VOICE_AGENT_PROVIDER_URL!.trim()
  const base = (process.env.PUBLIC_API_BASE_URL || process.env.API_PUBLIC_URL || '').replace(/\/$/, '')
  const callbackUrl = `${base}/webhooks/bharosa/voice/${check.id}?token=${voiceCallbackToken(check.id)}`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.VOICE_AGENT_API_KEY ? { Authorization: `Bearer ${process.env.VOICE_AGENT_API_KEY}` } : {}),
      },
      body: JSON.stringify({ call_id: check.id, to: phone, language, script: check.script_json, callback_url: callbackUrl }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}` }
    const body = (await res.json().catch(() => ({}))) as { id?: string; call_id?: string; sid?: string }
    return { ok: true, ref: body.id ?? body.call_id ?? body.sid ?? undefined }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

async function ensureManualCallTask(check: VerificationCheckRow, ticketNumber: string) {
  const existing = await dbQuery(
    `SELECT 1 FROM tasks t JOIN task_tickets tt ON tt.task_id = t.id
     WHERE tt.ticket_id = $1 AND t.task_type = 'verification' AND t.status NOT IN ('closed','cancelled')`,
    [check.ticket_id],
  )
  if (existing.rowCount) return
  await createTask({
    orgId: check.organization_id,
    ticketIds: [check.ticket_id],
    title: `Verification call – ${ticketNumber}`,
    description: 'Call the citizen using the AI script in the verification queue and record the outcome.',
    taskType: 'verification',
    suggestedRole: 'ground_worker',
    dueAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
    createdByAgent: 'verification_call_agent',
  })
}

/**
 * Start a call verification. Generates the AI script; then either dispatches to
 * the automated voice provider or drops it into the assisted queue.
 */
export async function startVerificationCall(args: { orgId: string; ticketId: string; mode?: 'manual' | 'automated'; requestedBy?: string | null }) {
  const settings = await getBharosaSettings(args.orgId)
  const ticket = (
    await dbQuery<{ ticket_number: string; citizen_id: string | null; phone: string | null; lang: string | null; verification_status: string }>(
      `SELECT t.ticket_number, t.citizen_id, c.phone_e164 AS phone, COALESCE(c.preferred_language, t.language) AS lang, t.verification_status
       FROM tickets t LEFT JOIN citizens c ON c.id = t.citizen_id WHERE t.id = $1 AND t.organization_id = $2`,
      [args.ticketId, args.orgId],
    )
  ).rows[0]
  if (!ticket) throw new HttpError(404, 'Case not found')
  if (ticket.verification_status === 'verified') throw new HttpError(409, 'Case already verified')

  const open = await dbQuery<VerificationCheckRow>(
    `SELECT * FROM verification_checks WHERE ticket_id = $1 AND method = 'call' AND status IN ('pending','in_progress') LIMIT 1`,
    [args.ticketId],
  )
  if (open.rows[0]) return open.rows[0]

  const { script, runId } = await buildCallScript(args.orgId, args.ticketId)
  let mode = args.mode ?? settings.verification.callMode
  if (mode === 'automated' && (!voiceProviderConfigured() || !ticket.phone)) mode = 'manual'

  const ins = await dbQuery<VerificationCheckRow>(
    `INSERT INTO verification_checks (organization_id, ticket_id, citizen_id, method, status, mode, provider, script_json, ai_run_id)
     VALUES ($1,$2,$3,'call','pending',$4,$5,$6,$7) RETURNING *`,
    [args.orgId, args.ticketId, ticket.citizen_id, mode, mode === 'automated' ? process.env.VOICE_AGENT_PROVIDER || 'voice_agent' : null, JSON.stringify(script), runId],
  )
  let check = ins.rows[0]
  await setTicketVerification(args.ticketId, 'in_verification')
  await recordCaseEvent({
    orgId: args.orgId, ticketId: args.ticketId, type: 'verification_started', actorType: args.requestedBy ? 'user' : 'ai_agent',
    actorUserId: args.requestedBy ?? null, actorLabel: 'verification_call_agent', visibility: 'citizen',
    data: { check_id: check.id, method: 'call', mode },
  })

  if (mode === 'automated') {
    const r = await dispatchAutomatedCall(check, ticket.phone!, ticket.lang ?? 'te')
    if (r.ok) {
      check = (
        await dbQuery<VerificationCheckRow>(
          `UPDATE verification_checks SET status = 'in_progress', provider_ref = $2, attempt_count = attempt_count + 1, updated_at = now()
           WHERE id = $1 RETURNING *`,
          [check.id, r.ref ?? null],
        )
      ).rows[0]
    } else {
      check = (
        await dbQuery<VerificationCheckRow>(
          `UPDATE verification_checks SET mode = 'manual', notes = $2, updated_at = now() WHERE id = $1 RETURNING *`,
          [check.id, `Automated call failed to start: ${r.error}`],
        )
      ).rows[0]
      await ensureManualCallTask(check, ticket.ticket_number)
    }
  } else {
    await ensureManualCallTask(check, ticket.ticket_number)
  }
  return check
}

export async function assignCheck(orgId: string, checkId: string, userId: string | null) {
  const res = await dbQuery(
    `UPDATE verification_checks SET assigned_user_id = $3, status = CASE WHEN $3::uuid IS NULL THEN status ELSE 'in_progress' END, updated_at = now()
     WHERE id = $1 AND organization_id = $2 AND status IN ('pending','in_progress') RETURNING id`,
    [checkId, orgId, userId],
  )
  if (!res.rowCount) throw new HttpError(404, 'Open verification check not found')
}

/** Record a non-call verification (media review, field visit, document). */
export async function recordManualVerification(args: {
  orgId: string
  ticketId: string
  user: StaffUser
  method: Exclude<VerificationMethod, 'otp' | 'call'>
  result: VerificationResult
  notes: string | null
  checklist?: unknown
}) {
  const ins = await dbQuery<VerificationCheckRow>(
    `INSERT INTO verification_checks (organization_id, ticket_id, citizen_id, method, status, mode)
     SELECT $1::uuid, t.id, t.citizen_id, $3::text, 'pending', 'manual' FROM tickets t WHERE t.id = $2 AND t.organization_id = $1::uuid
     RETURNING *`,
    [args.orgId, args.ticketId, args.method],
  )
  if (!ins.rows[0]) throw new HttpError(404, 'Case not found')
  return completeVerification({
    orgId: args.orgId, checkId: ins.rows[0].id, result: args.result, notes: args.notes, checklist: args.checklist, performedBy: args.user.id,
  })
}

/**
 * Finalise a check. Answers/transcript enrich the case facts; a pass moves the
 * case on to routing + resolution planning; a fail goes to the GRO.
 */
export async function completeVerification(args: {
  orgId: string
  checkId: string
  result: VerificationResult
  notes?: string | null
  answers?: Record<string, string> | null
  transcript?: string | null
  checklist?: unknown
  performedBy?: string | null
  resultJson?: Record<string, unknown> | null
}) {
  const check = await getCheck(args.orgId, args.checkId)
  if (['passed', 'failed', 'inconclusive', 'cancelled'].includes(check.status)) {
    throw new HttpError(409, `Check already ${check.status}`)
  }

  let result = args.result
  let answers = args.answers ?? null
  let aiRunId: string | null = null
  let outcome: Record<string, unknown> | null = args.resultJson ?? null
  if (args.transcript && !answers) {
    const ex = await extractCallOutcome({ orgId: args.orgId, ticketId: check.ticket_id, script: check.script_json, transcript: args.transcript })
    aiRunId = ex.runId
    if (ex.outcome) {
      answers = ex.outcome.answers
      outcome = { ...(outcome ?? {}), ai_outcome: ex.outcome }
      if (!args.performedBy) result = ex.outcome.recommended_status
    }
  }

  await dbQuery(
    `UPDATE verification_checks SET status = $2, notes = COALESCE($3, notes), transcript = COALESCE($4, transcript),
            checklist_json = COALESCE($5, checklist_json), result_json = $6, performed_by = COALESCE($7, performed_by),
            completed_at = now(), updated_at = now()
     WHERE id = $1`,
    [
      check.id, result, args.notes ?? null, args.transcript ?? null,
      args.checklist ? JSON.stringify(args.checklist) : null,
      JSON.stringify({ ...(outcome ?? {}), answers, extraction_run_id: aiRunId }),
      args.performedBy ?? null,
    ],
  )

  if (answers && Object.keys(answers).length) {
    await dbQuery(
      `UPDATE tickets SET structured_facts_json = jsonb_set(COALESCE(structured_facts_json, '{}'::jsonb), '{verification_answers}',
              COALESCE(structured_facts_json->'verification_answers', '{}'::jsonb) || $2::jsonb) WHERE id = $1`,
      [check.ticket_id, JSON.stringify(answers)],
    )
  }

  await dbQuery(
    `UPDATE tasks SET status = 'closed', closed_at = now(), closure_note = $2, updated_at = now()
     WHERE task_type = 'verification' AND status NOT IN ('closed','cancelled')
       AND id IN (SELECT task_id FROM task_tickets WHERE ticket_id = $1)`,
    [check.ticket_id, `Verification ${result}`],
  )

  const ticket = (await dbQuery<{ stage: string }>(`SELECT stage FROM tickets WHERE id = $1`, [check.ticket_id])).rows[0]
  if (result === 'passed') {
    await setTicketVerification(check.ticket_id, 'verified')
    await recordCaseEvent({
      orgId: args.orgId, ticketId: check.ticket_id, type: 'verified', actorType: args.performedBy ? 'user' : 'ai_agent',
      actorUserId: args.performedBy ?? null, visibility: 'citizen', data: { check_id: check.id, method: check.method },
    })
    if (ticket?.stage === 'to_do') {
      await updateTicketStage(check.ticket_id, 'in_progress', 'citizen_contacted', args.performedBy ?? null, 'Complaint verified', !args.performedBy)
    }
    await enqueueJob({ type: 'route_case', orgId: args.orgId, payload: { ticket_id: check.ticket_id }, idempotencyKey: `route:${check.ticket_id}:${check.id}` })
    await enqueueJob({ type: 'generate_resolution_plan', orgId: args.orgId, payload: { ticket_id: check.ticket_id }, idempotencyKey: `plan:${check.ticket_id}:${check.id}` })
  } else if (result === 'failed') {
    await setTicketVerification(check.ticket_id, 'failed')
    await recordCaseEvent({
      orgId: args.orgId, ticketId: check.ticket_id, type: 'verification_failed', actorType: args.performedBy ? 'user' : 'ai_agent',
      actorUserId: args.performedBy ?? null, visibility: 'internal', reason: args.notes ?? null, data: { check_id: check.id },
    })
    await createEscalation({
      orgId: args.orgId, ticketId: check.ticket_id, target: 'gro', trigger: 'ai_uncertain',
      reason: `Verification failed (${check.method}). ${args.notes ?? ''}`.trim(),
      createdByAgent: args.performedBy ? null : 'verification_call_agent', createdBy: args.performedBy ?? null,
      dedupeKey: `verification_failed:${check.id}`,
    })
  } else {
    await recordCaseEvent({
      orgId: args.orgId, ticketId: check.ticket_id, type: 'verification_inconclusive', actorType: args.performedBy ? 'user' : 'ai_agent',
      actorUserId: args.performedBy ?? null, visibility: 'internal', reason: args.notes ?? null, data: { check_id: check.id },
    })
  }
  return getCheck(args.orgId, check.id)
}

/** Webhook from the automated voice provider. */
export async function handleVoiceCallback(checkId: string, body: Record<string, unknown>) {
  const res = await dbQuery<VerificationCheckRow>(`SELECT * FROM verification_checks WHERE id = $1`, [checkId])
  const check = res.rows[0]
  if (!check) throw new HttpError(404, 'Unknown call')
  if (!['pending', 'in_progress'].includes(check.status)) return { ignored: true }

  const status = String(body.status ?? '').toLowerCase()
  const transcript = typeof body.transcript === 'string' ? body.transcript : null
  const recordingUrl = typeof body.recording_url === 'string' ? body.recording_url : null

  if (['no_answer', 'busy', 'failed', 'unreachable'].includes(status) || (!transcript && status !== 'completed')) {
    if (check.attempt_count < MAX_AUTOMATED_ATTEMPTS) {
      await dbQuery(`UPDATE verification_checks SET status = 'pending', notes = $2, updated_at = now() WHERE id = $1`, [
        check.id, `Attempt ${check.attempt_count}: ${status || 'unknown'}`,
      ])
      await enqueueJob({
        type: 'verification_call', orgId: check.organization_id, payload: { check_id: check.id, retry: true },
        runAt: new Date(Date.now() + 2 * 3600_000), idempotencyKey: `vcall_retry:${check.id}:${check.attempt_count}`,
      })
      return { retry_scheduled: true }
    }
    await dbQuery(`UPDATE verification_checks SET mode = 'manual', status = 'pending', notes = $2, updated_at = now() WHERE id = $1`, [
      check.id, `Automated attempts exhausted (${status}). Moved to assisted queue.`,
    ])
    const tn = (await dbQuery<{ ticket_number: string }>(`SELECT ticket_number FROM tickets WHERE id = $1`, [check.ticket_id])).rows[0]
    await ensureManualCallTask({ ...check, mode: 'manual' }, tn?.ticket_number ?? '')
    return { moved_to_manual: true }
  }

  const done = await completeVerification({
    orgId: check.organization_id,
    checkId: check.id,
    result: 'inconclusive',
    transcript: transcript ?? '',
    resultJson: { provider_status: status, recording_url: recordingUrl, duration_seconds: body.duration_seconds ?? null },
  })
  return { status: done.status }
}

/** Re-dial an automated check (from the job queue). */
export async function retryAutomatedCall(checkId: string) {
  const res = await dbQuery<VerificationCheckRow & { phone: string | null; lang: string | null }>(
    `SELECT v.*, c.phone_e164 AS phone, COALESCE(c.preferred_language, t.language) AS lang
     FROM verification_checks v JOIN tickets t ON t.id = v.ticket_id LEFT JOIN citizens c ON c.id = v.citizen_id WHERE v.id = $1`,
    [checkId],
  )
  const check = res.rows[0]
  if (!check || check.status !== 'pending' || check.mode !== 'automated' || !check.phone) return { skipped: true }
  const r = await dispatchAutomatedCall(check, check.phone, check.lang ?? 'te')
  await dbQuery(
    `UPDATE verification_checks SET status = CASE WHEN $2 THEN 'in_progress' ELSE status END, provider_ref = COALESCE($3, provider_ref),
            attempt_count = attempt_count + 1, notes = COALESCE($4, notes), updated_at = now() WHERE id = $1`,
    [check.id, r.ok, r.ref ?? null, r.ok ? null : r.error ?? null],
  )
  return { dispatched: r.ok }
}
