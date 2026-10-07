import { Router, type Request } from 'express'
import { requireAuth } from '@/middleware/requireAuth.js'
import { dbQuery } from '@/lib/db.js'
import {
  CASE_WORKER_ROLES,
  clientIp,
  COMMS_APPROVER_ROLES,
  GRO_ROLES,
  HttpError,
  PUBLIC_POST_APPROVER_ROLES,
  TENANT_ADMIN_ROLES,
  bool,
  hasRole,
  isGro,
  oneOf,
  pageParams,
  requirePostgres,
  requireRoles,
  route,
  staffUser,
  str,
  uuid,
  uuidParam,
  type StaffUser,
} from '@/modules/bharosa/common.js'
import { getBharosaSettings, updateBharosaSettings } from '@/modules/bharosa/settings.js'
import { listCaseEvents, projectCitizenStatus, type Visibility } from '@/modules/bharosa/cases/events.js'
import {
  TASK_STATUSES,
  TASK_TYPES,
  assertTicketInOrg,
  changeTaskStatus,
  createTask,
  getTask,
  linkTaskToTickets,
  listTasks,
  summaryCounts,
  taskHistory,
  updateTask,
} from '@/modules/bharosa/cases/tasks.js'
import { approvePlan, generateResolutionPlan, listPlans, rejectPlan } from '@/modules/bharosa/cases/plans.js'
import {
  assignCheck,
  completeVerification,
  listChecksForTicket,
  listVerificationQueue,
  recordManualVerification,
  startVerificationCall,
} from '@/modules/bharosa/cases/verification.js'
import { createEscalation, listEscalations, updateEscalationStatus } from '@/modules/bharosa/cases/escalations.js'
import { suggestAuthorities } from '@/modules/bharosa/directory/routing.js'
import {
  createDirectorySource,
  directoryHealth,
  getDirectorySource,
  listDirectorySources,
  refreshDirectorySource,
  updateDirectorySource,
} from '@/modules/bharosa/directory/sources.js'
import {
  approveCommunication,
  createDraftCommunication,
  editCommunication,
  getCommunication,
  listApprovalQueue,
  listCommunicationEvents,
  listCommunicationVersions,
  listCommunicationsForTicket,
  markSentManually,
  rejectCommunication,
  resolveRecipients,
} from '@/modules/bharosa/comms/communications.js'
import { CONTENT_FORMATS, type ContentFormat } from '@/modules/bharosa/ai/contentAgent.js'
import { reviewAiRun } from '@/modules/bharosa/ai/llm.js'
import {
  addManualFeedItem,
  createFeedSource,
  deleteFeedSource,
  listFeedItemsAdmin,
  listFeedSources,
  moderateFeedItem,
  refreshFeedSource,
  updateFeedSource,
} from '@/modules/bharosa/feed/feed.js'
import { listJobs, retryJob } from '@/modules/bharosa/jobs/queue.js'
import {
  completeAssistedEvidenceUpload,
  confirmAssistedSubmission,
  createAssistedSubmission,
  getAssistedSubmission,
  issueAssistedEvidenceUploadUrl,
  rotateTrackingToken,
  updateAssistedSubmission,
} from '@/modules/bharosa/citizen/submissions.js'

/**
 * Bharosa operations API for staff (`/v2/bharosa`). GRO = super_admin /
 * central_support. Field roles only see cases they own, are assigned to, or
 * hold a task on.
 */
const router = Router()
router.use(requirePostgres, requireAuth, requireRoles([...CASE_WORKER_ROLES, 'media_volunteer']))

const ORG_WIDE_READ_ROLES = [...GRO_ROLES, 'state_leader', 'district_leader'] as const

async function assertCaseAccess(user: StaffUser, ticketId: string) {
  await assertTicketInOrg(user.organization_id, ticketId)
  if (hasRole(user, ORG_WIDE_READ_ROLES)) return
  const res = await dbQuery(
    `SELECT 1 FROM tickets t WHERE t.id = $1 AND (
       t.owner_user_id = $2
       OR EXISTS (SELECT 1 FROM ticket_assignments a WHERE a.ticket_id = t.id AND a.worker_user_id = $2 AND a.is_current
                  AND a.status IN ('offered','accepted','force_assigned'))
       OR EXISTS (SELECT 1 FROM task_tickets tt JOIN tasks k ON k.id = tt.task_id WHERE tt.ticket_id = t.id AND k.owner_user_id = $2))`,
    [ticketId, user.id],
  )
  if (!res.rowCount) throw new HttpError(403, 'You do not have access to this case')
}

