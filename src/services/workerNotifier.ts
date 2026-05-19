/**
 * Worker Telegram Notifier
 *
 * Sends Telegram messages to ground workers for:
 *  1. New assignment alerts (with Accept / Reject inline buttons)
 *  2. Daily reminders for open tickets
 *  3. Status update nudges
 *
 * Workers link their Telegram account via a deep-link:
 *   https://t.me/<bot_username>?start=link_<vocaUserId>
 * The bot stores their chat_id in users.metadata_json.telegram_chat_id.
 *
 * Never throws — all functions are fire-and-forget safe.
 */

import { createSupabaseServiceClient } from '@/lib/supabase.js'
import { sendWorkerMessage } from './workerTelegramService'
import type { InlineKeyboardMarkup } from './workerTelegramService'
import { tenantApp } from '@/config/tenant.config.js'

// ── Inline keyboard helpers ────────────────────────────────────────────────

function acceptRejectKeyboard(ticketId: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[
      { text: '✅ Accept', callback_data: `waccept:${ticketId}` },
      { text: '❌ Reject', callback_data: `wreject:${ticketId}` },
    ]],
  }
}

function updateKeyboard(ticketId: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[
      { text: '📝 Update Status', callback_data: `wupdate:${ticketId}` },
    ]],
  }
}

// ── Resolve a worker's Telegram chat_id ───────────────────────────────────

async function getWorkerChatId(workerId: string): Promise<number | null> {
  const supabase = createSupabaseServiceClient()
  const { data } = await supabase
    .from('users')
    .select('metadata_json')
    .eq('id', workerId)
    .single()
  const meta = data?.metadata_json as Record<string, unknown> | null
  const chatId = meta?.telegram_chat_id
  return typeof chatId === 'number' ? chatId : null
}

// ── Link a worker to their Telegram chat_id ───────────────────────────────

export async function linkWorkerTelegram(
  workerId: string,
  chatId: number,
): Promise<{ ok: boolean; reason?: string }> {
  try {
    const supabase = createSupabaseServiceClient()

    const { data: user } = await supabase
      .from('users')
      .select('id, full_name, role_id, metadata_json')
      .eq('id', workerId)
      .single()

    if (!user) return { ok: false, reason: 'user_not_found' }

    const meta = (user.metadata_json as Record<string, unknown> | null) ?? {}
    await supabase
      .from('users')
      .update({ metadata_json: { ...meta, telegram_chat_id: chatId } })
      .eq('id', workerId)

    await sendWorkerMessage(
      chatId,
      `✅ *Telegram linked!*\nHi ${user.full_name}, your account is now connected.\n\nYou'll receive assignment alerts and daily reminders here.`,
    )
    return { ok: true }
  } catch {
    return { ok: false, reason: 'exception' }
  }
}

// ── Assignment alert ───────────────────────────────────────────────────────

export async function notifyWorkerOfAssignment(
  ticketId: string,
  workerId: string,
): Promise<void> {
  try {
    const chatId = await getWorkerChatId(workerId)
    if (!chatId) return

    const supabase = createSupabaseServiceClient()
    const { data: ticket } = await supabase
      .from('tickets')
      .select('ticket_number, original_issue_text, location_text, severity, expires_at')
      .eq('id', ticketId)
      .single()
    if (!ticket) return

    const { data: assignment } = await supabase
      .from('ticket_assignments')
      .select('expires_at')
      .eq('ticket_id', ticketId)
      .eq('worker_user_id', workerId)
      .eq('is_current', true)
      .maybeSingle()

    const severityEmoji: Record<string, string> = {
      critical: '🔴', high: '🟠', medium: '🟡', low: '⚪',
    }
    const sev = ticket.severity ? (severityEmoji[ticket.severity] ?? '⚪') : '⚪'
    const issue = (ticket.original_issue_text ?? '').slice(0, 200)
    const loc   = ticket.location_text ? `📍 ${ticket.location_text}` : '📍 Location not specified'

    let expiryNote = ''
    if (assignment?.expires_at) {
      const mins = Math.max(0, Math.round(
        (new Date(assignment.expires_at).getTime() - Date.now()) / 60000
      ))
      expiryNote = `\n⏱ Accept within *${mins} min* or the ticket will be re-assigned.`
    }

    const body =
      `🔔 *New Ticket Assigned — ${ticket.ticket_number}*\n` +
      `${sev} Severity: ${ticket.severity ?? 'unset'}\n\n` +
      `${issue}\n\n` +
      `${loc}` +
      expiryNote

    await sendWorkerMessage(chatId, body, {
      reply_markup: acceptRejectKeyboard(ticketId),
    })
  } catch {
    // Fire-and-forget — never throw
  }
}

