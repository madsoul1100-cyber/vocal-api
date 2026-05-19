/**
 * Citizen notifier — pushes status updates back to the citizen on the
 * channel they filed from. Currently Telegram only; WhatsApp + web are
 * placeholders for Phase 2.
 *
 * Fire-and-forget: callers should NOT await this (it's already internally
 * non-throwing), but awaiting is fine — this function never throws.
 *
 * Keeps the outbound-message storage cheap (see project_summary §3.3
 * discussion): we do NOT insert the fully rendered template into
 * channel_messages. Instead we store the template key + variables so the
 * audit trail is complete without bloating rows with repetitive canned
 * text. Outbound traffic also won't inflate retention costs this way.
 */

import { createSupabaseServiceClient } from '@/lib/supabase.js'
import { sendTelegramMessage, citizenStageLabel } from './telegramService'
import { SUB_STATUS_LABELS, type TicketStage, type TicketSubStatus } from '@/types/database.js'

type EventKey =
  | 'ticket_filed'
  | 'assigned_awaiting_acceptance'
  | 'accepted_by_worker'
  | 'citizen_contacted'
  | 'field_verification_in_progress'
  | 'action_plan_created'
  | 'escalated_to_authority'
  | 'awaiting_citizen_response'
  | 'resolved'
  | 'closed'
  | 'stage_generic'

/** Message body = citizen-facing copy. Keep short and neutral. */
function renderBody(args: {
  ticketNumber: string
  key: EventKey
  stage: TicketStage
  subStatus: TicketSubStatus
  workerName?: string | null
}): string {
  const tn = `\`${args.ticketNumber}\``
  const stage = citizenStageLabel(args.stage)
  const sub = SUB_STATUS_LABELS[args.subStatus] ?? args.subStatus

  switch (args.key) {
    case 'assigned_awaiting_acceptance':
      return `📌 *${tn}*: Your report has been assigned to a team member and is awaiting their acceptance.`
    case 'accepted_by_worker':
      return `✅ *${tn}*: ${args.workerName ? args.workerName : 'A team member'} has accepted your report and will begin work shortly.`
    case 'citizen_contacted':
      return `📞 *${tn}*: A team member has noted that you've been contacted about this issue.`
    case 'field_verification_in_progress':
      return `🔍 *${tn}*: Field verification is now in progress.`
    case 'action_plan_created':
      return `🗒️ *${tn}*: An action plan has been created for your issue.`
    case 'escalated_to_authority':
      return `📣 *${tn}*: Your issue has been escalated to the concerned authority.`
    case 'awaiting_citizen_response':
      return `⏸️ *${tn}*: We're waiting for your response to move forward. Please reply whenever you can.`
    case 'resolved':
    case 'closed':
      return `🏁 *${tn}*: This issue has been marked *${sub}*. Thanks for reporting — reply *report* if you need to raise a new one.`
    case 'ticket_filed':
      return `✅ *${tn}* filed. We'll update you as the team picks it up.`
    case 'stage_generic':
    default:
      return `🔔 *${tn}*: Status updated to *${sub}* (${stage}).`
  }
}

function pickKeyFromSubStatus(sub: TicketSubStatus, stage: TicketStage): EventKey {
  // Only notify for milestones that actually matter to the citizen.
  switch (sub) {
    case 'assigned_awaiting_acceptance':
    case 'accepted_by_worker':
    case 'citizen_contacted':
    case 'field_verification_in_progress':
    case 'action_plan_created':
    case 'escalated_to_authority':
    case 'awaiting_citizen_response':
      return sub
    case 'resolved_by_organization':
    case 'resolved_by_external_party':
      return 'resolved'
  }
  if (stage === 'closed') return 'closed'
  return 'stage_generic'
}

/**
 * Main entry point. Resolves the citizen's Telegram chat_id for this ticket,
 * renders the right template, sends it, and writes a lean outbound row to
 * channel_messages (template-key only, not the rendered text).
 *
 * Returns `{ sent: boolean }`. Never throws.
 */
export async function notifyCitizenOfTicketUpdate(args: {
  ticketId: string
  prevSubStatus?: TicketSubStatus | string | null
  newSubStatus: TicketSubStatus | string
  newStage: TicketStage | string
  workerUserId?: string | null
  /** Pre-resolved key override — useful for acceptance/rejection callers. */
  key?: EventKey
}): Promise<{ sent: boolean; reason?: string }> {
  try {
    const supabase = createSupabaseServiceClient()

    const { data: ticket } = await supabase
      .from('tickets')
      .select('id, organization_id, ticket_number, citizen_id')
      .eq('id', args.ticketId)
      .single()
    if (!ticket?.citizen_id) return { sent: false, reason: 'no_citizen' }

    // Resolve a Telegram chat id from the citizen's channel identities.
    const { data: identity } = await supabase
      .from('citizen_channel_identities')
      .select('channel, channel_user_id')
      .eq('citizen_id', ticket.citizen_id)
      .eq('channel', 'telegram')
      .order('last_seen_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (!identity) return { sent: false, reason: 'no_telegram_identity' }

    // Skip no-op (same sub_status).
    if (args.prevSubStatus && args.prevSubStatus === args.newSubStatus && !args.key) {
      return { sent: false, reason: 'unchanged' }
    }

    const key = args.key ?? pickKeyFromSubStatus(
      args.newSubStatus as TicketSubStatus,
      args.newStage as TicketStage,
    )

    let workerName: string | null = null
    if (args.workerUserId) {
      const { data: worker } = await supabase
        .from('users')
        .select('full_name')
        .eq('id', args.workerUserId)
        .maybeSingle()
      workerName = worker?.full_name ?? null
    }

    const body = renderBody({
      ticketNumber: ticket.ticket_number,
      key,
      stage: args.newStage as TicketStage,
      subStatus: args.newSubStatus as TicketSubStatus,
      workerName,
    })

    await sendTelegramMessage(identity.channel_user_id, body)

    // Lean outbound record: template key + variables only, not full text.
    // Find the latest open conversation for this citizen to associate with.
    const { data: conv } = await supabase
      .from('channel_conversations')
      .select('id')
      .eq('organization_id', ticket.organization_id)
      .eq('channel', 'telegram')
      .eq('channel_user_id', identity.channel_user_id)
      .order('last_activity_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (conv) {
      await supabase.from('channel_messages').insert({
        conversation_id: conv.id,
        organization_id: ticket.organization_id,
        channel: 'telegram',
        direction: 'outbound',
        message_type: 'system',
        raw_text: null, // intentional — see comment at top
        raw_payload: {
          template_key: key,
          ticket_number: ticket.ticket_number,
          sub_status: args.newSubStatus,
          stage: args.newStage,
        },
        processed: true,
      }).then(() => {}, () => {})
    }

    return { sent: true }
  } catch {
    return { sent: false, reason: 'exception' }
  }
}
