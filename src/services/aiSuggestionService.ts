import { createSupabaseServiceClient } from '@/lib/supabase.js'
import type { AiTicketSuggestion } from '@/types/database.js'

export const AI_SUGGESTION_ALLOWED_ROLES = ['super_admin', 'central_support']

type VocalUser = {
  id: string
  organization_id: string
  roles?: { name: string } | null
}

export function canAccessAiSuggestions(role: string | null | undefined): boolean {
  return !!role && AI_SUGGESTION_ALLOWED_ROLES.includes(role)
}

/** Latest completed, unconfirmed suggestion for a ticket (same filter as monolith ticket page). */
export async function getPendingAiSuggestion(
  ticketId: string,
): Promise<AiTicketSuggestion | null> {
  const supabase = createSupabaseServiceClient()
  const { data, error } = await supabase
    .from('ai_ticket_suggestions')
    .select('*')
    .eq('ticket_id', ticketId)
    .eq('status', 'completed')
    .eq('confirmed', false)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    console.error('[getPendingAiSuggestion]', error)
    return null
  }

  return data as AiTicketSuggestion | null
}

export async function confirmAiSuggestion(
  user: VocalUser,
  ticketId: string,
  suggestionId: string,
) {
  const roleName = user.roles?.name
  if (!canAccessAiSuggestions(roleName)) {
    return { ok: false as const, status: 403, error: 'Forbidden — central support or super admin only' }
  }

  const supabase = createSupabaseServiceClient()

  const { data: ticket, error: ticketErr } = await supabase
    .from('tickets')
    .select(
      'id, organization_id, title, summary, severity, department, category_id, subcategory_id, needs_triage',
    )
    .eq('id', ticketId)
    .eq('organization_id', user.organization_id)
    .single()

  if (ticketErr || !ticket) {
    return { ok: false as const, status: 404, error: 'Ticket not found' }
  }

  const { data: suggestion, error: sugErr } = await supabase
    .from('ai_ticket_suggestions')
    .select('*')
    .eq('id', suggestionId)
    .eq('ticket_id', ticketId)
    .eq('status', 'completed')
    .eq('confirmed', false)
    .single()

  if (sugErr || !suggestion) {
    return { ok: false as const, status: 404, error: 'AI suggestion not found or already confirmed' }
  }

  const now = new Date().toISOString()
  const patch: Record<string, unknown> = {
    needs_triage: false,
    ai_suggestions_confirmed: true,
    ai_confirmed_by: user.id,
    ai_confirmed_at: now,
    last_updated_by_user_id: user.id,
    updated_at: now,
  }

  if (!ticket.title && suggestion.suggested_title) {
    patch.title = suggestion.suggested_title
  }
  if (!ticket.summary && suggestion.suggested_summary) {
    patch.summary = suggestion.suggested_summary
  }
  if (!ticket.severity && suggestion.suggested_severity) {
    patch.severity = suggestion.suggested_severity
  }
  if (!ticket.department && suggestion.suggested_department) {
    patch.department = suggestion.suggested_department
  }

  if (!ticket.category_id && suggestion.suggested_category) {
    const { data: categories } = await supabase
      .from('issue_categories')
      .select('id, name')
      .or(`organization_id.eq.${user.organization_id},organization_id.is.null`)
      .eq('active', true)
      .eq('level', 1)
      .ilike('name', suggestion.suggested_category)
      .limit(1)

    if (categories?.[0]) {
      patch.category_id = categories[0].id
    }
  }

  const { error: updateErr } = await supabase.from('tickets').update(patch).eq('id', ticketId)

  if (updateErr) {
    console.error('[confirmAiSuggestion] ticket update', updateErr)
    return { ok: false as const, status: 500, error: updateErr.message }
  }

  const { error: confirmErr } = await supabase
    .from('ai_ticket_suggestions')
    .update({
      confirmed: true,
      confirmed_by: user.id,
      confirmed_at: now,
    })
    .eq('id', suggestionId)

  if (confirmErr) {
    console.error('[confirmAiSuggestion] suggestion update', confirmErr)
    return { ok: false as const, status: 500, error: confirmErr.message }
  }

  await supabase.from('audit_logs').insert({
    organization_id: user.organization_id,
    event_type: 'ai_suggestions_confirmed',
    entity_type: 'ticket',
    entity_id: ticketId,
    actor_type: 'user',
    actor_user_id: user.id,
    metadata_json: {
      suggestion_id: suggestionId,
      applied_fields: Object.keys(patch).filter(
        (k) => !['needs_triage', 'ai_suggestions_confirmed', 'ai_confirmed_by', 'ai_confirmed_at', 'last_updated_by_user_id', 'updated_at'].includes(k),
      ),
    },
  })

  const { data: refreshed, error: refreshErr } = await supabase
    .from('tickets')
    .select(`
      *,
      category:issue_categories!tickets_category_id_fkey(id, name),
      subcategory:issue_categories!tickets_subcategory_id_fkey(id, name),
      owner:users!tickets_owner_user_id_fkey(id, full_name),
      territories(id, name)
    `)
    .eq('id', ticketId)
    .single()

  if (refreshErr || !refreshed) {
    return { ok: true as const, ticket: null }
  }

  return { ok: true as const, ticket: refreshed }
}
