import { createSupabaseServiceClient } from '@/lib/supabase.js'
import { isPostgresMode, dbQuery } from '@/lib/db.js'

export interface WorkerAssignmentsPayload {
  offered: {
    id: string
    expires_at: string
    ticket: {
      id: string
      ticket_number: string
      title: string | null
      original_issue_text: string | null
      location_text: string | null
      latitude: number | null
      longitude: number | null
      severity: string | null
      stage: string
      sub_status: string
    } | null
  } | null
  activeTickets: Array<{
    id: string
    ticket_number: string
    title: string | null
    original_issue_text: string | null
    location_text: string | null
    severity: string | null
    stage: string
    sub_status: string
    accepted_at: string | null
    sla_first_contact_due_at: string | null
    sla_resolution_due_at: string | null
    citizen_phone: string | null
  }>
  telegramLinked: boolean
}

function normalizeTicketJoin(raw: unknown): Record<string, unknown> | null {
  if (!raw) return null
  if (Array.isArray(raw)) return (raw[0] as Record<string, unknown>) ?? null
  return raw as Record<string, unknown>
}

export async function getWorkerAssignments(workerId: string): Promise<WorkerAssignmentsPayload> {
  if (isPostgresMode()) {
    return getWorkerAssignmentsPg(workerId)
  }
  return getWorkerAssignmentsSupabase(workerId)
}

async function getWorkerAssignmentsPg(workerId: string): Promise<WorkerAssignmentsPayload> {
  const nowISO = new Date().toISOString()

  const offeredRes = await dbQuery<{
    id: string
    expires_at: string
    ticket_id: string
    ticket_number: string
    title: string | null
    original_issue_text: string | null
    location_text: string | null
    latitude: number | null
    longitude: number | null
    severity: string | null
    stage: string
    sub_status: string
  }>(
    `SELECT ta.id, ta.expires_at,
            t.id AS ticket_id, t.ticket_number, t.title, t.original_issue_text,
            t.location_text, t.latitude, t.longitude, t.severity, t.stage, t.sub_status
     FROM ticket_assignments ta
     INNER JOIN tickets t ON t.id = ta.ticket_id
     WHERE ta.worker_user_id = $1
       AND ta.is_current = true
       AND ta.status = 'offered'
       AND ta.expires_at > $2
     LIMIT 1`,
    [workerId, nowISO],
  )

  const offeredRow = offeredRes.rows[0]
  const offered = offeredRow
    ? {
        id: offeredRow.id,
        expires_at: offeredRow.expires_at,
        ticket: {
          id: offeredRow.ticket_id,
          ticket_number: offeredRow.ticket_number,
          title: offeredRow.title,
          original_issue_text: offeredRow.original_issue_text,
          location_text: offeredRow.location_text,
          latitude: offeredRow.latitude,
          longitude: offeredRow.longitude,
          severity: offeredRow.severity,
          stage: offeredRow.stage,
          sub_status: offeredRow.sub_status,
        },
      }
    : null

  const activeRes = await dbQuery<{
    id: string
    ticket_number: string
    title: string | null
    original_issue_text: string | null
    location_text: string | null
    severity: string | null
    stage: string
    sub_status: string
    accepted_at: string | null
    sla_first_contact_due_at: string | null
    sla_resolution_due_at: string | null
    citizen_id: string | null
    citizen_identity_revealed_at: string | null
  }>(
    `SELECT id, ticket_number, title, original_issue_text, location_text, severity,
            stage, sub_status, accepted_at, sla_first_contact_due_at, sla_resolution_due_at,
            citizen_id, citizen_identity_revealed_at
     FROM tickets
     WHERE owner_user_id = $1
       AND stage = 'in_progress'
       AND sub_status <> 'assigned_awaiting_acceptance'
     ORDER BY accepted_at ASC NULLS LAST`,
    [workerId],
  )

  const revealedIds = activeRes.rows
    .filter((t) => t.citizen_id && t.citizen_identity_revealed_at)
    .map((t) => t.citizen_id as string)

  const phoneMap: Record<string, string> = {}
  if (revealedIds.length > 0) {
    const phones = await dbQuery<{ citizen_id: string; phone: string }>(
      `SELECT citizen_id, phone FROM citizen_channel_identities
       WHERE citizen_id = ANY($1::uuid[]) AND phone IS NOT NULL`,
      [revealedIds],
    )
    for (const row of phones.rows) {
      if (!phoneMap[row.citizen_id]) phoneMap[row.citizen_id] = row.phone
    }
  }

  const userRes = await dbQuery<{ metadata_json: Record<string, unknown> | null }>(
    `SELECT metadata_json FROM users WHERE id = $1`,
    [workerId],
  )
  const meta = userRes.rows[0]?.metadata_json
  const telegramLinked = typeof meta?.telegram_chat_id === 'number'

  return {
    offered,
    activeTickets: activeRes.rows.map((t) => ({
      id: t.id,
      ticket_number: t.ticket_number,
      title: t.title,
      original_issue_text: t.original_issue_text,
      location_text: t.location_text,
      severity: t.severity,
      stage: t.stage,
      sub_status: t.sub_status,
      accepted_at: t.accepted_at,
      sla_first_contact_due_at: t.sla_first_contact_due_at,
      sla_resolution_due_at: t.sla_resolution_due_at,
      citizen_phone: t.citizen_id ? (phoneMap[t.citizen_id] ?? null) : null,
    })),
    telegramLinked,
  }
}