function caseId(req: Request): string {
  return uuidParam(req, 'id')
}

function requireGro(user: StaffUser) {
  if (!isGro(user)) throw new HttpError(403, 'GRO role required')
}

// ---------------------------------------------------------------------------
// Case workspace
// ---------------------------------------------------------------------------

router.get('/cases/:id', route(async (req, res) => {
  const user = staffUser(req)
  const id = caseId(req)
  await assertCaseAccess(user, id)
  const orgId = user.organization_id
  const t = (
    await dbQuery<Record<string, unknown> & { stage: string; sub_status: string; outcome: string | null; verification_status: string | null }>(
      `SELECT t.id, t.ticket_number, t.title, t.normalized_summary, t.original_issue_text, t.stage, t.sub_status, t.outcome,
              t.source_channel, t.language, t.severity, t.critical_flag, t.verification_status, t.verified_at, t.routing_status,
              t.structured_facts_json, t.citizen_confirmed_at, t.public_status_enabled, t.reopened_count, t.citizen_feedback_json,
              t.location_text, t.latitude, t.longitude, t.issue_location_source, t.issue_location_precision_m,
              t.reporter_location_text, t.reporter_latitude, t.reporter_longitude, t.reporter_location_source,
              t.created_at, t.updated_at, c.name AS category_name, tr.name AS territory_name,
              ci.id AS citizen_id, ci.display_name AS citizen_name, ci.phone_e164 AS citizen_phone, ci.preferred_language AS citizen_language
       FROM tickets t
       LEFT JOIN issue_categories c ON c.id = t.category_id
       LEFT JOIN territories tr ON tr.id = t.territory_id
       LEFT JOIN citizens ci ON ci.id = t.citizen_id
       WHERE t.id = $1 AND t.organization_id = $2`,
      [id, orgId],
    )
  ).rows[0]
  const [checks, plans, tasks, comms, escalations, consents] = await Promise.all([
    listChecksForTicket(orgId, id),
    listPlans(orgId, id),
    listTasks({ orgId, user: { ...user, roles: { name: 'central_support' } }, ticketId: id, limit: 100, offset: 0 }),
    listCommunicationsForTicket(orgId, id),
    listEscalations({ orgId, ticketId: id, limit: 50, offset: 0 }),
    dbQuery(
      `SELECT DISTINCT ON (consent_type) consent_type, granted, created_at FROM citizen_consents
       WHERE ticket_id = $1 OR (ticket_id IS NULL AND citizen_id = (SELECT citizen_id FROM tickets WHERE id = $1))
       ORDER BY consent_type, created_at DESC`,
      [id],
    ),
  ])
  res.json({
    case: { ...t, citizen_status: projectCitizenStatus(t) },
    verification_checks: checks,
    plans,
    tasks: tasks.tasks,
    communications: comms,
    escalations: escalations.escalations,
    consents: consents.rows,
  })
}))

router.get('/cases/:id/timeline', route(async (req, res) => {
  const user = staffUser(req)
  const id = caseId(req)
  await assertCaseAccess(user, id)
  const v = oneOf(req.query.visibility, ['internal', 'citizen', 'public', 'all'] as const) ?? 'all'
  const vis: Visibility[] = v === 'all' ? ['internal', 'citizen', 'public'] : [v]
  res.json({ events: await listCaseEvents(id, vis) })
}))

router.post('/cases/:id/routing/suggest', route(async (req, res) => {
  const user = staffUser(req)
  const id = caseId(req)
  await assertCaseAccess(user, id)
  res.json(await suggestAuthorities(user.organization_id, id, { persist: true }))
}))

router.post('/cases/:id/tracking-token', requireRoles(GRO_ROLES), route(async (req, res) => {
  const user = staffUser(req)
  const id = caseId(req)
  await assertTicketInOrg(user.organization_id, id)
  res.json({ tracking_token: await rotateTrackingToken(user.organization_id, id) })
}))

// ---------------------------------------------------------------------------
// Assisted intake (Call channel): staff log a phoned-in complaint
// ---------------------------------------------------------------------------

