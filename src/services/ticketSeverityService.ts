import { createSupabaseServiceClient } from '@/lib/supabase.js'
import { isValidTicketSeverity } from '@/lib/severity.js'
import { AI_SUGGESTION_ALLOWED_ROLES, canAccessAiSuggestions } from '@/services/aiSuggestionService.js'
import { applyCriticalSeveritySideEffects } from '@/services/ticketService.js'
import { stripTicketAiMirrorFields } from '@/services/ticketQueries.js'

type VocalUser = {
  id: string
  organization_id: string
  roles?: { name: string } | null
}

export { AI_SUGGESTION_ALLOWED_ROLES as SEVERITY_EDIT_ALLOWED_ROLES }

export async function updateTicketSeverity(
  user: VocalUser,
  ticketId: string,
  severityRaw: string,
): Promise<
  | { ok: true; ticket: Record<string, unknown>; previous_severity: string | null }
  | { ok: false; status: number; error: string }
> {
  const roleName = user.roles?.name
  if (!canAccessAiSuggestions(roleName)) {
    return {
      ok: false,
      status: 403,
      error: 'Forbidden — central support or super admin only',
    }
  }

  const severity = severityRaw.trim().toLowerCase()
  if (!isValidTicketSeverity(severity)) {
    return {
      ok: false,
      status: 400,
      error: 'severity must be one of: critical, high, medium, low',
    }
  }

  const supabase = createSupabaseServiceClient()
  const { data: ticket, error: ticketErr } = await supabase
    .from('tickets')
    .select('id, organization_id, severity, critical_flag, stage, sub_status')
    .eq('id', ticketId)
    .eq('organization_id', user.organization_id)
    .single()

  if (ticketErr || !ticket) {
    return { ok: false, status: 404, error: 'Ticket not found' }
  }

  const previousSeverity = (ticket.severity as string | null) ?? null
  if (previousSeverity === severity) {
    const { data: unchanged } = await supabase.from('tickets').select('*').eq('id', ticketId).single()
    return {
      ok: true,
      ticket: stripTicketAiMirrorFields((unchanged ?? ticket) as Record<string, unknown>),
      previous_severity: previousSeverity,
    }
  }

  const now = new Date().toISOString()
  const patch: Record<string, unknown> = {
    severity,
    last_updated_by_user_id: user.id,
    updated_at: now,
  }

  if (severity !== 'critical' && ticket.critical_flag) {
    patch.critical_flag = false
  }

  const { error: updateErr } = await supabase.from('tickets').update(patch).eq('id', ticketId)
  if (updateErr) {
    console.error('[updateTicketSeverity]', updateErr)
    return { ok: false, status: 500, error: updateErr.message }
  }

  if (severity === 'critical') {
    await applyCriticalSeveritySideEffects(ticketId, severity).catch(() => {})
  }

  await supabase.from('audit_logs').insert({
    organization_id: user.organization_id,
    event_type: 'ticket_severity_changed',
    entity_type: 'ticket',
    entity_id: ticketId,
    actor_type: 'user',
    actor_user_id: user.id,
    old_value_json: { severity: previousSeverity },
    new_value_json: { severity },
  })

  const { data: updated } = await supabase.from('tickets').select('*').eq('id', ticketId).single()
  return {
    ok: true,
    ticket: stripTicketAiMirrorFields((updated ?? { ...ticket, ...patch }) as Record<string, unknown>),
    previous_severity: previousSeverity,
  }
}
