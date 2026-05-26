/**
 * Ticket Creation Service
 *
 * Creates and manages tickets. Runs server-side only via service role.
 * All writes go through here so audit logging and validation are centralized.
 */

import { createSupabaseServiceClient } from '@/lib/supabase.js'

export interface CreateTicketInput {
  organizationId: string
  sourceChannel: 'telegram' | 'whatsapp' | 'web' | 'manual'
  sourceConversationId?: string
  citizenId?: string
  anonymousFlag?: boolean
  originalIssueText?: string
  locationText?: string
  latitude?: number
  longitude?: number
  attachmentCount?: number
}

export interface TicketCreationResult {
  ticketId: string
  ticketNumber: string
  success: boolean
  error?: string
}

export async function createTicket(input: CreateTicketInput): Promise<TicketCreationResult> {
  const supabase = createSupabaseServiceClient()

  // Get org slug for ticket number
  const { data: org } = await supabase
    .from('organizations')
    .select('slug')
    .eq('id', input.organizationId)
    .single()

  if (!org) {
    return { ticketId: '', ticketNumber: '', success: false, error: 'Organization not found' }
  }

  // Generate ticket number.
  // NOTE: once migration 003_org_scoped_ticket_numbers.sql is applied, switch
  // this call to pass both { org_id: input.organizationId, org_slug: org.slug }.
  // Until then we call the original global-sequence signature so ticket
  // creation keeps working.
  const { data: seqData } = await supabase.rpc('generate_ticket_number', { org_slug: org.slug })
  const ticketNumber = seqData as string

  // Determine flags
  const hasUsableLocation = !!(input.locationText || (input.latitude && input.longitude))
  const needsLocationValidation = !hasUsableLocation
  const incompleteInfo = !input.originalIssueText

  const initialSubStatus = incompleteInfo
    ? 'incomplete_information'
    : needsLocationValidation
      ? 'needs_location_validation'
      : 'new_awaiting_triage'

  const { data: ticket, error } = await supabase
    .from('tickets')
    .insert({
      organization_id: input.organizationId,
      ticket_number: ticketNumber,
      source_channel: input.sourceChannel,
      source_conversation_id: input.sourceConversationId ?? null,
      citizen_id: input.citizenId ?? null,
      anonymous_flag: input.anonymousFlag ?? false,
      original_issue_text: input.originalIssueText ?? null,
      location_text: input.locationText ?? null,
      latitude: input.latitude ?? null,
      longitude: input.longitude ?? null,
      stage: 'to_do',
      sub_status: initialSubStatus,
      incomplete_information_flag: incompleteInfo,
      needs_location_validation_flag: needsLocationValidation,
      needs_triage: true,
      needs_closure_review: false,
      created_by_system: true,
    })
    .select('id, ticket_number')
    .single()

  if (error || !ticket) {
    return { ticketId: '', ticketNumber: '', success: false, error: error?.message ?? 'Insert failed' }
  }

  // Write initial stage history
  await supabase.from('ticket_stage_history').insert({
    ticket_id: ticket.id,
    from_stage: null,
    to_stage: 'to_do',
    from_sub_status: null,
    to_sub_status: initialSubStatus,
    system_action: true,
    change_reason: 'Ticket created from ' + input.sourceChannel + ' intake',
  })

  // Write audit log
  await supabase.from('audit_logs').insert({
    organization_id: input.organizationId,
    event_type: 'ticket_created',
    entity_type: 'ticket',
    entity_id: ticket.id,
    actor_type: 'system',
    new_value_json: {
      ticket_number: ticket.ticket_number,
      source_channel: input.sourceChannel,
      has_location: hasUsableLocation,
      anonymous: input.anonymousFlag ?? false,
    },
  })

  return {
    ticketId: ticket.id,
    ticketNumber: ticket.ticket_number,
    success: true,
  }
}