router.use('/intake', requireRoles(CASE_WORKER_ROLES))
router.post('/intake/assisted', route(async (req, res) => {
  res.status(201).json(await createAssistedSubmission(staffUser(req), req.body ?? {}))
}))
router.get('/intake/assisted/:submissionId', route(async (req, res) => {
  res.json(await getAssistedSubmission(staffUser(req).organization_id, uuidParam(req, 'submissionId')))
}))
router.patch('/intake/assisted/:submissionId', route(async (req, res) => {
  res.json(await updateAssistedSubmission(staffUser(req).organization_id, uuidParam(req, 'submissionId'), req.body ?? {}))
}))
router.post('/intake/assisted/:submissionId/evidence/upload-url', route(async (req, res) => {
  res.json(await issueAssistedEvidenceUploadUrl(staffUser(req).organization_id, uuidParam(req, 'submissionId'), req.body ?? {}))
}))
router.post('/intake/assisted/:submissionId/evidence', route(async (req, res) => {
  res.status(201).json(await completeAssistedEvidenceUpload(staffUser(req).organization_id, uuidParam(req, 'submissionId'), req.body ?? {}))
}))
router.post('/intake/assisted/:submissionId/confirm', route(async (req, res) => {
  res.status(201).json(await confirmAssistedSubmission(staffUser(req), uuidParam(req, 'submissionId'), req.body ?? {}, clientIp(req)))
}))

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

router.get('/verification/queue', route(async (req, res) => {
  const user = staffUser(req)
  const { limit, offset, page } = pageParams(req.query as Record<string, unknown>)
  const mine = !isGro(user) || bool(req.query.mine) === true ? user.id : null
  res.json({
    items: await listVerificationQueue({ orgId: user.organization_id, status: str(req.query.status, 20), mine, limit, offset }),
    page, limit,
  })
}))

router.post('/cases/:id/verification/call', route(async (req, res) => {
  const user = staffUser(req)
  const id = caseId(req)
  await assertCaseAccess(user, id)
  const mode = oneOf(req.body?.mode, ['manual', 'automated'] as const) ?? undefined
  res.status(201).json(await startVerificationCall({ orgId: user.organization_id, ticketId: id, mode, requestedBy: user.id }))
}))

router.post('/cases/:id/verification', route(async (req, res) => {
  const user = staffUser(req)
  const id = caseId(req)
  await assertCaseAccess(user, id)
  const method = oneOf(req.body?.method, ['media', 'field', 'document'] as const)
  const result = oneOf(req.body?.result, ['passed', 'failed', 'inconclusive'] as const)
  if (!method || !result) throw new HttpError(400, 'method (media|field|document) and result (passed|failed|inconclusive) are required')
  res.status(201).json(await recordManualVerification({
    orgId: user.organization_id, ticketId: id, user, method, result, notes: str(req.body?.notes, 4000), checklist: req.body?.checklist,
  }))
}))

router.post('/verification/:checkId/assign', route(async (req, res) => {
  const user = staffUser(req)
  const checkId = uuidParam(req, 'checkId')
  const target = req.body?.user_id === null ? null : uuid(req.body?.user_id) ?? user.id
  if (target !== user.id) requireGro(user)
  await assignCheck(user.organization_id, checkId, target)
  res.json({ ok: true })
}))

router.post('/verification/:checkId/complete', route(async (req, res) => {
  const user = staffUser(req)
  const checkId = uuidParam(req, 'checkId')
  const result = oneOf(req.body?.result, ['passed', 'failed', 'inconclusive'] as const)
  if (!result) throw new HttpError(400, 'result (passed|failed|inconclusive) is required')
  const check = await dbQuery<{ ticket_id: string }>(`SELECT ticket_id FROM verification_checks WHERE id = $1 AND organization_id = $2`, [
    checkId, user.organization_id,
  ])
  if (!check.rows[0]) throw new HttpError(404, 'Verification check not found')
  await assertCaseAccess(user, check.rows[0].ticket_id)
  const answers = req.body?.answers && typeof req.body.answers === 'object' ? (req.body.answers as Record<string, string>) : null
  res.json(await completeVerification({
    orgId: user.organization_id, checkId, result, notes: str(req.body?.notes, 4000), answers,
    transcript: str(req.body?.transcript, 50_000), checklist: req.body?.checklist, performedBy: user.id,
  }))
}))

