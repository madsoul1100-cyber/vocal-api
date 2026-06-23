/**
 * Field intake — staff file a ticket on behalf of a citizen (in person).
 *
 * - POST /tickets/worker-intake (JSON, staff roles) → createWorkerIntakeTicket
 * - POST /worker/tickets (multipart, ground worker) → fileTicketAsWorker
 *
 * Required: name, number, address, description.
 * Optional: geo coordinates, photos.
 * Ticket is linked to a citizen record and queued for central support triage.
 */

import { createSupabaseServiceClient } from '@/lib/supabase.js'
import { canCreateWorkerIntakeTicket } from '@/lib/roleHierarchy.js'
import { uploadWorkerAttachment, validateTicketUploadSize } from '@/services/attachmentService.js'
import { resolveCitizenForWorkerIntake } from '@/services/citizenService.js'
import { enrichTicketFromIssueText } from '@/services/ticketIntakeAi.js'
import { intakeTerritoryAutoAssign } from '@/services/assignmentService.js'
import { addTicketNote, createTicket } from '@/services/ticketService.js'

const PRIVILEGED_INTAKE_ROLES = new Set(['super_admin', 'central_support'])

type VocalUser = {
  id: string
  organization_id: string
  roles?: { name: string } | null
}

export interface WorkerTicketIntakeInput {
  citizen_name: string
  citizen_phone: string
  address: string
  description: string
  latitude?: number
  longitude?: number
  territory_id?: string
  files?: Array<{ buffer: Buffer; originalname: string; mimetype: string }>
}

export interface WorkerTicketIntakeResult {
  ticket_id: string
  ticket_number: string
  stage: string
  sub_status: string
  needs_triage: true
  citizen_id: string
  citizen_verified: boolean
  citizen_is_new: boolean
  attachment_count: number
}

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
      stage: string
      sub_status: string
      needs_triage: true
      citizen_id: string
      citizen_verified: boolean
      citizen_is_new: boolean
      attachment_count: number
    }
  | { ok: false; status: number; error: string }

/** Mirrors createTicket initial stage/sub_status for manual intake responses. */
function initialIntakeTicketStatus(input: WorkerTicketIntakeInput): {
  stage: string
  sub_status: string
} {
  const hasUsableLocation = !!(
    input.address.trim() ||
    (input.latitude != null && input.longitude != null)
  )
  const incompleteInfo = !input.description.trim()
  const sub_status = incompleteInfo
    ? 'incomplete_information'
    : !hasUsableLocation
      ? 'needs_location_validation'
      : 'new_awaiting_triage'
  return { stage: 'to_do', sub_status }
}

function parseCoord(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (raw == null || raw === '') return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}

function parseOptionalCoord(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === '') return null
  const n = typeof raw === 'number' ? raw : parseFloat(String(raw))
  return Number.isFinite(n) ? n : null
}

function parseIntakeFieldsFromBody(body: Record<string, unknown>): WorkerTicketIntakeInput {
  const citizen_name =
    (typeof body.citizen_name === 'string' ? body.citizen_name : typeof body.name === 'string' ? body.name : '')
  const citizen_phone =
    (typeof body.citizen_phone === 'string'
      ? body.citizen_phone
      : typeof body.phone === 'string'
        ? body.phone
        : typeof body.number === 'string'
          ? body.number
          : '')
  const address =
    (typeof body.address === 'string'
      ? body.address
      : typeof body.location_text === 'string'
        ? body.location_text
        : '')
  const description =
    (typeof body.description === 'string'
      ? body.description
      : typeof body.issue_text === 'string'
        ? body.issue_text
        : typeof body.original_issue_text === 'string'
          ? body.original_issue_text
          : '')

  const latitude = parseCoord(body.latitude)
  const longitude = parseCoord(body.longitude)
  const territory_id =
    typeof body.territory_id === 'string' ? body.territory_id.trim() || undefined : undefined

  return {
    citizen_name,
    citizen_phone,
    address,
    description: description.slice(0, 4000),
    latitude,
    longitude,
    territory_id,
  }
}