// ── Re-assignment / expiry notice ──────────────────────────────────────────
// Tell the worker whose offer just expired (without acceptance) that the
// ticket has moved on. Without this, their Accept/Reject buttons in Telegram
// silently stop working and they have no idea what happened.
export async function notifyWorkerOfReassignment(
  workerId: string,
  ticketNumber: string,
): Promise<void> {
  try {
    const chatId = await getWorkerChatId(workerId)
    if (!chatId) return
    await sendWorkerMessage(
      chatId,
      `⏰ *Offer expired — ${ticketNumber}*\n\n` +
      `You didn't respond in time, so this ticket has been re-assigned to another team member.\n\n` +
      `If you'd like to take more tickets, just stay on the *${tenantApp.name}* app — new offers will appear automatically.`,
    )
  } catch {
    // Swallow — never throw on notification failure
  }
}

// ── Daily reminder ─────────────────────────────────────────────────────────

export async function sendWorkerDailyReminders(organizationId: string): Promise<{
  sent: number
  skipped: number
}> {
  let sent = 0
  let skipped = 0

  try {
    const supabase = createSupabaseServiceClient()

    // All active ground workers in this org.
    const { data: workers } = await supabase
      .from('users')
      .select('id, full_name, metadata_json, roles!inner(name)')
      .eq('organization_id', organizationId)
      .eq('active', true)
      .eq('roles.name', 'ground_worker')

    for (const worker of workers ?? []) {
      const meta = (worker.metadata_json as Record<string, unknown> | null) ?? {}
      const chatId = typeof meta.telegram_chat_id === 'number' ? meta.telegram_chat_id : null
      if (!chatId) { skipped++; continue }

      // Active (non-closed) tickets assigned to this worker.
      const { data: tickets } = await supabase
        .from('tickets')
        .select('ticket_number, original_issue_text, sub_status, severity')
        .eq('owner_user_id', worker.id)
        .neq('stage', 'closed')
        .order('created_at', { ascending: true })
        .limit(10)

      if (!tickets?.length) { skipped++; continue }

      const lines = tickets.map(t => {
        const sev = t.severity?.[0]?.toUpperCase() ?? '?'
        const text = (t.original_issue_text ?? '').slice(0, 60)
        return `• *${t.ticket_number}* [${sev}] — ${text}…`
      })

      const body =
        `🌅 *Daily Update — ${new Date().toLocaleDateString('en-IN', { dateStyle: 'medium' })}*\n\n` +
        `Hi ${worker.full_name}, you have *${tickets.length}* open ticket${tickets.length > 1 ? 's' : ''}:\n\n` +
        lines.join('\n') +
        `\n\nPlease update progress on any resolved issues.`

      await sendWorkerMessage(chatId, body)
      sent++
    }
  } catch { /* swallow */ }

  return { sent, skipped }
}

// ── Worker accept via Telegram ─────────────────────────────────────────────