// ---------------------------------------------------------------------------
// Resolution plans (AI proposes → GRO approves → tasks)
// ---------------------------------------------------------------------------

router.get('/cases/:id/plans', route(async (req, res) => {
  const user = staffUser(req)
  const id = caseId(req)
  await assertCaseAccess(user, id)
  res.json({ plans: await listPlans(user.organization_id, id) })
}))

router.post('/cases/:id/plans/generate', requireRoles(GRO_ROLES), route(async (req, res) => {
  const user = staffUser(req)
  const id = caseId(req)
  await assertTicketInOrg(user.organization_id, id)
  res.status(201).json(await generateResolutionPlan({ orgId: user.organization_id, ticketId: id, requestedBy: user.id }))
}))

router.post('/plans/:planId/approve', requireRoles(GRO_ROLES), route(async (req, res) => {
  const user = staffUser(req)
  const owners = req.body?.owners && typeof req.body.owners === 'object' ? (req.body.owners as Record<string, string>) : undefined
  res.json(await approvePlan({
    orgId: user.organization_id, planId: uuidParam(req, 'planId'), gro: user, editedPlan: req.body?.plan, owners, reason: str(req.body?.reason, 2000),
  }))
}))

router.post('/plans/:planId/reject', requireRoles(GRO_ROLES), route(async (req, res) => {
  const user = staffUser(req)
  const reason = str(req.body?.reason, 2000)
  if (!reason) throw new HttpError(400, 'reason is required')
  await rejectPlan({ orgId: user.organization_id, planId: uuidParam(req, 'planId'), gro: user, reason })
  res.json({ ok: true })
}))

// ---------------------------------------------------------------------------
// Tasks (sub-tasks of a case; one task can serve several cases)
// ---------------------------------------------------------------------------

router.get('/tasks', route(async (req, res) => {
  const user = staffUser(req)
  const { limit, offset, page } = pageParams(req.query as Record<string, unknown>)
  const out = await listTasks({
    orgId: user.organization_id, user, status: str(req.query.status, 200), ownerId: uuid(req.query.owner_id),
    ticketId: uuid(req.query.ticket_id), mine: bool(req.query.mine) === true, overdue: bool(req.query.overdue) === true, limit, offset,
  })
  res.json({ ...out, page, limit })
}))

router.get('/tasks/summary', route(async (req, res) => {
  const user = staffUser(req)
  res.json({ counts: await summaryCounts(user.organization_id, user) })
}))

router.post('/tasks', requireRoles(GRO_ROLES), route(async (req, res) => {
  const user = staffUser(req)
  const b = req.body ?? {}
  const ticketIds = Array.isArray(b.ticket_ids) ? b.ticket_ids.filter((x: unknown): x is string => !!uuid(x)) : []
  const title = str(b.title, 300)
  if (!title) throw new HttpError(400, 'title is required')
  res.status(201).json(await createTask({
    orgId: user.organization_id, ticketIds, title, description: str(b.description, 5000),
    taskType: oneOf(b.task_type, TASK_TYPES) ?? 'general', ownerUserId: uuid(b.owner_user_id), suggestedRole: str(b.suggested_role, 50),
    dueAt: str(b.due_at, 40), dependsOnTaskId: uuid(b.depends_on_task_id), authorityContactId: uuid(b.authority_contact_id),
    evidenceRequired: Array.isArray(b.evidence_required) ? b.evidence_required : null, createdBy: user.id,
  }))
}))

router.get('/tasks/:taskId', route(async (req, res) => {
  const user = staffUser(req)
  const task = await getTask(user.organization_id, uuidParam(req, 'taskId'))
  if (!isGro(user) && task.owner_user_id !== user.id && !hasRole(user, ORG_WIDE_READ_ROLES)) throw new HttpError(403, 'Not your task')
  res.json({ task, history: await taskHistory(user.organization_id, task.id) })
}))

router.patch('/tasks/:taskId', route(async (req, res) => {
  const user = staffUser(req)
  const b = req.body ?? {}
  res.json(await updateTask({
    orgId: user.organization_id, user, taskId: uuidParam(req, 'taskId'),
    patch: {
      title: str(b.title, 300), description: str(b.description, 5000),
      ownerUserId: b.owner_user_id === undefined ? undefined : uuid(b.owner_user_id),
      dueAt: b.due_at === undefined ? undefined : str(b.due_at, 40),
      taskType: oneOf(b.task_type, TASK_TYPES),
      dependsOnTaskId: b.depends_on_task_id === undefined ? undefined : uuid(b.depends_on_task_id),
    },
  }))
}))

