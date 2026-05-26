import { createSupabaseServiceClient } from '@/lib/supabase.js'
import { listCandidateWorkers, offerTicketToWorker } from '@/services/assignmentService.js'
import {
  getTicketStatusOptionsForRole,
  isClosedSubStatus,
  isValidSubStatus,
  PENDING_CLOSURE_SUB_STATUS,
  PRIVILEGED_STATUS_ROLES,
  stageForSubStatus,
  STAGE_ORDER,
  SUB_STATUSES_REQUIRING_WORKER,
  WORKER_ALLOWED_SUB_STATUSES,
  type TicketStatusOptionsResponse,
} from '@/lib/ticketStatusCatalog.js'
import {
  isWorkerSettableSubStatus,
  shouldClearClosureReview,
  shouldSetClosureReview,
  validatePrivilegedStatusTransition,
  validateWorkerStatusTransition,
} from '@/lib/ticketStatusRules.js'
import { assignTicketToWorker, canAssignTickets } from '@/services/ticketAssignmentService.js'
import { notifyCitizenOfTicketUpdate } from '@/services/citizenNotifier.js'
import { addTicketNote } from '@/services/ticketService.js'

const VALID_REJECTION_REASONS = [
  'too_far',
  'irrelevant',
  'conflict_of_interest',
  'safety_concern',
  'outside_jurisdiction',
  'fake_spam',
]

const WORKER_ALLOWED_SET = new Set<string>(WORKER_ALLOWED_SUB_STATUSES)

type VocalUser = {
  id: string
  organization_id: string
  roles?: { name: string } | null
}

export function getTicketStatusOptions(role: string | null | undefined): TicketStatusOptionsResponse {
  return getTicketStatusOptionsForRole(role)
}

function isPrivilegedRole(role: string | null | undefined): boolean {
  return !!role && (PRIVILEGED_STATUS_ROLES as readonly string[]).includes(role)
}

async function hasCitizenContactedHistory(
  ticketId: string,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const supabase = createSupabaseServiceClient()

  const { count: historyCount, error: histErr } = await supabase
    .from('ticket_stage_history')
    .select('id', { count: 'exact', head: true })
    .eq('ticket_id', ticketId)
    .eq('to_sub_status', 'citizen_contacted')

  if (histErr) {
    return { ok: false, status: 500, error: histErr.message }
  }
  if ((historyCount ?? 0) === 0) {
    return {
      ok: false,
      status: 422,
      error: 'Cannot close: ticket must reach Citizen Contacted first (stage history)',
    }
  }
  return { ok: true }
}

async function hasClosureNote(
  ticketId: string,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const supabase = createSupabaseServiceClient()

  const { count: noteCount, error: noteErr } = await supabase
    .from('ticket_notes')
    .select('id', { count: 'exact', head: true })
    .eq('ticket_id', ticketId)
    .eq('note_type', 'closure')
    .eq('soft_deleted', false)

  if (noteErr) {
    return { ok: false, status: 500, error: noteErr.message }
  }
  if ((noteCount ?? 0) === 0) {
    return {
      ok: false,
      status: 422,
      error: 'Cannot close: add a closure note (note_type closure) before closing',
    }
  }
  return { ok: true }
}

async function validateCloseAllowed(
  ticketId: string,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const contacted = await hasCitizenContactedHistory(ticketId)
  if (!contacted.ok) return contacted
  return hasClosureNote(ticketId)
}

