/**
 * WhatsApp ticket status — picker menu + direct status (no repeated "enter ticket number").
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { sendWhatsAppMessage, citizenStageLabel, extractTicketNumber } from './whatsappService.js'

export interface TicketPickerOption {
  n: number
  ticket_number: string
}

export interface CitizenTicketRow {
  ticket_number: string
  stage: string
  sub_status: string | null
  updated_at: string
  original_issue_text: string | null
}

const STATUS_FOLLOW_UP =
  /\b(when|update|progress|fixed|repair|assigned|accept|done|complete|status|kab|eppudu|ఎప్పుడు|चेस్తారు|चेय్య|कब|बनेगा|fix)\b/i

export function looksLikeStatusFollowUp(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  if (extractTicketNumber(t)) return true
  return STATUS_FOLLOW_UP.test(t)
}

export function resolveTicketPickerChoice(
  text: string,
  options: TicketPickerOption[],
): string | null {
  const t = text.trim()
  const n = parseInt(t, 10)
  if (!Number.isFinite(n) || n < 1) return null
  const opt = options.find((o) => o.n === n)
  return opt?.ticket_number ?? null
}

export function buildTicketPickerMessage(tickets: CitizenTicketRow[]): string {
  const lines = tickets.map((t, i) => {
    const stage = citizenStageLabel(t.stage)
    const date = new Date(t.updated_at).toLocaleDateString('en-IN', {
      day: 'numeric',
      month: 'short',
    })
    const preview = (t.original_issue_text ?? 'Your report').replace(/\s+/g, ' ').slice(0, 45)
    return `${i + 1} — *${t.ticket_number}*\n   ${stage} · ${date}\n   ${preview}${preview.length >= 45 ? '…' : ''}`
  })
  return `📋 *Your tickets* — reply with a number:\n\n${lines.join('\n\n')}\n\n_Or send the ticket ID (e.g. DEM-2026-00025)._`
}

export async function fetchCitizenTickets(
  supabase: SupabaseClient,
  organizationId: string,
  citizenId: string,
  limit = 5,
): Promise<CitizenTicketRow[]> {
  const { data } = await supabase
    .from('tickets')
    .select('ticket_number, stage, sub_status, updated_at, original_issue_text')
    .eq('organization_id', organizationId)
    .eq('citizen_id', citizenId)
    .order('created_at', { ascending: false })
    .limit(limit)
  return (data ?? []) as CitizenTicketRow[]
}

function formatStatusBody(t: CitizenTicketRow): string {
  const updated = new Date(t.updated_at).toLocaleString('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
  const preview = (t.original_issue_text ?? '').replace(/\s+/g, ' ').slice(0, 120)
  let body = `*${t.ticket_number}*\nStage: ${citizenStageLabel(t.stage)}\nLast update: ${updated}`
  if (preview) body += `\n\nIssue: ${preview}${preview.length >= 120 ? '…' : ''}`
  if (t.stage !== 'closed') {
    body += `\n\nOur team is working on this. Reply *status* anytime for an update, or describe a new problem to file another report.`
  }
  return body
}

export async function sendTicketStatus(
  channelUserId: string,
  supabase: SupabaseClient,
  organizationId: string,
  ticketNumber: string,
): Promise<boolean> {
  const { data: t } = await supabase
    .from('tickets')
    .select('ticket_number, stage, sub_status, updated_at, original_issue_text')
    .eq('organization_id', organizationId)
    .eq('ticket_number', ticketNumber)
    .maybeSingle()

  if (!t) {
    await sendWhatsAppMessage(
      channelUserId,
      `Ticket *${ticketNumber}* was not found. Reply *status* to see your tickets.`,
    )
    return false
  }

  await sendWhatsAppMessage(channelUserId, formatStatusBody(t as CitizenTicketRow))
  return true
}

export interface OfferTicketStatusArgs {
  supabase: SupabaseClient
  organizationId: string
  citizenId: string
  channelUserId: string
  preferredTicket?: string | null
  lastTicketNumber?: string | null
}

/** Show status directly, or a numbered picker — never ask "do you have your ticket number?". */
export async function offerTicketStatusFlow(args: OfferTicketStatusArgs): Promise<{
  pickerOptions: TicketPickerOption[] | null
  shownTicket: string | null
}> {
  const { supabase, organizationId, citizenId, channelUserId, preferredTicket, lastTicketNumber } =
    args

  const explicit = preferredTicket ?? lastTicketNumber ?? null
  if (explicit) {
    const ok = await sendTicketStatus(channelUserId, supabase, organizationId, explicit)
    return { pickerOptions: null, shownTicket: ok ? explicit : null }
  }

  const tickets = await fetchCitizenTickets(supabase, organizationId, citizenId, 5)

  if (tickets.length === 0) {
    await sendWhatsAppMessage(
      channelUserId,
      "You don't have a ticket on record yet. Describe your civic issue and I'll help you file one.",
    )
    return { pickerOptions: null, shownTicket: null }
  }

  if (tickets.length === 1) {
    await sendWhatsAppMessage(channelUserId, formatStatusBody(tickets[0]))
    return { pickerOptions: null, shownTicket: tickets[0].ticket_number }
  }

  const pickerOptions: TicketPickerOption[] = tickets.map((t, i) => ({
    n: i + 1,
    ticket_number: t.ticket_number,
  }))
  await sendWhatsAppMessage(channelUserId, buildTicketPickerMessage(tickets))
  return { pickerOptions, shownTicket: null }
}