router.post('/tasks/:taskId/status', route(async (req, res) => {
  const user = staffUser(req)
  const status = oneOf(req.body?.status, TASK_STATUSES)
  if (!status) throw new HttpError(400, `status must be one of ${TASK_STATUSES.join(', ')}`)
  res.json(await changeTaskStatus({ orgId: user.organization_id, user, taskId: uuidParam(req, 'taskId'), status, reason: str(req.body?.reason, 2000) }))
}))

router.post('/tasks/:taskId/links', route(async (req, res) => {
  const user = staffUser(req)
  const ids = Array.isArray(req.body?.ticket_ids) ? (req.body.ticket_ids as unknown[]).filter((x): x is string => !!uuid(x)) : []
  if (!ids.length) throw new HttpError(400, 'ticket_ids[] is required')
  res.json(await linkTaskToTickets({ orgId: user.organization_id, user, taskId: uuidParam(req, 'taskId'), ticketIds: ids, unlink: req.body?.unlink === true }))
}))

// ---------------------------------------------------------------------------
// Communications (AI drafts → approval → send → delivery/replies)
// ---------------------------------------------------------------------------

router.get('/cases/:id/communications', route(async (req, res) => {
  const user = staffUser(req)
  const id = caseId(req)
  await assertCaseAccess(user, id)
  res.json({ communications: await listCommunicationsForTicket(user.organization_id, id) })
}))

router.post('/cases/:id/communications/draft', route(async (req, res) => {
  const user = staffUser(req)
  const id = caseId(req)
  await assertCaseAccess(user, id)
  const b = req.body ?? {}
  const format = oneOf(b.format, CONTENT_FORMATS) as ContentFormat | null
  if (!format) throw new HttpError(400, `format must be one of ${CONTENT_FORMATS.join(', ')}`)
  if (format === 'social_post' && !hasRole(user, PUBLIC_POST_APPROVER_ROLES)) throw new HttpError(403, 'Not allowed to draft public posts')
  if (format !== 'social_post' && !isGro(user) && !hasRole(user, ['district_leader', 'state_leader', 'legal_support'])) {
    throw new HttpError(403, 'Not allowed to draft authority communications')
  }
  const recipients = format === 'social_post' || format === 'citizen_update' ? [] : await resolveRecipients(user.organization_id, b)
  if (format === 'citizen_update') {
    const c = await dbQuery<{ phone_e164: string | null; display_name: string | null }>(
      `SELECT ci.phone_e164, ci.display_name FROM tickets t JOIN citizens ci ON ci.id = t.citizen_id WHERE t.id = $1`,
      [id],
    )
    if (!c.rows[0]?.phone_e164) throw new HttpError(400, 'Citizen has no phone number')
    recipients.push({ name: c.rows[0].display_name, phone: c.rows[0].phone_e164, kind: 'to' })
  }
  const language = b.language === 'te' ? 'te' : 'en'
  const draft = await createDraftCommunication({
    orgId: user.organization_id, ticketId: id, format, recipients, language, approvalBy: 'staff',
    createdByUserId: user.id, taskId: uuid(b.task_id), instructions: str(b.instructions, 1000),
    escalationLevel: Number.isInteger(b.escalation_level) ? b.escalation_level : undefined,
  })
  res.status(201).json(draft)
}))

router.get('/communications/approvals', requireRoles([...COMMS_APPROVER_ROLES, ...PUBLIC_POST_APPROVER_ROLES]), route(async (req, res) => {
  const user = staffUser(req)
  const { limit, offset, page } = pageParams(req.query as Record<string, unknown>)
  let items = await listApprovalQueue(user.organization_id, limit, offset)
  if (!hasRole(user, COMMS_APPROVER_ROLES)) items = items.filter((i) => (i as { purpose: string }).purpose === 'public_post')
  res.json({ items, page, limit })
}))

async function loadCommForUser(req: Request) {
  const user = staffUser(req)
  const comm = await getCommunication(user.organization_id, uuidParam(req, 'commId'))
  if (comm.ticket_id) await assertCaseAccess(user, comm.ticket_id)
  return { user, comm }
}

