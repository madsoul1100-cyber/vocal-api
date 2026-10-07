import { dbQuery } from '@/lib/db.js'
import { updateTicketStage } from '@/services/ticketService.js'
import { HttpError, type StaffUser } from '../common.js'
import { recordCaseEvent } from './events.js'
import { createEscalation } from './escalations.js'
import { createTask, type TaskRow } from './tasks.js'
import { PlanSchema, runResolutionAgent, type ResolutionPlan } from '../ai/resolutionAgent.js'

export interface PlanRow {
  id: string
  ticket_id: string
  status: string
  issue_type: string | null
  category: string | null
  summary: string | null
  plan_json: ResolutionPlan & { ai_fallback?: boolean }
  authority_candidates_json: unknown
  questions_for_gro_json: string[] | null
  ai_run_id: string | null
  decided_by: string | null
  decided_at: string | null
  decision_reason: string | null
  created_at: string
}

export async function generateResolutionPlan(args: { orgId: string; ticketId: string; requestedBy?: string | null }): Promise<PlanRow> {
  const { plan, runId, fallback, routing } = await runResolutionAgent({ orgId: args.orgId, ticketId: args.ticketId })

  await dbQuery(`UPDATE resolution_plans SET status = 'superseded' WHERE ticket_id = $1 AND status = 'pending_approval'`, [args.ticketId])
  const res = await dbQuery<PlanRow>(
    `INSERT INTO resolution_plans (organization_id, ticket_id, status, issue_type, category, summary, plan_json,
                                   authority_candidates_json, questions_for_gro_json, ai_run_id, created_by)
     VALUES ($1,$2,'pending_approval',$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [
      args.orgId, args.ticketId, plan.issue_type, plan.category ?? null, plan.summary,
      JSON.stringify({ ...plan, ai_fallback: fallback }), JSON.stringify(routing.candidates),
      JSON.stringify(plan.questions_for_gro), runId, args.requestedBy ?? null,
    ],
  )
  const row = res.rows[0]
  await recordCaseEvent({
    orgId: args.orgId, ticketId: args.ticketId, type: 'resolution_plan_suggested', actorType: 'ai_agent',
    actorLabel: 'resolution_agent', visibility: 'internal',
    data: { plan_id: row.id, steps: plan.steps.length, confidence: plan.confidence, questions: plan.questions_for_gro.length },
  })

  if (plan.questions_for_gro.length || plan.confidence < 0.5 || routing.uncertain) {
    await createEscalation({
      orgId: args.orgId, ticketId: args.ticketId, target: 'gro', trigger: 'ai_uncertain',
      reason: [
        'Resolution agent needs GRO input before planning can proceed.',
        ...plan.questions_for_gro.map((q) => `• ${q}`),
        routing.uncertain ? `• Routing: ${routing.uncertainty_reason ?? 'no clear authority'}` : '',
      ].filter(Boolean).join('\n'),
      createdByAgent: 'resolution_agent', dedupeKey: `plan_questions:${row.id}`,
    })
  }
  return row
}

export async function listPlans(orgId: string, ticketId: string): Promise<PlanRow[]> {
  const res = await dbQuery<PlanRow>(
    `SELECT * FROM resolution_plans WHERE organization_id = $1 AND ticket_id = $2 ORDER BY created_at DESC`,
    [orgId, ticketId],
  )
  return res.rows
}

async function getPlan(orgId: string, planId: string): Promise<PlanRow> {
  const res = await dbQuery<PlanRow>(`SELECT * FROM resolution_plans WHERE id = $1 AND organization_id = $2`, [planId, orgId])
  if (!res.rows[0]) throw new HttpError(404, 'Plan not found')
  return res.rows[0]
}

/**
 * GRO approves (optionally edited) plan → steps become owned tasks.
 * `owners` maps step index → user id. Unmapped steps stay visibly unassigned.
 */
export async function approvePlan(args: {
  orgId: string
  planId: string
  gro: StaffUser
  editedPlan?: unknown
  owners?: Record<string, string>
  reason?: string | null
}): Promise<{ plan: PlanRow; tasks: TaskRow[] }> {
  const plan = await getPlan(args.orgId, args.planId)
  if (plan.status !== 'pending_approval') throw new HttpError(409, `Plan is ${plan.status}`)

  let finalPlan: ResolutionPlan = plan.plan_json
  let edited = false
  if (args.editedPlan) {
    const parsed = PlanSchema.safeParse(args.editedPlan)
    if (!parsed.success) throw new HttpError(400, 'Edited plan is invalid', 'INVALID_PLAN', parsed.error.issues)
    finalPlan = parsed.data
    edited = true
  }

  const created: TaskRow[] = []
  const now = Date.now()
  for (let i = 0; i < finalPlan.steps.length; i++) {
    const s = finalPlan.steps[i]
    const owner = args.owners?.[String(i)] ?? null
    const task = await createTask({
      orgId: args.orgId,
      ticketIds: [plan.ticket_id],
      title: s.title,
      description: s.description,
      taskType: s.task_type,
      ownerUserId: owner,
      suggestedRole: s.suggested_role ?? null,
      dueAt: new Date(now + s.due_in_hours * 3600_000).toISOString(),
      dependsOnTaskId: s.depends_on_index != null ? created[s.depends_on_index]?.id ?? null : null,
      planId: plan.id,
      authorityContactId: s.authority_contact_id ?? null,
      evidenceRequired: s.evidence_required,
      sortOrder: i,
      createdBy: args.gro.id,
    })
    created.push(task)
  }

  await dbQuery(
    `UPDATE resolution_plans SET status = 'approved', decided_by = $3, decided_at = now(), decision_reason = $4,
            plan_json = $5 WHERE id = $1 AND organization_id = $2`,
    [plan.id, args.orgId, args.gro.id, args.reason ?? null, JSON.stringify({ ...finalPlan, gro_edited: edited })],
  )
  if (plan.ai_run_id) {
    await dbQuery(`UPDATE ai_runs SET review_decision = $2, reviewed_by = $3, reviewed_at = now() WHERE id = $1`, [
      plan.ai_run_id, edited ? 'edited' : 'accepted', args.gro.id,
    ])
  }

  const t = (await dbQuery<{ stage: string }>(`SELECT stage FROM tickets WHERE id = $1`, [plan.ticket_id])).rows[0]
  await dbQuery(`UPDATE tickets SET resolution_plan_at = COALESCE(resolution_plan_at, now()), needs_triage = false WHERE id = $1`, [plan.ticket_id])
  if (t && t.stage !== 'closed') {
    await updateTicketStage(plan.ticket_id, 'in_progress', 'action_plan_created', args.gro.id, `Resolution plan approved (${created.length} tasks)`)
  }
  await recordCaseEvent({
    orgId: args.orgId, ticketId: plan.ticket_id, type: 'resolution_plan_approved', actorType: 'user', actorUserId: args.gro.id,
    visibility: 'internal', reason: args.reason ?? null, data: { plan_id: plan.id, task_ids: created.map((x) => x.id), edited },
  })
  return { plan: await getPlan(args.orgId, plan.id), tasks: created }
}

export async function rejectPlan(args: { orgId: string; planId: string; gro: StaffUser; reason: string }) {
  const plan = await getPlan(args.orgId, args.planId)
  if (plan.status !== 'pending_approval') throw new HttpError(409, `Plan is ${plan.status}`)
  await dbQuery(`UPDATE resolution_plans SET status = 'rejected', decided_by = $2, decided_at = now(), decision_reason = $3 WHERE id = $1`, [
    plan.id, args.gro.id, args.reason,
  ])
  if (plan.ai_run_id) {
    await dbQuery(`UPDATE ai_runs SET review_decision = 'rejected', reviewed_by = $2, reviewed_at = now(), review_notes = $3 WHERE id = $1`, [
      plan.ai_run_id, args.gro.id, args.reason,
    ])
  }
  await recordCaseEvent({
    orgId: args.orgId, ticketId: plan.ticket_id, type: 'resolution_plan_rejected', actorType: 'user',
    actorUserId: args.gro.id, reason: args.reason, data: { plan_id: plan.id },
  })
}