export async function acceptTicket(user: VocalUser, ticketId: string) {
  const supabase = createSupabaseServiceClient()

  const { data: assignment } = await supabase
    .from('ticket_assignments')
    .select('id, ticket_id, worker_user_id, status, expires_at')
    .eq('ticket_id', ticketId)
    .eq('worker_user_id', user.id)
    .eq('is_current', true)
    .single()

  if (!assignment) return { ok: false as const, status: 404, error: 'No active assignment found for this ticket' }
  if (assignment.status !== 'offered') {
    return { ok: false as const, status: 422, error: 'Assignment is not in offered state' }
  }
  if (assignment.expires_at && new Date(assignment.expires_at as string) < new Date()) {
    return { ok: false as const, status: 422, error: 'Assignment offer has expired' }
  }

  const { data: ticket } = await supabase
    .from('tickets')
    .select('id, organization_id, stage, sub_status, anonymous_flag, citizen_id')
    .eq('id', ticketId)
    .single()

  if (!ticket || ticket.organization_id !== user.organization_id) {
    return { ok: false as const, status: 404, error: 'Ticket not found' }
  }

  if (ticket.sub_status !== 'assigned_awaiting_acceptance') {
    return {
      ok: false as const,
      status: 422,
      error: 'Ticket must be in Assigned — Awaiting Acceptance to accept',
    }
  }

  const now = new Date().toISOString()
  const { data: orgSettings } = await supabase
    .from('organization_settings')
    .select('first_contact_sla_hours, resolution_plan_sla_hours')
    .eq('organization_id', user.organization_id)
    .maybeSingle()

  const firstContactHours = (orgSettings as { first_contact_sla_hours?: number } | null)?.first_contact_sla_hours ?? 1
  const resolutionHours = (orgSettings as { resolution_plan_sla_hours?: number } | null)?.resolution_plan_sla_hours ?? 24
  const slaFirstContactDueAt = new Date(Date.now() + firstContactHours * 60 * 60 * 1000).toISOString()
  const slaResolutionDueAt = new Date(Date.now() + resolutionHours * 60 * 60 * 1000).toISOString()

  await supabase.from('ticket_assignments').update({ status: 'accepted', responded_at: now }).eq('id', assignment.id)

  await supabase
    .from('tickets')
    .update({
      stage: 'in_progress',
      sub_status: 'accepted_by_worker',
      accepted_at: now,
      sla_first_contact_due_at: slaFirstContactDueAt,
      sla_resolution_due_at: slaResolutionDueAt,
      sla_breached_flag: false,
      last_updated_by_user_id: user.id,
      updated_at: now,
    })
    .eq('id', ticketId)

  await supabase.from('ticket_stage_history').insert({
    ticket_id: ticketId,
    from_stage: ticket.stage,
    to_stage: 'in_progress',
    from_sub_status: ticket.sub_status,
    to_sub_status: 'accepted_by_worker',
    changed_by: user.id,
    change_reason: 'Worker accepted ticket',
    system_action: false,
  })

  if (!ticket.anonymous_flag && ticket.citizen_id) {
    await supabase
      .from('tickets')
      .update({ citizen_identity_revealed_at: now, citizen_identity_revealed_by: user.id })
      .eq('id', ticketId)

    await supabase.from('audit_logs').insert({
      organization_id: user.organization_id,
      event_type: 'citizen_identity_revealed',
      entity_type: 'ticket',
      entity_id: ticketId,
      actor_type: 'user',
      actor_user_id: user.id,
      metadata_json: { reason: 'worker_accepted', citizen_id: ticket.citizen_id },
    })
  }

  await supabase.from('audit_logs').insert({
    organization_id: user.organization_id,
    event_type: 'ticket_accepted',
    entity_type: 'ticket',
    entity_id: ticketId,
    actor_type: 'user',
    actor_user_id: user.id,
  })

  notifyCitizenOfTicketUpdate({
    ticketId,
    newSubStatus: 'accepted_by_worker',
    newStage: 'in_progress',
    workerUserId: user.id,
    key: 'accepted_by_worker',
  }).catch(() => {})

  return { ok: true as const }
}

