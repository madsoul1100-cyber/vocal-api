/**
 * Apply AI classification at intake (before worker offer) and on re-enrichment.
 * Sets tickets.category_id from suggested_category; later AI runs can override.
 */

import { createSupabaseServiceClient } from '@/lib/supabase.js'
import { generateTicketSuggestions, type AiSuggestionResult } from '@/services/aiService.js'
import { applyCriticalSeveritySideEffects } from '@/services/ticketService.js'

export async function resolveIssueCategoryId(
  organizationId: string,
  categoryLabel: string | null | undefined,
): Promise<{ id: string; name: string } | null> {
  const label = categoryLabel?.trim()
  if (!label) return null

  const supabase = createSupabaseServiceClient()
  const base = supabase
    .from('issue_categories')
    .select('id, name')
    .or(`organization_id.eq.${organizationId},organization_id.is.null`)
    .eq('active', true)
    .eq('level', 1)

  const { data: exact } = await base.ilike('name', label).limit(1)
  if (exact?.[0]) return exact[0]

  const { data: partial } = await base.ilike('name', `%${label}%`).limit(3)
  if (partial?.length === 1) return partial[0]
  if (partial?.length) {
    const lower = label.toLowerCase()
    const best = partial.find((c) => c.name.toLowerCase() === lower) ?? partial[0]
    return best
  }

  if (/other|uncategor/i.test(label)) {
    const { data: other } = await base.ilike('name', '%Other%').limit(1)
    if (other?.[0]) return other[0]
  }

  return null
}

export async function persistAiSuggestionAndApplyToTicket(args: {
  ticketId: string
  organizationId: string
  result: AiSuggestionResult
  /** When true, replace category_id if AI suggests a different resolved category. */
  overrideCategory?: boolean
}): Promise<{ suggestionInserted: boolean; fieldsApplied: string[] }> {
  const { ticketId, organizationId, result, overrideCategory = false } = args
  const supabase = createSupabaseServiceClient()
  const fieldsApplied: string[] = []

  if (!result.error) {
    const { error: insErr } = await supabase.from('ai_ticket_suggestions').insert({
      ticket_id: ticketId,
      model_used: process.env.OPENROUTER_MODEL ?? 'unknown',
      suggested_title: result.suggested_title,
      suggested_summary: result.suggested_summary,
      suggested_category: result.suggested_category,
      suggested_severity: result.suggested_severity,
      suggested_department: result.suggested_department,
      suggested_location_text: result.suggested_location_text,
      confidence_json: result.confidence_json,
      raw_ai_response: result.raw_ai_response as Record<string, unknown>,
      status: 'completed',
    })
    if (insErr) {
      console.error('[ticketIntakeAi] suggestion insert', insErr)
    }
  }

  const { data: ticket } = await supabase
    .from('tickets')
    .select('title, severity, category_id')
    .eq('id', ticketId)
    .single()

  if (!ticket) return { suggestionInserted: !result.error, fieldsApplied }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }

  if (!ticket.title && result.suggested_title) {
    patch.title = result.suggested_title
    fieldsApplied.push('title')
  }

  const resolvedCat = await resolveIssueCategoryId(organizationId, result.suggested_category)
  if (resolvedCat) {
    const shouldSet =
      !ticket.category_id || (overrideCategory && ticket.category_id !== resolvedCat.id)
    if (shouldSet) {
      patch.category_id = resolvedCat.id
      fieldsApplied.push('category_id')
    }
  }

  if (!ticket.severity && result.suggested_severity) {
    patch.severity = result.suggested_severity
    fieldsApplied.push('severity')
  }

  if (fieldsApplied.length > 0) {
    const { error: updErr } = await supabase.from('tickets').update(patch).eq('id', ticketId)
    if (updErr) {
      console.error('[ticketIntakeAi] ticket update', updErr)
    } else if (patch.severity) {
      await applyCriticalSeveritySideEffects(ticketId, patch.severity as string).catch(() => {})
    }
  }

  return { suggestionInserted: !result.error, fieldsApplied }
}

/**
 * Run AI on issue text, store suggestion row, apply category/severity/title to ticket.
 * Call before worker offer so current-offer includes category.
 */
export async function enrichTicketFromIssueText(args: {
  ticketId: string
  organizationId: string
  issueText: string
  overrideCategory?: boolean
}): Promise<{ ok: boolean; error?: string; fieldsApplied?: string[] }> {
  const text = args.issueText.trim()
  if (!text) return { ok: false, error: 'empty_issue_text' }

  const result = await generateTicketSuggestions(text)
  if (result.error) {
    return { ok: false, error: result.error }
  }

  const applied = await persistAiSuggestionAndApplyToTicket({
    ticketId: args.ticketId,
    organizationId: args.organizationId,
    result,
    overrideCategory: args.overrideCategory ?? false,
  })

  return { ok: true, fieldsApplied: applied.fieldsApplied }
}