function assertCanApprove(user: StaffUser, purpose: string) {
  const roles = purpose === 'public_post' ? PUBLIC_POST_APPROVER_ROLES : COMMS_APPROVER_ROLES
  if (!hasRole(user, roles)) throw new HttpError(403, 'You cannot approve this communication')
}

router.get('/communications/:commId', route(async (req, res) => {
  const { user, comm } = await loadCommForUser(req)
  res.json({
    communication: comm,
    events: await listCommunicationEvents(comm.id),
    versions: await listCommunicationVersions(user.organization_id, comm.id),
  })
}))

router.patch('/communications/:commId', route(async (req, res) => {
  const { user, comm } = await loadCommForUser(req)
  if (comm.approval_by === 'citizen') throw new HttpError(403, 'Only the citizen can edit this draft')
  const b = req.body ?? {}
  const recipients = b.contact_ids || b.emails ? await resolveRecipients(user.organization_id, b) : null
  res.json(await editCommunication({
    orgId: user.organization_id, id: comm.id, editorUserId: user.id,
    patch: {
      subject: b.subject !== undefined ? str(b.subject, 300) : undefined, body: str(b.body, 20_000),
      language: b.language === 'en' || b.language === 'te' ? b.language : null, recipients,
    },
  }))
}))

router.post('/communications/:commId/approve', route(async (req, res) => {
  const { user, comm } = await loadCommForUser(req)
  assertCanApprove(user, comm.purpose)
  const language = req.body?.language === 'en' || req.body?.language === 'te' ? req.body.language : null
  res.json(await approveCommunication({ orgId: user.organization_id, id: comm.id, approverUserId: user.id, language }))
}))

router.post('/communications/:commId/reject', route(async (req, res) => {
  const { user, comm } = await loadCommForUser(req)
  assertCanApprove(user, comm.purpose)
  const reason = str(req.body?.reason, 2000)
  if (!reason) throw new HttpError(400, 'reason is required')
  await rejectCommunication({ orgId: user.organization_id, id: comm.id, userId: user.id, reason })
  res.json({ ok: true })
}))

router.post('/communications/:commId/mark-sent', route(async (req, res) => {
  const { user, comm } = await loadCommForUser(req)
  assertCanApprove(user, comm.purpose)
  await markSentManually({ orgId: user.organization_id, id: comm.id, userId: user.id, note: str(req.body?.note, 1000) })
  res.json({ ok: true })
}))

router.post('/communications/:commId/follow-up', requireRoles(COMMS_APPROVER_ROLES), route(async (req, res) => {
  const { user, comm } = await loadCommForUser(req)
  if (comm.direction !== 'outbound' || comm.channel !== 'email' || !comm.ticket_id) throw new HttpError(409, 'Follow-ups apply to sent authority emails')
  if (!['sent', 'delivered'].includes(comm.status)) throw new HttpError(409, 'Send the original first')
  const draft = await createDraftCommunication({
    orgId: user.organization_id, ticketId: comm.ticket_id, taskId: comm.task_id, format: 'follow_up_email',
    recipients: comm.recipients_json, language: comm.language === 'te' ? 'te' : 'en', approvalBy: 'staff',
    createdByUserId: user.id, followUpOf: comm, instructions: str(req.body?.instructions, 1000),
  })
  res.status(201).json(draft)
}))

// ---------------------------------------------------------------------------
// Escalations (GRO queue)
// ---------------------------------------------------------------------------

router.get('/escalations', route(async (req, res) => {
  const user = staffUser(req)
  requireGro(user)
  const { limit, offset, page } = pageParams(req.query as Record<string, unknown>)
  const out = await listEscalations({
    orgId: user.organization_id, status: str(req.query.status, 20) ?? 'open', target: str(req.query.target, 20),
    ticketId: uuid(req.query.ticket_id), limit, offset,
  })
  res.json({ ...out, page, limit })
}))

router.post('/cases/:id/escalations', route(async (req, res) => {
  const user = staffUser(req)
  const id = caseId(req)
  await assertCaseAccess(user, id)
  const reason = str(req.body?.reason, 2000)
  if (!reason) throw new HttpError(400, 'reason is required')
  const escId = await createEscalation({
    orgId: user.organization_id, ticketId: id, taskId: uuid(req.body?.task_id), target: 'gro', trigger: 'manual', reason, createdBy: user.id,
  })
  res.status(201).json({ id: escId })
}))

