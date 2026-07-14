/**
 * Triage gates CS manual assign / direct assign / re-offer after reject.
 * Every intake path auto-assigns via `directAssignTicketToWorker({ parallelWithTriage: true })`
 * so territory workers receive tickets immediately while CS triage can continue in parallel.
 */

import { createSupabaseServiceClient } from '@/lib/supabase.js'
import type { TicketSubStatus } from '@/types/database.js'

export const TRIAGE_REQUIRED_ERROR = 'triage_required'

export const TRIAGE_REQUIRED_MESSAGE =
  'Complete triage before assigning this ticket to a worker (confirm AI suggestions or set status to Ready for Assignment).'

const PRE_ASSIGNMENT_SUB_STATUSES = new Set<TicketSubStatus>([
  'new_awaiting_triage',
  'incomplete_information',
  'needs_location_validation',
  'reassignment_pending',
  'sla_breach_escalation_queue',
])

/** Patch to mark triage done; moves to_do tickets to ready_for_assignment when appropriate. */
export function buildTriageCompletePatch(args: {
  stage: string
  sub_status: string
}): Record<string, unknown> {
  const patch: Record<string, unknown> = {
    needs_triage: false,
  }
  if (
    args.stage === 'to_do' &&
    PRE_ASSIGNMENT_SUB_STATUSES.has(args.sub_status as TicketSubStatus)
  ) {
    patch.sub_status = 'ready_for_assignment'
  }
  return patch
}

export async function assertTicketReadyForWorkerAssignment(
  ticketId: string,
): Promise<
  | { ok: true; needs_triage: false }
  | { ok: false; error: typeof TRIAGE_REQUIRED_ERROR }
> {
  const supabase = createSupabaseServiceClient()
  const { data: ticket } = await supabase
    .from('tickets')
    .select('needs_triage')
    .eq('id', ticketId)
    .maybeSingle()

  if (!ticket) return { ok: false, error: TRIAGE_REQUIRED_ERROR }
  if (ticket.needs_triage === true) {
    return { ok: false, error: TRIAGE_REQUIRED_ERROR }
  }
  return { ok: true, needs_triage: false }
}