async function getWorkerAssignmentsSupabase(workerId: string): Promise<WorkerAssignmentsPayload> {
  const supabase = createSupabaseServiceClient()
  const nowISO = new Date().toISOString()

  const { data: offeredRaw } = await supabase
    .from('ticket_assignments')
    .select(`
      id, expires_at,
      tickets(
        id, ticket_number, title, original_issue_text,
        location_text, latitude, longitude,
        severity, stage, sub_status
      )
    `)
    .eq('worker_user_id', workerId)
    .eq('is_current', true)
    .eq('status', 'offered')
    .gt('expires_at', nowISO)
    .maybeSingle()

  const { data: activeRaw } = await supabase
    .from('tickets')
    .select(`
      id, ticket_number, title, original_issue_text,
      location_text, severity, stage, sub_status,
      accepted_at, sla_first_contact_due_at, sla_resolution_due_at,
      citizen_id, citizen_identity_revealed_at
    `)
    .eq('owner_user_id', workerId)
    .eq('stage', 'in_progress')
    .neq('sub_status', 'assigned_awaiting_acceptance')
    .order('accepted_at', { ascending: true })

  const revealedCitizenIds = (activeRaw ?? [])
    .filter((t) => t.citizen_id && t.citizen_identity_revealed_at)
    .map((t) => t.citizen_id as string)

  const citizenPhoneMap: Record<string, string | null> = {}
  if (revealedCitizenIds.length > 0) {
    const { data: identities } = await supabase
      .from('citizen_channel_identities')
      .select('citizen_id, phone')
      .in('citizen_id', revealedCitizenIds)
      .not('phone', 'is', null)
    for (const row of identities ?? []) {
      if (!citizenPhoneMap[row.citizen_id]) citizenPhoneMap[row.citizen_id] = row.phone
    }
  }

  const { data: userRow } = await supabase
    .from('users')
    .select('metadata_json')
    .eq('id', workerId)
    .single()

  const ticket = normalizeTicketJoin((offeredRaw as { tickets?: unknown } | null)?.tickets)
  const meta = userRow?.metadata_json as Record<string, unknown> | null

  return {
    offered: offeredRaw
      ? {
          id: offeredRaw.id as string,
          expires_at: offeredRaw.expires_at as string,
          ticket: ticket
            ? {
                id: String(ticket.id),
                ticket_number: String(ticket.ticket_number),
                title: (ticket.title as string | null) ?? null,
                original_issue_text: (ticket.original_issue_text as string | null) ?? null,
                location_text: (ticket.location_text as string | null) ?? null,
                latitude: (ticket.latitude as number | null) ?? null,
                longitude: (ticket.longitude as number | null) ?? null,
                severity: (ticket.severity as string | null) ?? null,
                stage: String(ticket.stage),
                sub_status: String(ticket.sub_status),
              }
            : null,
        }
      : null,
    activeTickets: (activeRaw ?? []).map((t) => ({
      id: t.id as string,
      ticket_number: t.ticket_number as string,
      title: t.title as string | null,
      original_issue_text: t.original_issue_text as string | null,
      location_text: t.location_text as string | null,
      severity: t.severity as string | null,
      stage: t.stage as string,
      sub_status: t.sub_status as string,
      accepted_at: t.accepted_at as string | null,
      sla_first_contact_due_at: t.sla_first_contact_due_at as string | null,
      sla_resolution_due_at: t.sla_resolution_due_at as string | null,
      citizen_phone: t.citizen_id ? (citizenPhoneMap[t.citizen_id as string] ?? null) : null,
    })),
    telegramLinked: typeof meta?.telegram_chat_id === 'number',
  }
}

export async function getCurrentWorkerOffer(workerId: string) {
  if (isPostgresMode()) {
    const nowISO = new Date().toISOString()
    const res = await dbQuery<{
      id: string
      expires_at: string
      ticket_id: string
      ticket_number: string
      title: string | null
      original_issue_text: string | null
      location_text: string | null
      severity: string | null
    }>(
      `SELECT ta.id, ta.expires_at,
              t.id AS ticket_id, t.ticket_number, t.title, t.original_issue_text,
              t.location_text, t.severity
       FROM ticket_assignments ta
       INNER JOIN tickets t ON t.id = ta.ticket_id
       WHERE ta.worker_user_id = $1
         AND ta.is_current = true
         AND ta.status = 'offered'
         AND ta.expires_at > $2
       LIMIT 1`,
      [workerId, nowISO],
    )
    const row = res.rows[0]
    if (!row) return null
    return {
      assignment_id: row.id,
      expires_at: row.expires_at,
      ticket: {
        id: row.ticket_id,
        ticket_number: row.ticket_number,
        title: row.title,
        original_issue_text: row.original_issue_text,
        location_text: row.location_text,
        severity: row.severity,
      },
    }
  }

  const supabase = createSupabaseServiceClient()
  const nowISO = new Date().toISOString()
  const { data } = await supabase
    .from('ticket_assignments')
    .select(`
      id, expires_at,
      tickets(id, ticket_number, title, original_issue_text, location_text, severity)
    `)
    .eq('worker_user_id', workerId)
    .eq('is_current', true)
    .eq('status', 'offered')
    .gt('expires_at', nowISO)
    .maybeSingle()

  if (!data) return null
  const ticket = normalizeTicketJoin((data as { tickets?: unknown }).tickets)
  return {
    assignment_id: data.id as string,
    expires_at: data.expires_at as string,
    ticket: ticket
      ? {
          id: String(ticket.id),
          ticket_number: String(ticket.ticket_number),
          title: (ticket.title as string | null) ?? null,
          original_issue_text: (ticket.original_issue_text as string | null) ?? null,
          location_text: (ticket.location_text as string | null) ?? null,
          severity: (ticket.severity as string | null) ?? null,
        }
      : null,
  }
}
