import { createSupabaseServiceClient } from '@/lib/supabase.js'
import { isPostgresMode, dbQuery } from '@/lib/db.js'

const WORKER_FILED_TICKET_EVENT = 'worker_filed_ticket'
const ACTIVE_ASSIGNMENT_STATUSES = new Set(['accepted', 'force_assigned'])

export async function resolveWorkerFiledByUserId(ticketId: string): Promise<string | null> {
  if (isPostgresMode()) {
    const res = await dbQuery<{ actor_user_id: string | null }>(
      `SELECT actor_user_id FROM audit_logs
       WHERE entity_type = 'ticket' AND entity_id = $1 AND event_type = $2
       ORDER BY created_at ASC
       LIMIT 1`,
      [ticketId, WORKER_FILED_TICKET_EVENT],
    )
    return res.rows[0]?.actor_user_id ?? null
  }

  const supabase = createSupabaseServiceClient()
  const { data } = await supabase
    .from('audit_logs')
    .select('actor_user_id')
    .eq('entity_type', 'ticket')
    .eq('entity_id', ticketId)
    .eq('event_type', WORKER_FILED_TICKET_EVENT)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  return (data?.actor_user_id as string | null) ?? null
}

async function hasActiveWorkerAssignment(
  ticketId: string,
  workerId: string,
): Promise<boolean> {
  if (isPostgresMode()) {
    const res = await dbQuery<{ status: string }>(
      `SELECT status FROM ticket_assignments
       WHERE ticket_id = $1 AND worker_user_id = $2 AND is_current = true
       LIMIT 1`,
      [ticketId, workerId],
    )
    const status = res.rows[0]?.status
    return !!status && ACTIVE_ASSIGNMENT_STATUSES.has(status)
  }

  const supabase = createSupabaseServiceClient()
  const { data } = await supabase
    .from('ticket_assignments')
    .select('status')
    .eq('ticket_id', ticketId)
    .eq('worker_user_id', workerId)
    .eq('is_current', true)
    .maybeSingle()

  return !!data?.status && ACTIVE_ASSIGNMENT_STATUSES.has(data.status as string)
}

/**
 * Ground workers who filed a ticket may update it once they own an accepted
 * or force-assigned assignment (including territory auto-assign at intake).
 * Other owners keep the existing owner-only rule.
 */
export async function groundWorkerMayUpdateTicket(
  workerId: string,
  ticketId: string,
  ticket: { owner_user_id: string | null; sub_status: string },
): Promise<{ allowed: true } | { allowed: false; status: number; error: string }> {
  const filedByWorkerId = await resolveWorkerFiledByUserId(ticketId)
  const raisedBySelf = filedByWorkerId === workerId

  if (ticket.owner_user_id !== workerId) {
    if (raisedBySelf) {
      return {
        allowed: false,
        status: 403,
        error: 'You can update this ticket only after you are assigned to it',
      }
    }
    return { allowed: false, status: 403, error: 'You are not the owner of this ticket' }
  }

  if (raisedBySelf) {
    const assigned = await hasActiveWorkerAssignment(ticketId, workerId)
    if (!assigned) {
      if (ticket.sub_status === 'assigned_awaiting_acceptance') {
        return {
          allowed: false,
          status: 403,
          error: 'Accept your assignment before updating this ticket',
        }
      }
      return {
        allowed: false,
        status: 403,
        error: 'You can update this ticket only after you are assigned to it',
      }
    }
  }

  return { allowed: true }
}