export async function updateTicketStage(
  ticketId: string,
  newStage: string,
  newSubStatus: string,
  changedByUserId: string | null,
  changeReason: string,
  isSystemAction = false,
) {
  const supabase = createSupabaseServiceClient()

  // Get current state for history
  const { data: current } = await supabase
    .from('tickets')
    .select('id, organization_id, stage, sub_status')
    .eq('id', ticketId)
    .single()

  if (!current) return { success: false, error: 'Ticket not found' }

  // Enforce backward movement rule: only central support / super admin can move backward
  // (enforced at API route level before calling this function)

  const { error } = await supabase
    .from('tickets')
    .update({
      stage: newStage,
      sub_status: newSubStatus,
      last_updated_by_user_id: changedByUserId,
      updated_at: new Date().toISOString(),
    })
    .eq('id', ticketId)

  if (error) return { success: false, error: error.message }

  // Append to stage history
  await supabase.from('ticket_stage_history').insert({
    ticket_id: ticketId,
    from_stage: current.stage,
    to_stage: newStage,
    from_sub_status: current.sub_status,
    to_sub_status: newSubStatus,
    changed_by: changedByUserId,
    change_reason: changeReason,
    system_action: isSystemAction,
  })

  // Audit log
  await supabase.from('audit_logs').insert({
    organization_id: current.organization_id,
    event_type: 'ticket_stage_changed',
    entity_type: 'ticket',
    entity_id: ticketId,
    actor_type: isSystemAction ? 'system' : 'user',
    actor_user_id: changedByUserId,
    old_value_json: { stage: current.stage, sub_status: current.sub_status },
    new_value_json: { stage: newStage, sub_status: newSubStatus },
    metadata_json: { reason: changeReason },
  })

  return { success: true }
}

export async function addTicketNote(
  ticketId: string,
  authorUserId: string | null,
  content: string,
  noteType: 'general' | 'worker_update' | 'escalation' | 'system' | 'closure',
  isInternal = true,
) {
  const supabase = createSupabaseServiceClient()

  const { data: ticket } = await supabase
    .from('tickets')
    .select('organization_id')
    .eq('id', ticketId)
    .single()

  const { data: note, error } = await supabase
    .from('ticket_notes')
    .insert({
      ticket_id: ticketId,
      author_user_id: authorUserId,
      note_type: noteType,
      content,
      is_internal: isInternal,
    })
    .select('id')
    .single()

  if (error || !note) return { success: false, error: error?.message }

  // Audit log
  await supabase.from('audit_logs').insert({
    organization_id: ticket?.organization_id,
    event_type: 'ticket_note_added',
    entity_type: 'ticket',
    entity_id: ticketId,
    actor_type: authorUserId ? 'user' : 'system',
    actor_user_id: authorUserId,
    new_value_json: { note_id: note.id, note_type: noteType, is_internal: isInternal },
  })

  return { success: true, noteId: note.id }
}

/** When severity becomes critical on a to_do ticket, flag for immediate attention. */
export async function applyCriticalSeveritySideEffects(
  ticketId: string,
  severity: string | null | undefined,
): Promise<void> {
  if (severity !== 'critical') return

  const supabase = createSupabaseServiceClient()
  const { data: ticket } = await supabase
    .from('tickets')
    .select('id, organization_id, stage, sub_status')
    .eq('id', ticketId)
    .single()

  if (!ticket || ticket.stage === 'closed') return

  const now = new Date().toISOString()
  const patch: Record<string, unknown> = {
    critical_flag: true,
    updated_at: now,
  }

  if (ticket.stage === 'to_do' && ticket.sub_status !== 'critical_immediate_attention') {
    patch.sub_status = 'critical_immediate_attention'
  }

  await supabase.from('tickets').update(patch).eq('id', ticketId)

  if (patch.sub_status) {
    await supabase.from('ticket_stage_history').insert({
      ticket_id: ticketId,
      from_stage: ticket.stage,
      to_stage: 'to_do',
      from_sub_status: ticket.sub_status,
      to_sub_status: 'critical_immediate_attention',
      change_reason: 'Severity set to critical',
      system_action: true,
    })

    await supabase.from('audit_logs').insert({
      organization_id: ticket.organization_id,
      event_type: 'ticket_critical_flagged',
      entity_type: 'ticket',
      entity_id: ticketId,
      actor_type: 'system',
      new_value_json: { sub_status: 'critical_immediate_attention' },
    })
  }
}
