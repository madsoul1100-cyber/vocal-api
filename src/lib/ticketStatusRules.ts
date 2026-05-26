import type { TicketStage, TicketSubStatus } from '@/types/database.js'
import {
  isClosedSubStatus,
  PENDING_CLOSURE_SUB_STATUS,
  stageForSubStatus,
  STAGE_ORDER,
  WORKER_ALLOWED_SUB_STATUSES,
} from '@/lib/ticketStatusCatalog.js'

/** Workers may set these via POST /v2/tickets/status (not accept, not request-closure). */
export const WORKER_SETTABLE_SUB_STATUSES = new Set<TicketSubStatus>(
  WORKER_ALLOWED_SUB_STATUSES.filter((s) => s !== PENDING_CLOSURE_SUB_STATUS),
)

/** Only central_support / super_admin may set or move tickets onto these. */
export const PRIVILEGED_ONLY_SUB_STATUSES = new Set<TicketSubStatus>([
  'escalated_to_internal_leadership',
  'escalated_to_media_support',
  'support_required_from_specialist',
  'waiting_on_external_action',
  'unsafe_to_intervene',
  'outside_jurisdiction_review',
  'ready_for_assignment',
  'incomplete_information',
  'needs_location_validation',
  'critical_immediate_attention',
  'assigned_awaiting_acceptance',
  'resolved_by_organization',
  'resolved_by_external_party',
  'unable_to_support',
  'duplicate_merged_manually',
  'fake_invalid',
  'citizen_unresponsive_closed',
  'closed_by_central_support',
  'closed_with_advice_only',
])

/** Worker may set; only privileged roles may move the ticket off this sub-status. */
export const WORKER_FLAG_PRIVILEGED_CLEAR_SUB_STATUSES = new Set<TicketSubStatus>([
  'escalated_to_authority',
  'suspected_fake_spam_review',
  PENDING_CLOSURE_SUB_STATUS,
])

export function isWorkerSettableSubStatus(subStatus: TicketSubStatus): boolean {
  return WORKER_SETTABLE_SUB_STATUSES.has(subStatus)
}

export function validateWorkerStatusTransition(args: {
  currentSubStatus: string
  targetSubStatus: TicketSubStatus
  currentStage: TicketStage
}): { ok: true } | { ok: false; error: string } {
  const { currentSubStatus, targetSubStatus, currentStage } = args

  if (!isWorkerSettableSubStatus(targetSubStatus)) {
    return { ok: false, error: 'Status not allowed for workers' }
  }

  if (
    WORKER_FLAG_PRIVILEGED_CLEAR_SUB_STATUSES.has(currentSubStatus as TicketSubStatus) &&
    currentSubStatus !== targetSubStatus
  ) {
    return {
      ok: false,
      error: 'Only central support can change status while this ticket is awaiting review',
    }
  }

  const currentOrder = STAGE_ORDER[currentStage] ?? 0
  const targetOrder = STAGE_ORDER[stageForSubStatus(targetSubStatus)]
  if (targetOrder < currentOrder) {
    return { ok: false, error: 'Workers cannot move tickets to an earlier stage' }
  }

  return { ok: true }
}

export function validatePrivilegedStatusTransition(args: {
  currentSubStatus: string
  targetSubStatus: TicketSubStatus
  isPrivileged: boolean
}): { ok: true } | { ok: false; error: string } {
  if (args.isPrivileged) return { ok: true }
  if (PRIVILEGED_ONLY_SUB_STATUSES.has(args.targetSubStatus)) {
    return { ok: false, error: 'Status not allowed for your role' }
  }
  if (
    WORKER_FLAG_PRIVILEGED_CLEAR_SUB_STATUSES.has(args.currentSubStatus as TicketSubStatus) &&
    args.currentSubStatus !== args.targetSubStatus
  ) {
    return { ok: false, error: 'Only central support can change status while this ticket is awaiting review' }
  }
  return { ok: true }
}

export function shouldClearClosureReview(
  fromSubStatus: string,
  toSubStatus: TicketSubStatus,
): boolean {
  if (fromSubStatus !== PENDING_CLOSURE_SUB_STATUS) return false
  return toSubStatus !== PENDING_CLOSURE_SUB_STATUS
}

export function shouldSetClosureReview(toSubStatus: TicketSubStatus): boolean {
  return toSubStatus === PENDING_CLOSURE_SUB_STATUS
}

export { isClosedSubStatus }
