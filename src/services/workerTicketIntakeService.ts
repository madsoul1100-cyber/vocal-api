/**
 * Ground worker files a ticket on behalf of a citizen (field intake).
 * No worker auto-offer — ticket stays `needs_triage` for CS approval only.
 */

import { createSupabaseServiceClient } from '@/lib/supabase.js'
import { resolveCitizenForWorkerIntake } from '@/services/citizenService.js'
import { uploadWorkerAttachment } from '@/services/attachmentService.js'
import { enrichTicketFromIssueText } from '@/services/ticketIntakeAi.js'
import { createTicket } from '@/services/ticketService.js'

export interface WorkerFileTicketInput {
  organizationId: string
  workerUserId: string
  citizenName: string
  citizenPhone: string
  address: string
  description: string
  latitude?: number | null
  longitude?: number | null
  files?: Array<{ buffer: Buffer; originalname: string; mimetype: string }>
}

export type WorkerFileTicketResult =
  | {
      ok: true
      ticket_id: string
      ticket_number: string
      needs_triage: true
      citizen_id: string
      citizen_verified: boolean
      citizen_is_new: boolean
      attachment_count: number
    }
  | { ok: false; status: number; error: string }

function parseOptionalCoord(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === '') return null
  const n = typeof raw === 'number' ? raw : parseFloat(String(raw))
  return Number.isFinite(n) ? n : null
}

export function parseWorkerFileTicketBody(body: Record<string, unknown>): {
  ok: true
  fields: Omit<WorkerFileTicketInput, 'organizationId' | 'workerUserId' | 'files'>
} | { ok: false; error: string } {
  const citizenName =
    (typeof body.citizen_name === 'string' && body.citizen_name) ||
    (typeof body.name === 'string' && body.name) ||
    ''
  const citizenPhone =
    (typeof body.citizen_phone === 'string' && body.citizen_phone) ||
    (typeof body.phone === 'string' && body.phone) ||
    (typeof body.number === 'string' && body.number) ||
    ''
  const address =
    (typeof body.address === 'string' && body.address) ||
    (typeof body.location_text === 'string' && body.location_text) ||
    ''
  const description =
    (typeof body.description === 'string' && body.description) ||
    (typeof body.issue_text === 'string' && body.issue_text) ||
    (typeof body.original_issue_text === 'string' && body.original_issue_text) ||
    ''

  if (!citizenName.trim()) return { ok: false, error: 'citizen_name is required' }
  if (!citizenPhone.trim()) return { ok: false, error: 'citizen_phone is required' }
  if (!address.trim()) return { ok: false, error: 'address is required' }
  if (!description.trim()) return { ok: false, error: 'description is required' }

  const latitude = parseOptionalCoord(body.latitude)
  const longitude = parseOptionalCoord(body.longitude)
  if (
    (body.latitude !== undefined && body.latitude !== '' && latitude === null) ||
    (body.longitude !== undefined && body.longitude !== '' && longitude === null)
  ) {
    return { ok: false, error: 'latitude and longitude must be valid numbers when provided' }
  }

  return {
    ok: true,
    fields: {
      citizenName: citizenName.trim(),
      citizenPhone: citizenPhone.trim(),
      address: address.trim(),
      description: description.trim().slice(0, 4000),
      latitude,
      longitude,
    },
  }
}

export async function fileTicketAsWorker(
  input: WorkerFileTicketInput,
): Promise<WorkerFileTicketResult> {
  let citizen: Awaited<ReturnType<typeof resolveCitizenForWorkerIntake>>
  try {
    citizen = await resolveCitizenForWorkerIntake(
      input.organizationId,
      input.citizenPhone,
      input.citizenName,
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg === 'invalid_phone') {
      return { ok: false, status: 400, error: 'Valid citizen phone number is required' }
    }
    if (msg === 'invalid_name') {
      return { ok: false, status: 400, error: 'Citizen name is required' }
    }
    return { ok: false, status: 500, error: msg }
  }

  const result = await createTicket({
    organizationId: input.organizationId,
    sourceChannel: 'manual',
    citizenId: citizen.citizenId,
    anonymousFlag: false,
    originalIssueText: input.description,
    locationText: input.address,
    latitude: input.latitude ?? undefined,
    longitude: input.longitude ?? undefined,
    attachmentCount: input.files?.length ?? 0,
    createdBySystem: false,
    createdByUserId: input.workerUserId,
    stageHistoryReason: 'Ticket filed by ground worker on behalf of citizen',
  })

  if (!result.success) {
    return { ok: false, status: 500, error: result.error ?? 'Ticket create failed' }
  }

  const supabase = createSupabaseServiceClient()
  let attachmentCount = 0

  for (const file of input.files ?? []) {
    try {
      const stored = await uploadWorkerAttachment({
        bytes: file.buffer,
        filename: file.originalname,
        mime: file.mimetype,
        org_id: input.organizationId,
        ticket_id: result.ticketId,
      })
      if (!stored) continue

      const { error: insErr } = await supabase.from('ticket_attachments').insert({
        ticket_id: result.ticketId,
        file_name: file.originalname,
        storage_path: stored.storage_path,
        mime_type: stored.mime_type,
        file_size_bytes: stored.size_bytes,
        attachment_type: stored.attachment_type,
        uploaded_by: input.workerUserId,
      })
      if (!insErr) attachmentCount++
    } catch {
      /* best-effort — ticket still created */
    }
  }

  await enrichTicketFromIssueText({
    ticketId: result.ticketId,
    organizationId: input.organizationId,
    issueText: input.description,
    ensureSeverity: true,
  }).catch((err) => {
    console.error('[fileTicketAsWorker] enrichTicketFromIssueText', err)
  })

  await supabase.from('audit_logs').insert({
    organization_id: input.organizationId,
    event_type: 'worker_filed_ticket',
    entity_type: 'ticket',
    entity_id: result.ticketId,
    actor_type: 'user',
    actor_user_id: input.workerUserId,
    new_value_json: {
      ticket_number: result.ticketNumber,
      citizen_id: citizen.citizenId,
      citizen_verified: citizen.verified,
      citizen_is_new: citizen.isNew,
      attachment_count: attachmentCount,
    },
  })

  return {
    ok: true,
    ticket_id: result.ticketId,
    ticket_number: result.ticketNumber,
    needs_triage: true,
    citizen_id: citizen.citizenId,
    citizen_verified: citizen.verified,
    citizen_is_new: citizen.isNew,
    attachment_count: attachmentCount,
  }
}