export async function rejectTicket(user: VocalUser, ticketId: string, reason: string) {
  if (!VALID_REJECTION_REASONS.includes(reason)) {
    return { ok: false as const, status: 400, error: 'Invalid rejection reason' }
  }

  const supabase = createSupabaseServiceClient()
  const { data: assignment } = await supabase
    .from('ticket_assignments')
    .select('id, ticket_id, worker_user_id, status')
    .eq('ticket_id', ticketId)
    .eq('worker_user_id', user.id)
    .eq('is_current', true)
    .single()

  if (!assignment || assignment.status !== 'offered') {
    return { ok: false as const, status: 404, error: 'No active offer found' }
  }

  const { data: ticket } = await supabase
    .from('tickets')
    .select('id, organization_id, stage, sub_status, assignment_attempt_count')
    .eq('id', ticketId)
    .single()

  if (!ticket || ticket.organization_id !== user.organization_id) {
    return { ok: false as const, status: 404, error: 'Ticket not found' }
  }

  const now = new Date().toISOString()
  await supabase
    .from('ticket_assignments')
    .update({
      status: 'rejected',
      rejection_reason: reason,
      responded_at: now,
      is_current: false,
    })
    .eq('id', assignment.id)

  const newAttemptCount = ((ticket.assignment_attempt_count as number) ?? 0) + 1
  await supabase
    .from('tickets')
    .update({
      stage: 'on_hold',
      sub_status: 'reassignment_pending',
      owner_user_id: null,
      needs_triage: true,
      assignment_attempt_count: newAttemptCount,
      last_updated_by_user_id: user.id,
      updated_at: now,
    })
    .eq('id', ticketId)

  await supabase.from('ticket_stage_history').insert({
    ticket_id: ticketId,
    from_stage: ticket.stage,
    to_stage: 'on_hold',
    from_sub_status: ticket.sub_status,
    to_sub_status: 'reassignment_pending',
    changed_by: user.id,
    change_reason: `Worker rejected: ${reason}`,
    system_action: false,
  })

  await supabase.from('audit_logs').insert({
    organization_id: user.organization_id,
    event_type: 'ticket_rejected',
    entity_type: 'ticket',
    entity_id: ticketId,
    actor_type: 'user',
    actor_user_id: user.id,
    metadata_json: { reason, attempt_count: newAttemptCount },
  })

  let reoffered: { worker_id: string; assignment_id: string; expires_at: string } | null = null
  try {
    const candidates = await listCandidateWorkers(ticketId)
    const next = candidates[0]
    if (next) {
      const offer = await offerTicketToWorker({
        ticketId,
        workerId: next.id,
        assignedByUserId: null,
        reason: `Auto re-offer after rejection (${reason})`,
      })
      if (offer.ok) {
        reoffered = {
          worker_id: next.id,
          assignment_id: offer.assignmentId,
          expires_at: offer.expiresAt,
        }
      }
    }
  } catch {
    /* best-effort */
  }

  return { ok: true as const, reoffered }
}

