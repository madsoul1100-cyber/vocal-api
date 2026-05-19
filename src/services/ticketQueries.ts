/**
 * Ticket Query Helpers
 *
 * Composable Supabase queries for ticket reads.
 * Always scoped by org. RLS adds additional user-level scoping.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { TicketStage, Severity } from '@/types/database.js'

export const TICKET_LIST_SELECT = `
  id, ticket_number, title, original_issue_text, stage, sub_status, severity,
  critical_flag, needs_triage, anonymous_flag, location_text, latitude, longitude,
  created_at, updated_at, accepted_at,
  sla_first_contact_due_at, sla_resolution_due_at, sla_breached_flag,
  territories(id, name),
  users!tickets_owner_user_id_fkey(id, full_name),
  issue_categories!tickets_category_id_fkey(id, name)
` as const

export interface TicketFilters {
  stage?: TicketStage
  severity?: Severity
  needsTriage?: boolean
  slaBreached?: boolean
  hasLocation?: boolean
  ownerId?: string
  search?: string
  limit?: number
  offset?: number
}

export async function queryTickets(
  supabase: SupabaseClient,
  orgId: string,
  filters: TicketFilters = {},
) {
  let query = supabase
    .from('tickets')
    .select(TICKET_LIST_SELECT, { count: 'exact' })
    .eq('organization_id', orgId)
    .order('created_at', { ascending: false })

  if (filters.stage)       query = query.eq('stage', filters.stage)
  if (filters.severity)    query = query.eq('severity', filters.severity)
  if (filters.needsTriage) query = query.eq('needs_triage', true)
  if (filters.slaBreached) query = query.eq('sla_breached_flag', true)
  if (filters.hasLocation) query = query.not('latitude', 'is', null)
  if (filters.ownerId)     query = query.eq('owner_user_id', filters.ownerId)
  if (filters.search) {
    query = query.or(`title.ilike.%${filters.search}%,original_issue_text.ilike.%${filters.search}%,ticket_number.ilike.%${filters.search}%`)
  }

  const limit = filters.limit ?? 50
  const offset = filters.offset ?? 0
  query = query.range(offset, offset + limit - 1)

  return query
}
