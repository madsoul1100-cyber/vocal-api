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

export interface WorkerIntakeCitizenResult {
  citizenId: string
  isNew: boolean
  verified: boolean
}

/** Normalize phone to E.164-ish for storage and lookup. */
export function normalizeCitizenPhoneE164(phoneRaw: string): string | null {
  const digits = phoneRaw.replace(/\D/g, '')
  if (digits.length < 10 || digits.length > 15) return null
  return phoneRaw.trim().startsWith('+') ? `+${digits}` : `+${digits}`
}

/**
 * Resolve citizen for ground-worker filed ticket.
 * - Existing org citizen with this phone → keep citizens.verified as stored (e.g. WhatsApp = true).
 * - New phone → create citizen with verified = false and manual channel identity.
 */
export async function resolveCitizenForWorkerIntake(
  organizationId: string,
  phoneRaw: string,
  displayName: string,
): Promise<WorkerIntakeCitizenResult> {
  const supabase = createSupabaseServiceClient()
  const phone = normalizeCitizenPhoneE164(phoneRaw)
  if (!phone) {
    throw new Error('invalid_phone')
  }

  const name = displayName.trim().slice(0, 200)
  if (!name) {
    throw new Error('invalid_name')
  }

  const { data: identities, error: lookupErr } = await supabase
    .from('citizen_channel_identities')
    .select('citizen_id')
    .or(`phone.eq.${phone},channel_user_id.eq.${phone}`)

  if (lookupErr) {
    throw new Error('citizen_lookup_failed: ' + lookupErr.message)
  }

  for (const ident of identities ?? []) {
    const citizenId = ident.citizen_id as string
    const { data: citizen } = await supabase
      .from('citizens')
      .select('id, verified, display_name')
      .eq('id', citizenId)
      .eq('organization_id', organizationId)
      .maybeSingle()

    if (!citizen) continue

    const now = new Date().toISOString()
    if (!citizen.display_name?.trim()) {
      await supabase
        .from('citizens')
        .update({ display_name: name, updated_at: now })
        .eq('id', citizen.id)
    }

    const { data: manualRow } = await supabase
      .from('citizen_channel_identities')
      .select('id')
      .eq('citizen_id', citizen.id)
      .eq('channel', 'manual')
      .eq('channel_user_id', phone)
      .maybeSingle()

    if (manualRow) {
      await supabase
        .from('citizen_channel_identities')
        .update({ last_seen_at: now, phone })
        .eq('id', manualRow.id)
    } else {
      await supabase.from('citizen_channel_identities').insert({
        citizen_id: citizen.id,
        channel: 'manual',
        channel_user_id: phone,
        phone,
      })
    }

    return {
      citizenId: citizen.id as string,
      isNew: false,
      verified: citizen.verified === true,
    }
  }

  const { data: citizen, error: citizenError } = await supabase
    .from('citizens')
    .insert({
      organization_id: organizationId,
      display_name: name,
      is_anonymous: false,
      verified: false,
    })
    .select('id, verified')
    .single()

  if (citizenError || !citizen) {
    throw new Error('Failed to create citizen: ' + (citizenError?.message ?? 'unknown'))
  }

  const { error: idErr } = await supabase.from('citizen_channel_identities').insert({
    citizen_id: citizen.id,
    channel: 'manual',
    channel_user_id: phone,
    phone,
  })

  if (idErr) {
    throw new Error('Failed to create citizen channel identity: ' + idErr.message)
  }

  return {
    citizenId: citizen.id as string,
    isNew: true,
    verified: false,
  }
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

export async function upsertCitizenFromWhatsApp(
  organizationId: string,
  phoneE164: string,
  displayName?: string,
): Promise<UpsertCitizenResult> {
  const supabase = createSupabaseServiceClient()
  const channelUserId = phoneE164.startsWith('+') ? phoneE164 : `+${phoneE164.replace(/\D/g, '')}`

  const { data: existing } = await supabase
    .from('citizen_channel_identities')
    .select('citizen_id')
    .eq('channel', 'whatsapp')
    .eq('channel_user_id', channelUserId)
    .single()

  if (existing) {
    const now = new Date().toISOString()
    await supabase
      .from('citizen_channel_identities')
      .update({ last_seen_at: now })
      .eq('channel', 'whatsapp')
      .eq('channel_user_id', channelUserId)

    await supabase
      .from('citizens')
      .update({ verified: true, updated_at: now })
      .eq('id', existing.citizen_id)

    return { citizenId: existing.citizen_id, isNew: false }
  }

  const { data: citizen, error: citizenError } = await supabase
    .from('citizens')
    .insert({
      organization_id: organizationId,
      display_name: displayName ?? null,
      is_anonymous: false,
      verified: true,
    })
    .select('id')
    .single()

  if (citizenError || !citizen) {
    throw new Error('Failed to create citizen: ' + citizenError?.message)
  }

  await supabase.from('citizen_channel_identities').insert({
    citizen_id: citizen.id,
    channel: 'whatsapp',
    channel_user_id: channelUserId,
    username: null,
    phone: channelUserId,
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
