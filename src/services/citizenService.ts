/**
 * Citizen Identity Service
 *
 * Manages citizen profiles and channel identity mapping.
 * Upserts citizen records from channel messages.
 */

import { createSupabaseServiceClient } from '@/lib/supabase.js'

interface UpsertCitizenResult {
  citizenId: string
  isNew: boolean
}

export async function upsertCitizenFromTelegram(
  organizationId: string,
  telegramUserId: string,
  username: string | undefined,
  displayName: string | undefined,
  phone: string | undefined,
): Promise<UpsertCitizenResult> {
  const supabase = createSupabaseServiceClient()

  // Check if channel identity exists
  const { data: existing } = await supabase
    .from('citizen_channel_identities')
    .select('citizen_id')
    .eq('channel', 'telegram')
    .eq('channel_user_id', telegramUserId)
    .single()

  if (existing) {
    // Update last seen
    await supabase
      .from('citizen_channel_identities')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('channel', 'telegram')
      .eq('channel_user_id', telegramUserId)

    return { citizenId: existing.citizen_id, isNew: false }
  }

  // Create new citizen record
  const { data: citizen, error: citizenError } = await supabase
    .from('citizens')
    .insert({
      organization_id: organizationId,
      display_name: displayName ?? username ?? null,
      is_anonymous: false,
    })
    .select('id')
    .single()

  if (citizenError || !citizen) {
    throw new Error('Failed to create citizen: ' + citizenError?.message)
  }

  // Create channel identity
  await supabase.from('citizen_channel_identities').insert({
    citizen_id: citizen.id,
    channel: 'telegram',
    channel_user_id: telegramUserId,
    username: username ?? null,
    phone: phone ?? null,
  })

  return { citizenId: citizen.id, isNew: true }
}

export async function getOrCreateConversation(
  organizationId: string,
  channel: 'telegram' | 'whatsapp' | 'web',
  channelUserId: string,
  citizenId: string,
): Promise<{ conversationId: string; isNew: boolean; ticketId: string | null }> {
  const supabase = createSupabaseServiceClient()

  // Check for active conversation (not completed/abandoned)
  const { data: existing } = await supabase
    .from('channel_conversations')
    .select('id, ticket_id')
    .eq('channel', channel)
    .eq('channel_user_id', channelUserId)
    .eq('organization_id', organizationId)
    .in('state', ['intake', 'follow_up'])
    .order('started_at', { ascending: false })
    .limit(1)
    .single()

  if (existing) {
    // Update last activity
    await supabase
      .from('channel_conversations')
      .update({ last_activity_at: new Date().toISOString() })
      .eq('id', existing.id)

    return { conversationId: existing.id, isNew: false, ticketId: existing.ticket_id }
  }

  // Create new conversation
  const { data: conv, error } = await supabase
    .from('channel_conversations')
    .insert({
      organization_id: organizationId,
      channel,
      channel_user_id: channelUserId,
      citizen_id: citizenId,
      state: 'intake',
    })
    .select('id')
    .single()

  if (error || !conv) {
    throw new Error('Failed to create conversation: ' + error?.message)
  }

  return { conversationId: conv.id, isNew: true, ticketId: null }
}
