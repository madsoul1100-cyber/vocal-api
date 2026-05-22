import { createSupabaseServiceClient } from '@/lib/supabase.js'
import { listCandidateWorkers, offerTicketToWorker } from '@/services/assignmentService.js'
import { assignTicketToWorker, canAssignTickets } from '@/services/ticketAssignmentService.js'
import { notifyCitizenOfTicketUpdate } from '@/services/citizenNotifier.js'

const VALID_REJECTION_REASONS = [
  'too_far',
  'irrelevant',
  'conflict_of_interest',
  'safety_concern',
  'outside_jurisdiction',
  'fake_spam',
]

const SUB_STATUS_STAGE_MAP: Record<string, string> = {
  new_awaiting_triage: 'to_do',
  incomplete_information: 'to_do',
  needs_location_validation: 'to_do',
  ready_for_assignment: 'to_do',
  critical_immediate_attention: 'to_do',
  reassignment_pending: 'on_hold',
  assigned_awaiting_acceptance: 'in_progress',
  accepted_by_worker: 'in_progress',
  citizen_contacted: 'in_progress',
  field_verification_in_progress: 'in_progress',
  action_plan_created: 'in_progress',
  escalated_to_authority: 'in_progress',
  escalated_to_internal_leadership: 'in_progress',
  escalated_to_media_support: 'in_progress',
  support_required_from_specialist: 'in_progress',
  waiting_on_external_action: 'in_progress',
  awaiting_citizen_response: 'on_hold',
  awaiting_documents_evidence: 'on_hold',
  unsafe_to_intervene: 'on_hold',
  outside_jurisdiction_review: 'on_hold',
  suspected_fake_spam_review: 'on_hold',
  sla_breach_escalation_queue: 'on_hold',
  resolved_by_organization: 'closed',
  resolved_by_external_party: 'closed',
  unable_to_support: 'closed',
  duplicate_merged_manually: 'closed',
  fake_invalid: 'closed',
  citizen_unresponsive_closed: 'closed',
  closed_by_central_support: 'closed',
  closed_with_advice_only: 'closed',
}

const WORKER_ALLOWED_SUB_STATUSES = new Set([
  'accepted_by_worker',
  'citizen_contacted',
  'field_verification_in_progress',
  'action_plan_created',
  'escalated_to_authority',
  'awaiting_citizen_response',
  'awaiting_documents_evidence',
  'suspected_fake_spam_review',
])

const STAGE_ORDER: Record<string, number> = {
  to_do: 0,
  in_progress: 1,
  on_hold: 2,
  closed: 3,
}

type VocalUser = {
  id: string
  organization_id: string
  roles?: { name: string } | null
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
      stage: 'to_do',
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
    to_stage: 'to_do',
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

export async function updateTicketStatus(
  user: VocalUser,
  ticketId: string,
  subStatus: string,
  workerId?: string,
) {
  const newStage = SUB_STATUS_STAGE_MAP[subStatus]
  if (!newStage) return { ok: false as const, status: 400, error: 'Invalid sub_status value' }

  const roleName = user.roles?.name
  const isPrivileged = roleName === 'super_admin' || roleName === 'central_support'
  const isWorker = roleName === 'ground_worker'

  if (subStatus === 'assigned_awaiting_acceptance') {
    if (!canAssignTickets(roleName)) {
      return {
        ok: false as const,
        status: 403,
        error: 'Only central support can assign tickets to workers',
      }
    }
    if (!workerId?.trim()) {
      return { ok: false as const, status: 400, error: 'worker_id required for assignment' }
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

  const supabase = createSupabaseServiceClient()
  const { data: ticket } = await supabase
    .from('tickets')
    .select('id, organization_id, stage, sub_status, owner_user_id, first_contacted_at')
    .eq('id', ticketId)
    .single()

  if (!ticket || ticket.organization_id !== user.organization_id) {
    return { ok: false as const, status: 404, error: 'Ticket not found' }
  }

  if (isWorker && ticket.owner_user_id !== user.id) {
    return { ok: false as const, status: 403, error: 'You are not the owner of this ticket' }
  }
  if (isWorker && !WORKER_ALLOWED_SUB_STATUSES.has(subStatus)) {
    return { ok: false as const, status: 403, error: 'Status not allowed for workers' }
  }

  const currentStageOrder = STAGE_ORDER[ticket.stage as string] ?? 0
  const newStageOrder = STAGE_ORDER[newStage] ?? 0
  if (!isPrivileged && newStageOrder < currentStageOrder) {
    return {
      ok: false as const,
      status: 403,
      error: 'Only central support can move tickets backward in the stage flow',
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
    prevSubStatus: ticket.sub_status as string,
    newSubStatus: subStatus,
    newStage,
    workerUserId: (ticket.owner_user_id as string | null) ?? null,
  }).catch(() => {})

  return { ok: true as const }
}