/** Worker soft-close: closure note + pending_closure_approval (stage stays non-closed). */
export async function requestTicketClosure(
  user: VocalUser,
  ticketId: string,
  noteContent: string,
) {
  const content = noteContent.trim()
  if (!content) {
    return { ok: false as const, status: 400, error: 'note is required' }
  }

  if (user.roles?.name !== 'ground_worker') {
    return { ok: false as const, status: 403, error: 'Only ground workers can request ticket closure' }
  }

  const supabase = createSupabaseServiceClient()
  const { data: ticket } = await supabase
    .from('tickets')
    .select('id, organization_id, stage, sub_status, owner_user_id')
    .eq('id', ticketId)
    .single()

  if (!ticket || ticket.organization_id !== user.organization_id) {
    return { ok: false as const, status: 404, error: 'Ticket not found' }
  }

  if (ticket.owner_user_id !== user.id) {
    return { ok: false as const, status: 403, error: 'You are not the owner of this ticket' }
  }

  if (ticket.stage === 'closed') {
    return { ok: false as const, status: 422, error: 'Ticket is already closed' }
  }

  if (ticket.sub_status === PENDING_CLOSURE_SUB_STATUS) {
    return { ok: false as const, status: 422, error: 'Closure is already pending central support approval' }
  }

  const contacted = await hasCitizenContactedHistory(ticketId)
  if (!contacted.ok) {
    return { ok: false as const, status: contacted.status, error: contacted.error }
  }

  const noteResult = await addTicketNote(ticketId, user.id, content, 'closure', true)
  if (!noteResult.success) {
    return {
      ok: false as const,
      status: 500,
      error: noteResult.error ?? 'Failed to add closure note',
    }
  }

  const now = new Date().toISOString()
  const newStage = stageForSubStatus(PENDING_CLOSURE_SUB_STATUS)

  await supabase
    .from('tickets')
    .update({
      stage: newStage,
      sub_status: PENDING_CLOSURE_SUB_STATUS,
      needs_closure_review: true,
      last_updated_by_user_id: user.id,
      updated_at: now,
    })
    .eq('id', ticketId)

  await supabase.from('ticket_stage_history').insert({
    ticket_id: ticketId,
    from_stage: ticket.stage,
    to_stage: newStage,
    from_sub_status: ticket.sub_status,
    to_sub_status: PENDING_CLOSURE_SUB_STATUS,
    changed_by: user.id,
    change_reason: 'Worker requested closure (pending central support approval)',
    system_action: false,
  })

  await supabase.from('audit_logs').insert({
    organization_id: user.organization_id,
    event_type: 'ticket_closure_requested',
    entity_type: 'ticket',
    entity_id: ticketId,
    actor_type: 'user',
    actor_user_id: user.id,
    new_value_json: { sub_status: PENDING_CLOSURE_SUB_STATUS, note_id: noteResult.noteId },
  })

  notifyCitizenOfTicketUpdate({
    ticketId,
    prevSubStatus: ticket.sub_status as string,
    newSubStatus: PENDING_CLOSURE_SUB_STATUS,
    newStage,
    workerUserId: user.id,
  }).catch(() => {})

  return {
    ok: true as const,
    sub_status: PENDING_CLOSURE_SUB_STATUS,
    stage: newStage,
    closure_pending: true,
    note_id: noteResult.noteId,
  }
}