function validateWorkerIntakeInput(
  input: WorkerTicketIntakeInput,
): { ok: true } | { ok: false; status: number; error: string } {
  if (!input.citizen_name.trim()) {
    return { ok: false, status: 400, error: 'name is required' }
  }
  if (!input.citizen_phone.trim()) {
    return { ok: false, status: 400, error: 'number is required' }
  }
  if (!input.address.trim()) {
    return { ok: false, status: 400, error: 'address is required' }
  }
  if (!input.description.trim()) {
    return { ok: false, status: 400, error: 'description is required' }
  }

  const hasLat = input.latitude != null
  const hasLng = input.longitude != null
  if (hasLat !== hasLng) {
    return { ok: false, status: 400, error: 'latitude and longitude must be provided together' }
  }
  if (hasLat && (input.latitude! < -90 || input.latitude! > 90)) {
    return { ok: false, status: 400, error: 'latitude out of range' }
  }
  if (hasLng && (input.longitude! < -180 || input.longitude! > 180)) {
    return { ok: false, status: 400, error: 'longitude out of range' }
  }

  for (const file of input.files ?? []) {
    const mime = file.mimetype?.trim() || 'application/octet-stream'
    const sizeCheck = validateTicketUploadSize(mime, file.buffer.length)
    if ('error' in sizeCheck) {
      return { ok: false, status: 400, error: sizeCheck.error }
    }
  }

  return { ok: true }
}

/** Normalize JSON body for POST /tickets/worker-intake. */
export function parseWorkerIntakeBody(body: Record<string, unknown>): WorkerTicketIntakeInput {
  return parseIntakeFieldsFromBody(body)
}

/** Parse + validate multipart fields for POST /worker/tickets. */
export function parseWorkerFileTicketBody(body: Record<string, unknown>): {
  ok: true
  fields: Omit<WorkerFileTicketInput, 'organizationId' | 'workerUserId' | 'files'>
} | { ok: false; error: string } {
  const parsed = parseIntakeFieldsFromBody(body)
  const validation = validateWorkerIntakeInput(parsed)
  if (!validation.ok) {
    return { ok: false, error: validation.error }
  }

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
      citizenName: parsed.citizen_name.trim(),
      citizenPhone: parsed.citizen_phone.trim(),
      address: parsed.address.trim(),
      description: parsed.description.trim(),
      latitude,
      longitude,
    },
  }
}

async function loadWorkerTerritoryIds(userId: string): Promise<string[]> {
  const supabase = createSupabaseServiceClient()
  const { data } = await supabase
    .from('user_territories')
    .select('territory_id, is_primary')
    .eq('user_id', userId)

  const rows = data ?? []
  if (rows.length === 0) return []

  const primary = rows.find((r) => r.is_primary === true)
  if (primary?.territory_id) {
    const rest = rows
      .map((r) => r.territory_id as string)
      .filter((id) => id !== primary.territory_id)
    return [primary.territory_id, ...rest]
  }
  return rows.map((r) => r.territory_id as string)
}

async function resolveTerritoryId(
  organizationId: string,
  userId: string,
  roleName: string | null | undefined,
  requestedTerritoryId: string | undefined,
): Promise<{ ok: true; territoryId: string | null } | { ok: false; status: number; error: string }> {
  const workerTerritories = await loadWorkerTerritoryIds(userId)
  const privileged = !!roleName && PRIVILEGED_INTAKE_ROLES.has(roleName)

  if (requestedTerritoryId) {
    const supabase = createSupabaseServiceClient()
    const { data: territory } = await supabase
      .from('territories')
      .select('id')
      .eq('id', requestedTerritoryId)
      .eq('organization_id', organizationId)
      .maybeSingle()

    if (!territory) {
      return { ok: false, status: 400, error: 'Invalid territory for this organization' }
    }

    if (!privileged && workerTerritories.length > 0 && !workerTerritories.includes(requestedTerritoryId)) {
      return { ok: false, status: 403, error: 'Territory is outside your assigned areas' }
    }

    return { ok: true, territoryId: requestedTerritoryId }
  }

  if (workerTerritories.length > 0) {
    return { ok: true, territoryId: workerTerritories[0]! }
  }

  return { ok: true, territoryId: null }
}