router.post('/escalations/:escId/status', requireRoles(GRO_ROLES), route(async (req, res) => {
  const user = staffUser(req)
  const status = oneOf(req.body?.status, ['acknowledged', 'resolved', 'dismissed'] as const)
  if (!status) throw new HttpError(400, 'status must be acknowledged | resolved | dismissed')
  await updateEscalationStatus({ orgId: user.organization_id, id: uuidParam(req, 'escId'), userId: user.id, status, note: str(req.body?.note, 2000) })
  res.json({ ok: true })
}))

// ---------------------------------------------------------------------------
// AI control plane
// ---------------------------------------------------------------------------

router.get('/ai-runs', requireRoles(GRO_ROLES), route(async (req, res) => {
  const user = staffUser(req)
  const { limit, offset, page } = pageParams(req.query as Record<string, unknown>)
  const r = await dbQuery(
    `SELECT id, ticket_id, submission_id, agent, model, prompt_version, language, status, confidence, latency_ms, error,
            review_decision, reviewed_by, reviewed_at, created_at,
            CASE WHEN $5::boolean THEN output_json ELSE NULL END AS output_json
     FROM ai_runs WHERE organization_id = $1
       AND ($2::text IS NULL OR agent = $2) AND ($3::uuid IS NULL OR ticket_id = $3) AND ($4::text IS NULL OR status = $4)
     ORDER BY created_at DESC LIMIT $6 OFFSET $7`,
    [user.organization_id, str(req.query.agent, 40), uuid(req.query.ticket_id), str(req.query.status, 20), bool(req.query.include_output) === true, limit, offset],
  )
  res.json({ runs: r.rows, page, limit })
}))

router.get('/ai-runs/metrics', requireRoles(GRO_ROLES), route(async (req, res) => {
  const user = staffUser(req)
  const r = await dbQuery(
    `SELECT agent, COUNT(*)::int AS runs,
            COUNT(*) FILTER (WHERE status = 'succeeded')::int AS succeeded,
            COUNT(*) FILTER (WHERE status IN ('failed','invalid_output'))::int AS failed,
            COUNT(*) FILTER (WHERE review_decision = 'accepted')::int AS accepted,
            COUNT(*) FILTER (WHERE review_decision = 'edited')::int AS edited,
            COUNT(*) FILTER (WHERE review_decision = 'rejected')::int AS rejected,
            ROUND(AVG(latency_ms))::int AS avg_latency_ms
     FROM ai_runs WHERE organization_id = $1 AND created_at > now() - interval '30 days' GROUP BY agent ORDER BY agent`,
    [user.organization_id],
  )
  res.json({ window_days: 30, agents: r.rows })
}))

router.post('/ai-runs/:runId/review', requireRoles(GRO_ROLES), route(async (req, res) => {
  const user = staffUser(req)
  const decision = oneOf(req.body?.decision, ['accepted', 'edited', 'rejected'] as const)
  if (!decision) throw new HttpError(400, 'decision must be accepted | edited | rejected')
  const ok = await reviewAiRun({ runId: uuidParam(req, 'runId'), orgId: user.organization_id, reviewerId: user.id, decision, notes: str(req.body?.notes, 2000) })
  if (!ok) throw new HttpError(404, 'AI run not found')
  res.json({ ok: true })
}))

// ---------------------------------------------------------------------------
// Authority directory sources (scheduled refresh)
// ---------------------------------------------------------------------------

