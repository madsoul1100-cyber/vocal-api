import { createSupabaseServiceClient } from '@/lib/supabase.js'

const PRIVILEGED_ROLES = ['super_admin', 'central_support']

export interface CitizenIdentityBlock {
  revealed: boolean
  anonymous: boolean
  display_name: string | null
  username: string | null
  phone: string | null
  channel: string | null
}

type TicketCitizenFields = {
  citizen_id: string | null
  anonymous_flag: boolean
  source_channel: string
  citizen_identity_revealed_at: string | null
}

function canViewCitizenPii(role: string | null | undefined, ticket: TicketCitizenFields): boolean {
  if (!ticket.citizen_id || ticket.anonymous_flag) return false
  if (role && PRIVILEGED_ROLES.includes(role)) return true
  return !!ticket.citizen_identity_revealed_at
}

/** Citizen contact block for ticket detail (PII gated by role + reveal). */
export async function loadCitizenIdentityForTicket(
  ticket: TicketCitizenFields,
  role: string | null | undefined,
): Promise<CitizenIdentityBlock | null> {
  if (!ticket.citizen_id) return null

  const revealed = !!ticket.citizen_identity_revealed_at
  const anonymous = ticket.anonymous_flag
  const base: CitizenIdentityBlock = {
    revealed,
    anonymous,
    display_name: null,
    username: null,
    phone: null,
    channel: ticket.source_channel ?? null,
  }

  if (!canViewCitizenPii(role, ticket)) {
    return base
  }

  const supabase = createSupabaseServiceClient()
  const { data: citizen, error: citizenErr } = await supabase
    .from('citizens')
    .select('display_name')
    .eq('id', ticket.citizen_id)
    .maybeSingle()

  if (citizenErr) {
    console.error('[loadCitizenIdentityForTicket] citizen', citizenErr)
    return base
  }

  let channelQuery = supabase
    .from('citizen_channel_identities')
    .select('channel, username, phone')
    .eq('citizen_id', ticket.citizen_id)

  if (ticket.source_channel) {
    channelQuery = channelQuery.eq('channel', ticket.source_channel)
  }

  const { data: identities, error: idErr } = await channelQuery.limit(1)

  if (idErr) {
    console.error('[loadCitizenIdentityForTicket] channel identity', idErr)
  }

  const channelRow = identities?.[0] ?? null

  return {
    revealed,
    anonymous,
    display_name: citizen?.display_name ?? null,
    username: channelRow?.username ?? null,
    phone: channelRow?.phone ?? null,
    channel: channelRow?.channel ?? ticket.source_channel ?? null,
  }
}
