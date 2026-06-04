/**
 * Field intake — staff file a ticket on behalf of a citizen who approached them
 * in person. The ticket is created with source_channel=manual and assigned
 * directly to the worker who created it (no offer / accept step).
 */

import { createSupabaseServiceClient } from '@/lib/supabase.js'
import { canCreateWorkerIntakeTicket } from '@/lib/roleHierarchy.js'
import { directAssignTicketToWorker } from '@/services/assignmentService.js'
import { enrichTicketFromIssueText } from '@/services/ticketIntakeAi.js'
import { addTicketNote, createTicket } from '@/services/ticketService.js'

const PRIVILEGED_INTAKE_ROLES = new Set(['super_admin', 'central_support'])

type VocalUser = {
  id: string
  organization_id: string
  roles?: { name: string } | null
}

export interface WorkerTicketIntakeInput {
  /** Citizen full name (required). */
  citizen_name: string
  /** Citizen contact number (required). */
  citizen_phone: string
  /** Postal / locality address (required). */
  address: string
  /** Problem description (required). */
  description: string
  latitude?: number
  longitude?: number
  territory_id?: string
}

function parseCoord(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (raw == null || raw === '') return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}

/** Normalize and validate intake payload from JSON body. */
export function parseWorkerIntakeBody(body: Record<string, unknown>): WorkerTicketIntakeInput {
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
        : '')

  const latitude = parseCoord(body.latitude)
  const longitude = parseCoord(body.longitude)
  const territory_id =
    typeof body.territory_id === 'string' ? body.territory_id.trim() || undefined : undefined

  return {
    citizen_name,
    citizen_phone,
    address,
    description,
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

  return { ok: true }
}

export interface WorkerTicketIntakeResult {
  ticket_id: string
  ticket_number: string
  assignment_id: string
  stage: string
  sub_status: string
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

  const description = input.description.trim()
  const address = input.address.trim()

  const territoryRes = await resolveTerritoryId(
    user.organization_id,
    user.id,
    roleName,
    input.territory_id,
  )
  if (!territoryRes.ok) return territoryRes

  const created = await createTicket({
    organizationId: user.organization_id,
    sourceChannel: 'manual',
    originalIssueText: description,
    locationText: address,
    latitude: input.latitude,
    longitude: input.longitude,
    territoryId: territoryRes.territoryId ?? undefined,
    createdBySystem: false,
    createdByUserId: user.id,
  })

  if (!created.success || !created.ticketId) {
    return { ok: false, status: 500, error: created.error ?? 'Ticket creation failed' }
  }

  await addTicketNote(created.ticketId, user.id, buildCitizenIntakeNote(input), 'general', true)

  const assign = await directAssignTicketToWorker({
    ticketId: created.ticketId,
    workerId: user.id,
    assignedByUserId: user.id,
    reason: 'Self-assigned — ticket created by worker at field intake',
  })

  if (!assign.ok) {
    return {
      ok: false,
      status: 500,
      error: assign.error ?? 'Ticket created but assignment failed',
    }
  }

  enrichTicketFromIssueText({
    ticketId: created.ticketId,
    organizationId: user.organization_id,
    issueText: buildEnrichmentText(input),
  }).catch(() => {})

  return {
    ok: true,
    result: {
      ticket_id: created.ticketId,
      ticket_number: created.ticketNumber,
      assignment_id: assign.assignmentId,
      stage: 'in_progress',
      sub_status: 'accepted_by_worker',
    },
  }
}
