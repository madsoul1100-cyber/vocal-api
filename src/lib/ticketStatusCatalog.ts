import type { TicketStage, TicketSubStatus } from '@/types/database.js'
import { STAGE_LABELS, SUB_STATUS_LABELS } from '@/types/database.js'

/** Parent stage for each sub-status code. */
export const SUB_STATUS_STAGE_MAP: Record<TicketSubStatus, TicketStage> = {
  new_awaiting_triage: 'to_do',
  incomplete_information: 'to_do',
  needs_location_validation: 'to_do',
  ready_for_assignment: 'to_do',
  critical_immediate_attention: 'to_do',
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
  reassignment_pending: 'on_hold',
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

/** Display order within the status picker (privileged catalog). */
const CATALOG_ORDER: TicketSubStatus[] = [
  'new_awaiting_triage',
  'incomplete_information',
  'needs_location_validation',
  'ready_for_assignment',
  'critical_immediate_attention',
  'assigned_awaiting_acceptance',
  'accepted_by_worker',
  'citizen_contacted',
  'field_verification_in_progress',
  'action_plan_created',
  'escalated_to_authority',
  'escalated_to_internal_leadership',
  'escalated_to_media_support',
  'support_required_from_specialist',
  'waiting_on_external_action',
  'awaiting_citizen_response',
  'awaiting_documents_evidence',
  'unsafe_to_intervene',
  'outside_jurisdiction_review',
  'suspected_fake_spam_review',
  'reassignment_pending',
  'sla_breach_escalation_queue',
  'resolved_by_organization',
  'resolved_by_external_party',
  'unable_to_support',
  'duplicate_merged_manually',
  'fake_invalid',
  'citizen_unresponsive_closed',
  'closed_by_central_support',
  'closed_with_advice_only',
]

export const SUB_STATUSES_REQUIRING_WORKER: TicketSubStatus[] = ['assigned_awaiting_acceptance']

export const WORKER_ALLOWED_SUB_STATUSES: TicketSubStatus[] = [
  'accepted_by_worker',
  'citizen_contacted',
  'field_verification_in_progress',
  'action_plan_created',
  'escalated_to_authority',
  'awaiting_citizen_response',
  'awaiting_documents_evidence',
  'suspected_fake_spam_review',
]

export const PRIVILEGED_STATUS_ROLES = ['super_admin', 'central_support'] as const

export const STAGE_ORDER: Record<TicketStage, number> = {
  to_do: 0,
  in_progress: 1,
  on_hold: 2,
  closed: 3,
}

const STAGE_GROUP_ORDER: TicketStage[] = ['to_do', 'in_progress', 'on_hold', 'closed']

export interface StatusOptionItem {
  value: TicketSubStatus
  label: string
}

export interface StatusOptionGroup {
  stage: TicketStage
  label: string
  options: StatusOptionItem[]
}

export interface TicketStatusOptionsResponse {
  stage_labels: Record<TicketStage, string>
  groups: StatusOptionGroup[]
  sub_statuses_requiring_worker: TicketSubStatus[]
  worker_allowed_sub_statuses: TicketSubStatus[]
}

export function isValidSubStatus(code: string): code is TicketSubStatus {
  return code in SUB_STATUS_STAGE_MAP
}

export function stageForSubStatus(subStatus: TicketSubStatus): TicketStage {
  return SUB_STATUS_STAGE_MAP[subStatus]
}

export function isClosedSubStatus(subStatus: TicketSubStatus): boolean {
  return SUB_STATUS_STAGE_MAP[subStatus] === 'closed'
}

function buildGroups(codes: TicketSubStatus[]): StatusOptionGroup[] {
  const byStage = new Map<TicketStage, StatusOptionItem[]>()
  for (const stage of STAGE_GROUP_ORDER) {
    byStage.set(stage, [])
  }
  for (const value of codes) {
    const stage = SUB_STATUS_STAGE_MAP[value]
    byStage.get(stage)!.push({ value, label: SUB_STATUS_LABELS[value] })
  }
  return STAGE_GROUP_ORDER.map((stage) => ({
    stage,
    label: STAGE_LABELS[stage],
    options: byStage.get(stage) ?? [],
  })).filter((g) => g.options.length > 0)
}

export function getTicketStatusOptionsForRole(
  role: string | null | undefined,
): TicketStatusOptionsResponse {
  const privileged =
    !!role && (PRIVILEGED_STATUS_ROLES as readonly string[]).includes(role)
  const isWorker = role === 'ground_worker'

  let codes: TicketSubStatus[] = []
  if (privileged) {
    codes = [...CATALOG_ORDER]
  } else if (isWorker) {
    codes = WORKER_ALLOWED_SUB_STATUSES.filter((c) => CATALOG_ORDER.includes(c))
    codes.sort((a, b) => CATALOG_ORDER.indexOf(a) - CATALOG_ORDER.indexOf(b))
  }

  return {
    stage_labels: { ...STAGE_LABELS },
    groups: buildGroups(codes),
    sub_statuses_requiring_worker: [...SUB_STATUSES_REQUIRING_WORKER],
    worker_allowed_sub_statuses: [...WORKER_ALLOWED_SUB_STATUSES],
  }
}