router.get('/directory-sources', requireRoles(GRO_ROLES), route(async (req, res) => {
  res.json({ sources: await listDirectorySources(staffUser(req).organization_id) })
}))
router.post('/directory-sources', requireRoles(GRO_ROLES), route(async (req, res) => {
  const user = staffUser(req)
  res.status(201).json(await createDirectorySource(user.organization_id, user.id, req.body ?? {}))
}))
router.patch('/directory-sources/:sourceId', requireRoles(GRO_ROLES), route(async (req, res) => {
  res.json(await updateDirectorySource(staffUser(req).organization_id, uuidParam(req, 'sourceId'), req.body ?? {}))
}))
router.post('/directory-sources/:sourceId/refresh', requireRoles(GRO_ROLES), route(async (req, res) => {
  const src = await getDirectorySource(staffUser(req).organization_id, uuidParam(req, 'sourceId'))
  try {
    res.json({ ok: true, stats: await refreshDirectorySource(src) })
  } catch (err) {
    throw new HttpError(502, `Refresh failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}))
router.get('/directory/health', requireRoles(GRO_ROLES), route(async (req, res) => {
  res.json({ contacts: await directoryHealth(staffUser(req).organization_id) })
}))

// ---------------------------------------------------------------------------
// Political feed admin
// ---------------------------------------------------------------------------

const FEED_ADMIN_ROLES = [...GRO_ROLES, 'media_volunteer'] as const

router.get('/feed/sources', requireRoles(FEED_ADMIN_ROLES), route(async (req, res) => {
  res.json({ sources: await listFeedSources(staffUser(req).organization_id) })
}))
router.post('/feed/sources', requireRoles(FEED_ADMIN_ROLES), route(async (req, res) => {
  const user = staffUser(req)
  res.status(201).json(await createFeedSource(user.organization_id, user.id, req.body ?? {}))
}))
router.patch('/feed/sources/:sourceId', requireRoles(FEED_ADMIN_ROLES), route(async (req, res) => {
  res.json(await updateFeedSource(staffUser(req).organization_id, uuidParam(req, 'sourceId'), req.body ?? {}))
}))
router.delete('/feed/sources/:sourceId', requireRoles(FEED_ADMIN_ROLES), route(async (req, res) => {
  await deleteFeedSource(staffUser(req).organization_id, uuidParam(req, 'sourceId'))
  res.status(204).end()
}))
router.post('/feed/sources/:sourceId/refresh', requireRoles(FEED_ADMIN_ROLES), route(async (req, res) => {
  const user = staffUser(req)
  const src = (await listFeedSources(user.organization_id)).find((s) => s.id === req.params.sourceId)
  if (!src) throw new HttpError(404, 'Feed source not found')
  try {
    res.json({ ok: true, ...(await refreshFeedSource(src)) })
  } catch (err) {
    throw new HttpError(502, `Refresh failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}))
router.get('/feed/items', requireRoles(FEED_ADMIN_ROLES), route(async (req, res) => {
  const { limit, offset, page } = pageParams(req.query as Record<string, unknown>)
  res.json({ items: await listFeedItemsAdmin(staffUser(req).organization_id, { limit, offset, sourceId: uuid(req.query.source_id) }), page, limit })
}))
router.post('/feed/items', requireRoles(FEED_ADMIN_ROLES), route(async (req, res) => {
  res.status(201).json(await addManualFeedItem(staffUser(req).organization_id, req.body ?? {}))
}))
router.patch('/feed/items/:itemId', requireRoles(FEED_ADMIN_ROLES), route(async (req, res) => {
  res.json(await moderateFeedItem(staffUser(req).organization_id, uuidParam(req, 'itemId'), req.body ?? {}))
}))

// ---------------------------------------------------------------------------
// Tenant settings + jobs
// ---------------------------------------------------------------------------

router.get('/settings', requireRoles(GRO_ROLES), route(async (req, res) => {
  res.json({ settings: await getBharosaSettings(staffUser(req).organization_id) })
}))
router.patch('/settings', requireRoles(TENANT_ADMIN_ROLES), route(async (req, res) => {
  const patch = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? (req.body as Record<string, unknown>) : null
  if (!patch) throw new HttpError(400, 'Body must be a settings object')
  res.json({ settings: await updateBharosaSettings(staffUser(req).organization_id, patch) })
}))

router.get('/jobs', requireRoles(GRO_ROLES), route(async (req, res) => {
  const { limit, offset, page } = pageParams(req.query as Record<string, unknown>)
  res.json({ jobs: await listJobs({ orgId: staffUser(req).organization_id, status: str(req.query.status, 20), type: str(req.query.type, 40), limit, offset }), page, limit })
}))
router.post('/jobs/:jobId/retry', requireRoles(GRO_ROLES), route(async (req, res) => {
  const ok = await retryJob(staffUser(req).organization_id, uuidParam(req, 'jobId'))
  if (!ok) throw new HttpError(409, 'Only dead/failed jobs can be retried')
  res.json({ ok: true })
}))

export default router
