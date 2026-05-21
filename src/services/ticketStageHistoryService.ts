import { createSupabaseServiceClient } from '@/lib/supabase.js'
import { SUB_STATUS_LABELS, STAGE_LABELS } from '@/types/database.js'
import type { TicketStage, TicketSubStatus } from '@/types/database.js'

export interface TicketStageHistoryItem {
  id: string
  ticket_id: string
  from_stage: string | null
  to_stage: string
  from_stage_label: string | null
  to_stage_label: string
  from_sub_status: string | null
  to_sub_status: string
  from_sub_status_label: string | null
  to_sub_status_label: string
  changed_by: { id: string; full_name: string } | null
  changed_by_name: string
  change_reason: string | null
  system_action: boolean
  created_at: string
}

function subStatusLabel(code: string | null | undefined): string | null {
  if (!code) return null
  return code in SUB_STATUS_LABELS
    ? SUB_STATUS_LABELS[code as TicketSubStatus]
    : code
}

function stageLabel(code: string | null | undefined): string | null {
  if (!code) return null
  return code in STAGE_LABELS ? STAGE_LABELS[code as TicketStage] : code
}

/** Status timeline for ticket detail (monolith page.tsx ticket_stage_history query). */
export async function listTicketStageHistory(
  ticketId: string,
  organizationId: string,
): Promise<TicketStageHistoryItem[] | { error: string }> {
  const supabase = createSupabaseServiceClient()

  const { data: ticket, error: ticketErr } = await supabase
    .from('tickets')
    .select('id')
    .eq('id', ticketId)
    .eq('organization_id', organizationId)
    .maybeSingle()

  if (ticketErr) return { error: ticketErr.message }
  if (!ticket) return { error: 'Ticket not found' }

  const { data: rows, error } = await supabase
    .from('ticket_stage_history')
    .select(
      `
      id, ticket_id, from_stage, to_stage, from_sub_status, to_sub_status,
      changed_by, change_reason, system_action, created_at,
      changed_by_user:users!ticket_stage_history_changed_by_fkey(id, full_name)
    `,
    )
    .eq('ticket_id', ticketId)
    .order('created_at', { ascending: false })

  if (error) {
    console.error('[listTicketStageHistory]', error)
    return { error: error.message }
  }

  return (rows ?? []).map((r) => {
    const user = r.changed_by_user as { id?: string; full_name?: string } | null
    const systemAction = r.system_action as boolean
    const toSub = String(r.to_sub_status ?? '')
    const fromSub = (r.from_sub_status as string | null) ?? null
    const toStage = String(r.to_stage ?? '')
    const fromStage = (r.from_stage as string | null) ?? null

    return {
      id: r.id as string,
      ticket_id: r.ticket_id as string,
      from_stage: fromStage,
      to_stage: toStage,
      from_stage_label: stageLabel(fromStage),
      to_stage_label: stageLabel(toStage) ?? toStage,
      from_sub_status: fromSub,
      to_sub_status: toSub,
      from_sub_status_label: subStatusLabel(fromSub),
      to_sub_status_label: subStatusLabel(toSub) ?? toSub,
      changed_by:
        !systemAction && user?.id
          ? { id: user.id, full_name: user.full_name ?? '' }
          : null,
      changed_by_name: systemAction ? 'System' : (user?.full_name ?? 'Unknown'),
      change_reason: (r.change_reason as string | null) ?? null,
      system_action: systemAction,
      created_at: r.created_at as string,
    }
  })
}