export async function workerAcceptViaBot(
  ticketId: string,
  chatId: number,
): Promise<void> {
  try {
    const supabase = createSupabaseServiceClient()

    // Look up worker by chat_id in metadata_json.
    // Supabase doesn't support JSON path filtering on all plans, so we fetch all
    // ground workers and filter in JS. Acceptable given small worker set.
    const { data: workers } = await supabase
      .from('users')
      .select('id, full_name, organization_id, metadata_json')
      .eq('active', true)

    const worker = (workers ?? []).find(w => {
      const m = w.metadata_json as Record<string, unknown> | null
      return m?.telegram_chat_id === chatId
    })
    if (!worker) {
      await sendWorkerMessage(chatId, '⚠️ Could not find your account. Please contact support.')
      return
    }

    const { data: assignment } = await supabase
      .from('ticket_assignments')
      .select('id, status, expires_at')
      .eq('ticket_id', ticketId)
      .eq('worker_user_id', worker.id)
      .eq('is_current', true)
      .maybeSingle()

    if (!assignment || assignment.status !== 'offered') {
      await sendWorkerMessage(chatId, '⚠️ This assignment is no longer active.')
      return
    }
    if (assignment.expires_at && new Date(assignment.expires_at) < new Date()) {
      await sendWorkerMessage(chatId, '⏰ This offer has expired. You may have been assigned a different ticket.')
      return
    }

    const now = new Date().toISOString()

    // Accept: mirror what /api/tickets/accept does, but without Clerk auth.
    await supabase.from('ticket_assignments').update({ status: 'accepted', responded_at: now }).eq('id', assignment.id)

    const { data: ticket } = await supabase
      .from('tickets')
      .select('id, organization_id, stage, sub_status, anonymous_flag, citizen_id')
      .eq('id', ticketId).single()

    if (ticket) {
      const { data: settings } = await supabase
        .from('organization_settings')
        .select('first_contact_sla_hours, resolution_plan_sla_hours')
        .eq('organization_id', ticket.organization_id)
        .maybeSingle()
      const fc  = settings?.first_contact_sla_hours ?? 1
      const res = settings?.resolution_plan_sla_hours ?? 24

      await supabase.from('tickets').update({
        stage: 'in_progress',
        sub_status: 'accepted_by_worker',
        accepted_at: now,
        citizen_identity_revealed_at: now,
        sla_first_contact_due_at: new Date(Date.now() + fc  * 3600000).toISOString(),
        sla_resolution_due_at:    new Date(Date.now() + res * 3600000).toISOString(),
        sla_breached_flag: false,
        last_updated_by_user_id: worker.id,
        updated_at: now,
      }).eq('id', ticketId)

      await supabase.from('ticket_stage_history').insert({
        ticket_id: ticketId,
        from_stage: ticket.stage,
        to_stage: 'in_progress',
        from_sub_status: ticket.sub_status,
        to_sub_status: 'accepted_by_worker',
        changed_by: worker.id,
        change_reason: 'Worker accepted via Telegram bot',
        system_action: false,
      })

      await supabase.from('audit_logs').insert({
        organization_id: ticket.organization_id,
        event_type: 'ticket_accepted',
        entity_type: 'ticket',
        entity_id: ticketId,
        actor_type: 'user',
        actor_user_id: worker.id,
        metadata_json: { via: 'telegram_bot' },
      })

      // Notify citizen
      const { notifyCitizenOfTicketUpdate } = await import('./citizenNotifier')
      notifyCitizenOfTicketUpdate({
        ticketId,
        newSubStatus: 'accepted_by_worker',
        newStage: 'in_progress',
        workerUserId: worker.id,
        key: 'accepted_by_worker',
      }).catch(() => {})
    }

    const { data: t } = await supabase
      .from('tickets').select('ticket_number, citizen_id').eq('id', ticketId).single()

    // Fetch citizen phone so the worker can contact them directly
    let citizenPhone: string | null = null
    if (t?.citizen_id) {
      const { data: identity } = await supabase
        .from('citizen_channel_identities')
        .select('phone')
        .eq('citizen_id', t.citizen_id)
        .not('phone', 'is', null)
        .limit(1)
        .maybeSingle()
      citizenPhone = identity?.phone ?? null
    }

    const phoneNote = citizenPhone ? `\n📞 Citizen phone: *${citizenPhone}*` : ''

    await sendWorkerMessage(chatId,
      `✅ *Accepted — ${t?.ticket_number ?? ticketId}*\nPlease contact the citizen and begin field work.${phoneNote}\n\nUpdate the ticket status once you make progress.`,
      { reply_markup: updateKeyboard(ticketId) },
    )
  } catch { /* swallow */ }
}

// ── Worker reject via Telegram ─────────────────────────────────────────────

export async function workerRejectViaBot(
  ticketId: string,
  chatId: number,
): Promise<void> {
  try {
    const supabase = createSupabaseServiceClient()

    const { data: workers } = await supabase
      .from('users')
      .select('id, organization_id, metadata_json')
      .eq('active', true)

    const worker = (workers ?? []).find(w => {
      const m = w.metadata_json as Record<string, unknown> | null
      return m?.telegram_chat_id === chatId
    })
    if (!worker) {
      await sendWorkerMessage(chatId, '⚠️ Could not find your account.')
      return
    }

    const now = new Date().toISOString()
    await supabase.from('ticket_assignments').update({
      status: 'rejected',
      responded_at: now,
      is_current: false,
    }).eq('ticket_id', ticketId).eq('worker_user_id', worker.id).eq('is_current', true)

    await supabase.from('audit_logs').insert({
      organization_id: worker.organization_id,
      event_type: 'ticket_rejected_by_worker',
      entity_type: 'ticket',
      entity_id: ticketId,
      actor_type: 'user',
      actor_user_id: worker.id,
      metadata_json: { via: 'telegram_bot' },
    })

    // Re-offer to next available worker.
    const { findNearestAvailableWorker, offerTicketToWorker } = await import('./assignmentService')
    const next = await findNearestAvailableWorker(ticketId)
    if (next) {
      offerTicketToWorker({
        ticketId,
        workerId: next.id,
        assignedByUserId: null,
        reason: 'Re-offered after worker rejected via Telegram',
      }).catch(() => {})
    }

    await sendWorkerMessage(chatId, `↩️ Ticket rejected. It will be assigned to another team member.`)
  } catch { /* swallow */ }
}