export async function updateTicketStatus(
  user: VocalUser,
  ticketId: string,
  subStatusRaw: string,
  workerId?: string,
) {
  const subStatus = subStatusRaw.trim()
  if (!subStatus) {
    return { ok: false as const, status: 400, error: 'sub_status required' }
  }
  if (!isValidSubStatus(subStatus)) {
    return { ok: false as const, status: 400, error: 'Invalid sub_status value' }
  }

  const roleName = user.roles?.name
  const isPrivileged = isPrivilegedRole(roleName)
  const isWorker = roleName === 'ground_worker'

  if (subStatus === 'accepted_by_worker') {
    return {
      ok: false as const,
      status: 400,
      error: 'Use POST /v2/tickets/accept to accept a ticket',
    }
  }

  if (isWorker && subStatus === PENDING_CLOSURE_SUB_STATUS) {
    return {
      ok: false as const,
      status: 400,
      error: 'Use POST /v2/tickets/request-closure to request ticket closure',
    }
  }

  /** Assign path: same as POST /v2/tickets/assign (kept for clients that still use /status). */
  if (subStatus === 'assigned_awaiting_acceptance') {
    if (!canAssignTickets(roleName)) {
      return {
        ok: false as const,
        status: 403,
        error: 'Only central support can assign tickets to workers',
      }
    }
    if (!workerId?.trim()) {
      return {
        ok: false as const,
        status: 400,
        error: 'worker_id required — or use POST /v2/tickets/assign',
      }
    }
    const assignResult = await assignTicketToWorker(user, ticketId, workerId.trim())
    if (!assignResult.ok) {
      return { ok: false as const, status: assignResult.status, error: assignResult.error }
    }
    return {
      ok: true as const,
      assignment_id: assignResult.assignment_id,
      expires_at: assignResult.expires_at,
    }
  }

  const newStage = stageForSubStatus(subStatus)

  const supabase = createSupabaseServiceClient()
  const { data: ticket } = await supabase
    .from('tickets')
    .select('id, organization_id, stage, sub_status, owner_user_id, first_contacted_at')
    .eq('id', ticketId)
    .single()

  if (!ticket || ticket.organization_id !== user.organization_id) {
    return { ok: false as const, status: 404, error: 'Ticket not found' }
  }

  const currentSubStatus = String(ticket.sub_status)
  const currentStage = ticket.stage as keyof typeof STAGE_ORDER

  if (isWorker) {
    if (ticket.owner_user_id !== user.id) {
      return { ok: false as const, status: 403, error: 'You are not the owner of this ticket' }
    }
    const workerCheck = validateWorkerStatusTransition({
      currentSubStatus,
      targetSubStatus: subStatus,
      currentStage: currentStage as 'to_do' | 'in_progress' | 'on_hold' | 'closed',
    })
    if (!workerCheck.ok) {
      return { ok: false as const, status: 403, error: workerCheck.error }
    }
    if (!isWorkerSettableSubStatus(subStatus) && !WORKER_ALLOWED_SET.has(subStatus)) {
      return { ok: false as const, status: 403, error: 'Status not allowed for workers' }
    }
  } else {
    const privCheck = validatePrivilegedStatusTransition({
      currentSubStatus,
      targetSubStatus: subStatus,
      isPrivileged,
    })
    if (!privCheck.ok) {
      return { ok: false as const, status: 403, error: privCheck.error }
    }
  }

  if (newStage === 'closed' && !isPrivileged) {
    return {
      ok: false as const,
      status: 403,
      error: 'Only central support can close tickets',
    }
  }

  const currentStageOrder = STAGE_ORDER[currentStage] ?? 0
  const newStageOrder = STAGE_ORDER[newStage]
  if (!isPrivileged && newStageOrder < currentStageOrder) {
    return {
      ok: false as const,
      status: 403,
      error: 'Only central support can move tickets backward in the stage flow',
    }
  }

  if (isClosedSubStatus(subStatus)) {
    const closeCheck = await validateCloseAllowed(ticketId)
    if (!closeCheck.ok) {
      return { ok: false as const, status: closeCheck.status, error: closeCheck.error }
    }
  }

  const now = new Date().toISOString()
  const updates: Record<string, unknown> = {
    stage: newStage,
    sub_status: subStatus,
    last_updated_by_user_id: user.id,
    updated_at: now,
  }

  if (subStatus === 'citizen_contacted' && !ticket.first_contacted_at) {
    updates.first_contacted_at = now
  }
  if (newStage === 'closed') {
    updates.closed_at = now
    updates.needs_closure_review = false
  }
  if (shouldSetClosureReview(subStatus)) {
    updates.needs_closure_review = true
  } else if (shouldClearClosureReview(currentSubStatus, subStatus)) {
    updates.needs_closure_review = false
  }

  await supabase.from('tickets').update(updates).eq('id', ticketId)

  await supabase.from('ticket_stage_history').insert({
    ticket_id: ticketId,
    from_stage: ticket.stage,
    to_stage: newStage,
    from_sub_status: ticket.sub_status,
    to_sub_status: subStatus,
    changed_by: user.id,
    change_reason: 'Status updated by user',
    system_action: false,
  })

  await supabase.from('audit_logs').insert({
    organization_id: user.organization_id,
    event_type: 'ticket_status_changed',
    entity_type: 'ticket',
    entity_id: ticketId,
    actor_type: 'user',
    actor_user_id: user.id,
    old_value_json: { stage: ticket.stage, sub_status: ticket.sub_status },
    new_value_json: { stage: newStage, sub_status: subStatus },
  })

  notifyCitizenOfTicketUpdate({
    ticketId,
    prevSubStatus: currentSubStatus,
    newSubStatus: subStatus,
    newStage,
    workerUserId: (ticket.owner_user_id as string | null) ?? null,
  }).catch(() => {})

  return { ok: true as const }
}
