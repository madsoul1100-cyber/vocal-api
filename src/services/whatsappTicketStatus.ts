/**
 * WhatsApp ticket status — picker menu + direct status (localized).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { sendWhatsAppMessage, extractTicketNumber } from './whatsappService.js'
import {
  formatWhatsAppDate,
  formatWhatsAppShortDate,
  resolveReplyLanguage,
  stageLabel,
  statusCopy,
  type WhatsAppLang,
} from './whatsappLocale.js'

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
  /\b(when|update|progress|fixed|repair|assigned|accept|done|complete|status|kab|tak|eppudu|ఎప్పుడు|ठीक|बनेगा|होगी|होगा|fix|chey|chesaru)\b/i

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

export function buildTicketPickerMessage(tickets: CitizenTicketRow[], lang: WhatsAppLang): string {
  const c = statusCopy(lang)
  const lines = tickets.map((t, i) => {
    const stage = stageLabel(t.stage, lang)
    const date = formatWhatsAppShortDate(t.updated_at, lang)
    const preview = (t.original_issue_text ?? c.reportPreview).replace(/\s+/g, ' ').slice(0, 45)
    return `${i + 1} — *${t.ticket_number}*\n   ${stage} · ${date}\n   ${preview}${preview.length >= 45 ? '…' : ''}`
  })
  return `${c.pickerTitle}\n\n${lines.join('\n\n')}\n\n${c.pickerFooter}`
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

function formatStatusBody(t: CitizenTicketRow, lang: WhatsAppLang): string {
  const c = statusCopy(lang)
  const updated = formatWhatsAppDate(t.updated_at, lang)
  const preview = (t.original_issue_text ?? '').replace(/\s+/g, ' ').slice(0, 120)
  let body = `*${t.ticket_number}*\n${c.stage}: ${stageLabel(t.stage, lang)}\n${c.lastUpdate}: ${updated}`
  if (preview) body += `\n\n${c.issue}: ${preview}${preview.length >= 120 ? '…' : ''}`
  if (t.stage !== 'closed') body += `\n\n${c.working}`
  return body
}

export async function sendTicketStatus(
  channelUserId: string,
  supabase: SupabaseClient,
  organizationId: string,
  ticketNumber: string,
  lang: WhatsAppLang,
): Promise<boolean> {
  const { data: t } = await supabase
    .from('tickets')
    .select('ticket_number, stage, sub_status, updated_at, original_issue_text')
    .eq('organization_id', organizationId)
    .eq('ticket_number', ticketNumber)
    .maybeSingle()

  const c = statusCopy(lang)
  if (!t) {
    await sendWhatsAppMessage(channelUserId, c.notFound(ticketNumber))
    return false
  }

  await sendWhatsAppMessage(channelUserId, formatStatusBody(t as CitizenTicketRow, lang))
  return true
}

export interface OfferTicketStatusArgs {
  supabase: SupabaseClient
  organizationId: string
  citizenId: string
  channelUserId: string
  preferredTicket?: string | null
  lastTicketNumber?: string | null
  replyLanguage: WhatsAppLang
}

/** Show status directly, or a numbered picker — never ask "do you have your ticket number?". */
export async function offerTicketStatusFlow(args: OfferTicketStatusArgs): Promise<{
  pickerOptions: TicketPickerOption[] | null
  shownTicket: string | null
}> {
  const {
    supabase,
    organizationId,
    citizenId,
    channelUserId,
    preferredTicket,
    lastTicketNumber,
    replyLanguage: lang,
  } = args

  const c = statusCopy(lang)
  const explicit = preferredTicket ?? lastTicketNumber ?? null
  if (explicit) {
    const ok = await sendTicketStatus(channelUserId, supabase, organizationId, explicit, lang)
    return { pickerOptions: null, shownTicket: ok ? explicit : null }
  }

  const tickets = await fetchCitizenTickets(supabase, organizationId, citizenId, 5)

  if (tickets.length === 0) {
    await sendWhatsAppMessage(channelUserId, c.noTickets)
    return { pickerOptions: null, shownTicket: null }
  }

  if (tickets.length === 1) {
    await sendWhatsAppMessage(channelUserId, formatStatusBody(tickets[0], lang))
    return { pickerOptions: null, shownTicket: tickets[0].ticket_number }
  }

  const pickerOptions: TicketPickerOption[] = tickets.map((t, i) => ({
    n: i + 1,
    ticket_number: t.ticket_number,
  }))
  await sendWhatsAppMessage(channelUserId, buildTicketPickerMessage(tickets, lang))
  return { pickerOptions, shownTicket: null }
}

export { resolveReplyLanguage }
