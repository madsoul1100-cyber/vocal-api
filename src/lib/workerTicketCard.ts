/**
 * Worker active-ticket card: SLA copy + suggested primary CTA for list/detail UIs.
 */

import { PENDING_CLOSURE_SUB_STATUS } from '@/lib/ticketStatusCatalog.js'
import { SUB_STATUS_LABELS, type TicketSubStatus } from '@/types/database.js'

export type WorkerPrimaryActionType =
  | 'set_sub_status'
  | 'request_closure'
  | 'open_status_picker'
  | 'open_detail'

export interface WorkerPrimaryAction {
  type: WorkerPrimaryActionType
  /** Button label (e.g. "Contacted via Call"). */
  label: string
  /** For type set_sub_status — POST /v2/tickets/status body.sub_status */
  sub_status?: string
  /** Optional SLA nudge above/beside button (e.g. "Call before 1 hr"). */
  urgency_label?: string | null
}

export interface WorkerSlaFirstContact {
  due_at: string | null
  /** True when due_at passed and citizen not yet contacted. */
  overdue: boolean
  /** Minutes until due (negative if overdue). Null if no due_at. */
  minutes_left: number | null
  /** Human label for card footer, e.g. "24m left", "Overdue". */
  time_left_label: string | null
}

export function subStatusLabel(code: string): string {
  if (code in SUB_STATUS_LABELS) {
    return SUB_STATUS_LABELS[code as TicketSubStatus]
  }
  return code
}

export function buildSlaFirstContactBlock(args: {
  due_at: string | null
  first_contacted_at: string | null
}): WorkerSlaFirstContact | null {
  if (!args.due_at || args.first_contacted_at) return null

  const dueMs = new Date(args.due_at).getTime()
  const nowMs = Date.now()
  const minutesLeft = Math.round((dueMs - nowMs) / 60_000)
  const overdue = minutesLeft < 0

  let time_left_label: string | null
  if (overdue) {
    time_left_label = 'Overdue'
  } else if (minutesLeft < 60) {
    time_left_label = `${minutesLeft}m left`
  } else if (minutesLeft < 24 * 60) {
    const h = Math.floor(minutesLeft / 60)
    const m = minutesLeft % 60
    time_left_label = m > 0 ? `${h}h ${m}m left` : `${h}h left`
  } else {
    const days = Math.floor(minutesLeft / (24 * 60))
    time_left_label = days === 1 ? '1 day left' : `${days} days left`
  }

  return {
    due_at: args.due_at,
    overdue,
    minutes_left: minutesLeft,
    time_left_label,
  }
}

function slaUrgencyLabel(due_at: string | null): string | null {
  if (!due_at) return null
  const minutesLeft = Math.round((new Date(due_at).getTime() - Date.now()) / 60_000)
  if (minutesLeft < 0) return 'Contact overdue'
  if (minutesLeft <= 24) return `Call before ${minutesLeft} min`
  if (minutesLeft <= 60) return 'Call before 1 hr'
  if (minutesLeft <= 24 * 60) {
    const h = Math.ceil(minutesLeft / 60)
    return h === 1 ? 'Call before 1 hr' : `Call before ${h} hrs`
  }
  return null
}

/** Suggested primary button for active-tab cards (Flutter can override with status-options). */
export function computeWorkerPrimaryAction(args: {
  sub_status: string
  stage: string
  first_contacted_at: string | null
  sla_first_contact_due_at: string | null
}): WorkerPrimaryAction {
  const { sub_status, stage, first_contacted_at, sla_first_contact_due_at } = args

  if (sub_status === PENDING_CLOSURE_SUB_STATUS) {
    return { type: 'open_detail', label: 'View closure status' }
  }

  if (sub_status === 'accepted_by_worker' && !first_contacted_at) {
    return {
      type: 'set_sub_status',
      label: 'Contacted via Call',
      sub_status: 'citizen_contacted',
      urgency_label: slaUrgencyLabel(sla_first_contact_due_at),
    }
  }

  if (sub_status === 'citizen_contacted') {
    return {
      type: 'set_sub_status',
      label: 'Met the user',
      sub_status: 'field_verification_in_progress',
    }
  }

  if (
    stage !== 'closed' &&
    first_contacted_at &&
    sub_status !== 'accepted_by_worker'
  ) {
    return {
      type: 'request_closure',
      label: 'Request closure',
    }
  }

  return {
    type: 'open_status_picker',
    label: 'Update status',
  }
}

export function canWorkerRequestClosure(args: {
  stage: string
  sub_status: string
  first_contacted_at: string | null
}): boolean {
  if (args.stage === 'closed') return false
  if (args.sub_status === PENDING_CLOSURE_SUB_STATUS) return false
  return Boolean(args.first_contacted_at)
}