function buildCitizenIntakeNote(input: WorkerTicketIntakeInput): string {
  const parts = [
    'Citizen reported in person (field intake).',
    `Name: ${input.citizen_name.trim()}`,
    `Phone: ${input.citizen_phone.trim()}`,
    `Address: ${input.address.trim()}`,
  ]
  if (input.latitude != null && input.longitude != null) {
    parts.push(`Geo: ${input.latitude}, ${input.longitude}`)
  }
  return parts.join(' ')
}

function buildEnrichmentText(input: WorkerTicketIntakeInput): string {
  return [
    input.description.trim(),
    `Citizen name: ${input.citizen_name.trim()}`,
    `Citizen phone: ${input.citizen_phone.trim()}`,
    `Address: ${input.address.trim()}`,
  ].join('\n')
}

async function resolveIntakeCitizen(
  organizationId: string,
  phone: string,
  name: string,
): Promise<
  | { ok: true; citizen: Awaited<ReturnType<typeof resolveCitizenForWorkerIntake>> }
  | { ok: false; status: number; error: string }
> {
  try {
    const citizen = await resolveCitizenForWorkerIntake(organizationId, phone, name)
    return { ok: true, citizen }
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
}

async function uploadIntakeAttachments(
  organizationId: string,
  workerUserId: string,
  ticketId: string,
  files: Array<{ buffer: Buffer; originalname: string; mimetype: string }>,
): Promise<number> {
  const supabase = createSupabaseServiceClient()
  let attachmentCount = 0

  for (const file of files) {
    try {
      const stored = await uploadWorkerAttachment({
        bytes: file.buffer,
        filename: file.originalname,
        mime: file.mimetype,
        org_id: organizationId,
        ticket_id: ticketId,
      })
      if (!stored) continue

      const { error: insErr } = await supabase.from('ticket_attachments').insert({
        ticket_id: ticketId,
        file_name: file.originalname,
        storage_path: stored.storage_path,
        mime_type: stored.mime_type,
        file_size_bytes: stored.size_bytes,
        attachment_type: stored.attachment_type,
        uploaded_by: workerUserId,
      })
      if (!insErr) attachmentCount++
    } catch {
      /* best-effort */
    }
  }

  return attachmentCount
}

type IntakeCoreParams = {
  organizationId: string
  workerUserId: string
  input: WorkerTicketIntakeInput
  territoryId?: string | null
  /** Ground-worker field intake: CS must assign; no territory auto-route to filer. */
  skipTerritoryAutoAssign?: boolean
}

async function runWorkerIntakeCore(
  params: IntakeCoreParams,
): Promise<
  | { ok: true; result: WorkerTicketIntakeResult }
  | { ok: false; status: number; error: string }
> {
  const { organizationId, workerUserId, input } = params
  const description = input.description.trim()
  const address = input.address.trim()

  const citizenRes = await resolveIntakeCitizen(
    organizationId,
    input.citizen_phone.trim(),
    input.citizen_name.trim(),
  )
  if (!citizenRes.ok) return citizenRes
  const { citizen } = citizenRes

  const created = await createTicket({
    organizationId,
    sourceChannel: 'manual',
    citizenId: citizen.citizenId,
    anonymousFlag: false,
    originalIssueText: description,
    locationText: address,
    latitude: input.latitude,
    longitude: input.longitude,
    territoryId: params.territoryId ?? undefined,
    attachmentCount: input.files?.length ?? 0,
    createdBySystem: false,
    createdByUserId: workerUserId,
    stageHistoryReason: 'Ticket filed by worker on behalf of citizen (field intake)',
  })

  if (!created.success || !created.ticketId) {
    return { ok: false, status: 500, error: created.error ?? 'Ticket creation failed' }
  }

  await addTicketNote(created.ticketId, workerUserId, buildCitizenIntakeNote(input), 'general', true)

  const attachmentCount = await uploadIntakeAttachments(
    organizationId,
    workerUserId,
    created.ticketId,
    input.files ?? [],
  )

  const { stage, sub_status } = initialIntakeTicketStatus(input)

  enrichTicketFromIssueText({
    ticketId: created.ticketId,
    organizationId,
    issueText: buildEnrichmentText(input),
    ensureSeverity: true,
  }).catch((err) => {
    console.error('[fileTicketAsWorker] enrichTicketFromIssueText', err)
  })

  const supabase = createSupabaseServiceClient()
  await supabase.from('audit_logs').insert({
    organization_id: organizationId,
    event_type: 'worker_filed_ticket',
    entity_type: 'ticket',
    entity_id: created.ticketId,
    actor_type: 'user',
    actor_user_id: workerUserId,
    new_value_json: {
      ticket_number: created.ticketNumber,
      citizen_id: citizen.citizenId,
      citizen_verified: citizen.verified,
      citizen_is_new: citizen.isNew,
      attachment_count: attachmentCount,
      needs_triage: true,
    },
  })

  if (!params.skipTerritoryAutoAssign) {
    await intakeTerritoryAutoAssign({
      ticketId: created.ticketId,
      ticketNumber: created.ticketNumber,
      organizationId,
      locationText: address,
      issueText: description,
      source: 'manual',
    })
  }

  return {
    ok: true,
    result: {
      ticket_id: created.ticketId,
      ticket_number: created.ticketNumber,
      stage,
      sub_status,
      needs_triage: true,
      citizen_id: citizen.citizenId,
      citizen_verified: citizen.verified,
      citizen_is_new: citizen.isNew,
      attachment_count: attachmentCount,
    },
  }
}

/** JSON intake for staff roles (POST /tickets/worker-intake). */
export async function createWorkerIntakeTicket(
  user: VocalUser,
  input: WorkerTicketIntakeInput,
): Promise<
  | { ok: true; result: WorkerTicketIntakeResult }
  | { ok: false; status: number; error: string }
> {
  const roleName = user.roles?.name
  if (!canCreateWorkerIntakeTicket(roleName)) {
    return { ok: false, status: 403, error: 'Your role cannot create field intake tickets' }
  }

  const validation = validateWorkerIntakeInput(input)
  if (!validation.ok) return validation

  const territoryRes = await resolveTerritoryId(
    user.organization_id,
    user.id,
    roleName,
    input.territory_id,
  )
  if (!territoryRes.ok) return territoryRes

  return runWorkerIntakeCore({
    organizationId: user.organization_id,
    workerUserId: user.id,
    input,
    territoryId: territoryRes.territoryId,
  })
}

/** Multipart intake for ground workers (POST /worker/tickets). */
export async function fileTicketAsWorker(
  input: WorkerFileTicketInput,
): Promise<WorkerFileTicketResult> {
  const intakeInput: WorkerTicketIntakeInput = {
    citizen_name: input.citizenName,
    citizen_phone: input.citizenPhone,
    address: input.address,
    description: input.description,
    latitude: input.latitude ?? undefined,
    longitude: input.longitude ?? undefined,
    files: input.files,
  }

  const validation = validateWorkerIntakeInput(intakeInput)
  if (!validation.ok) {
    return { ok: false, status: validation.status, error: validation.error }
  }

  const core = await runWorkerIntakeCore({
    organizationId: input.organizationId,
    workerUserId: input.workerUserId,
    input: intakeInput,
    territoryId: null,
    skipTerritoryAutoAssign: true,
  })

  if (!core.ok) {
    return { ok: false, status: core.status, error: core.error }
  }

  const r = core.result
  return {
    ok: true,
    ticket_id: r.ticket_id,
    ticket_number: r.ticket_number,
    stage: r.stage,
    sub_status: r.sub_status,
    needs_triage: r.needs_triage,
    citizen_id: r.citizen_id,
    citizen_verified: r.citizen_verified,
    citizen_is_new: r.citizen_is_new,
    attachment_count: r.attachment_count,
  }
}
