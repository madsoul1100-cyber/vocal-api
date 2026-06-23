/**
 * Assignment service.
 *
 * Core responsibilities:
 *   - findNearestAvailableWorker: pick the closest active ground_worker in
 *     the ticket's territory who hasn't already been offered this ticket.
 *   - offerTicketToWorker: write a ticket_assignments row + ticket state
 *     change + stage history + audit log. Honors org's acceptance_sla_minutes.
 *   - expireStaleAssignments: called by the cron — flips expired offers,
 *     invokes reoffer logic up to max_assignment_attempts times, else
 *     bounces back to triage as sla_breach_escalation_queue.
 *
 * All writes use the service role client; access control is the caller's
 * job (cron has no user context).
 */

import { createSupabaseServiceClient } from '@/lib/supabase.js'
import { isPostgresMode, dbQuery } from '@/lib/db.js'
import {
  buildTerritoryAncestorChain,
  loadTerritoryParentMap,
  workerTerritoryCoversTicket,
} from '@/services/territoryService.js'
import { resolveAndApplyTicketTerritory } from '@/services/territoryResolveService.js'
import {  applyDevOfferWorkerPin,
  isDevOfferWorkerPinEnabled,
  resolveDevPinnedWorkerId,
} from '@/lib/devOfferWorker.js'
import { assertTicketReadyForWorkerAssignment, TRIAGE_REQUIRED_ERROR } from './ticketTriageService.js'
import { notifyCitizenOfTicketUpdate } from './citizenNotifier'
import {
  notifyWorkerOfAssignment,
  notifyWorkerOfDirectAssignment,
  notifyWorkerOfReassignment,
} from './workerNotifier'

const GROUND_WORKER_ROLE_ID = '00000000-0000-0000-0000-000000000005'

const WORKER_FILED_TICKET_EVENT = 'worker_filed_ticket'

/** Ground worker who filed this ticket on behalf of a citizen (null if not worker-filed). */
export async function resolveWorkerFiledByUserId(ticketId: string): Promise<string | null> {
  if (isPostgresMode()) {
    const res = await dbQuery<{ actor_user_id: string | null }>(
      `SELECT actor_user_id FROM audit_logs
       WHERE entity_type = 'ticket' AND entity_id = $1 AND event_type = $2
       ORDER BY created_at ASC
       LIMIT 1`,
      [ticketId, WORKER_FILED_TICKET_EVENT],
    )
    return res.rows[0]?.actor_user_id ?? null
  }

  const supabase = createSupabaseServiceClient()
  const { data } = await supabase
    .from('audit_logs')
    .select('actor_user_id')
    .eq('entity_type', 'ticket')
    .eq('entity_id', ticketId)
    .eq('event_type', WORKER_FILED_TICKET_EVENT)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  return (data?.actor_user_id as string | null) ?? null
}

// ---------------------------------------------------------------------------
// Geo helpers
// ---------------------------------------------------------------------------
function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371
  const dLat = (b.lat - a.lat) * Math.PI / 180
  const dLng = (b.lng - a.lng) * Math.PI / 180
  const sa =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(sa)))
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CandidateWorker {
  id: string
  full_name: string
  distance_km: number | null
  active_ticket_count: number
}

export interface TerritoryOwnerMatch {
  worker: CandidateWorker
  matchedTerritoryId: string
}

export type TerritoryAutoAssignResult =
  | { routed: 'direct'; workerId: string; matchedTerritoryId: string }
  | { routed: 'none'; reason: 'no_territory' | 'no_worker' | 'assign_failed' }

function pickNextWorkerRoundRobin(sortedWorkerIds: string[], lastWorkerId: string | null): string {
  if (sortedWorkerIds.length === 0) {
    throw new Error('pickNextWorkerRoundRobin: empty worker list')
  }
  if (sortedWorkerIds.length === 1) return sortedWorkerIds[0]!
  if (!lastWorkerId || !sortedWorkerIds.includes(lastWorkerId)) return sortedWorkerIds[0]!
  const idx = sortedWorkerIds.indexOf(lastWorkerId)
  return sortedWorkerIds[(idx + 1) % sortedWorkerIds.length]!
}

async function getTerritoryAssignmentCursor(
  organizationId: string,
  territoryId: string,
): Promise<string | null> {
  if (isPostgresMode()) {
    const res = await dbQuery<{ last_worker_id: string | null }>(
      `SELECT last_worker_id FROM territory_assignment_cursors
       WHERE organization_id = $1 AND territory_id = $2`,
      [organizationId, territoryId],
    )
    return res.rows[0]?.last_worker_id ?? null
  }

  const supabase = createSupabaseServiceClient()
  const { data } = await supabase
    .from('territory_assignment_cursors')
    .select('last_worker_id')
    .eq('organization_id', organizationId)
    .eq('territory_id', territoryId)
    .maybeSingle()
  return (data?.last_worker_id as string | null) ?? null
}

export async function advanceTerritoryRoundRobinCursor(
  organizationId: string,
  territoryId: string,
  workerId: string,
): Promise<void> {
  if (isPostgresMode()) {
    await dbQuery(
      `INSERT INTO territory_assignment_cursors (organization_id, territory_id, last_worker_id, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (organization_id, territory_id)
       DO UPDATE SET last_worker_id = EXCLUDED.last_worker_id, updated_at = now()`,
      [organizationId, territoryId, workerId],
    )
    return
  }

  const supabase = createSupabaseServiceClient()
  await supabase.from('territory_assignment_cursors').upsert({
    organization_id: organizationId,
    territory_id: territoryId,
    last_worker_id: workerId,
    updated_at: new Date().toISOString(),
  })
}

/**
 * Return all eligible ground workers for a ticket, ranked by:
 *   1. Active ticket count ASC  (load balancing — lighter load first)
 *   2. Distance to ticket ASC   (proximity — nearer first)
 *
 * Territory matching: if the ticket has a territory_id, we first try workers
 * in that territory. If NONE are available (all excluded or none assigned),
 * we fall back to ALL active ground workers in the org so the ticket never
 * gets stuck. Workers already in `ticket.offered_worker_ids` are excluded.
 */
export async function listCandidateWorkers(ticketId: string): Promise<CandidateWorker[]> {
  const supabase = createSupabaseServiceClient()

  const { data: ticket } = await supabase
    .from('tickets')
    .select('id, organization_id, territory_id, latitude, longitude, offered_worker_ids')
    .eq('id', ticketId)
    .single()
  if (!ticket) return []

  const excluded = new Set<string>((ticket.offered_worker_ids as string[] | null) ?? [])
  const filedByWorkerId = await resolveWorkerFiledByUserId(ticketId)
  if (filedByWorkerId) excluded.add(filedByWorkerId)

  // Fetch all active ground workers in the org with their territory memberships.
  const { data: workers } = await supabase
    .from('users')
    .select(`
      id, full_name,
      user_territories(
        territory_id,
        territories(id, centroid_lat, centroid_lng)
      )
    `)
    .eq('organization_id', ticket.organization_id)
    .eq('role_id', GROUND_WORKER_ROLE_ID)
    .eq('active', true)

  if (!workers) return []

  // Count active (non-closed) tickets per worker for load balancing.
  const { data: activeCounts } = await supabase
    .from('tickets')
    .select('owner_user_id')
    .eq('organization_id', ticket.organization_id)
    .neq('stage', 'closed')
    .not('owner_user_id', 'is', null)

  const loadMap = new Map<string, number>()
  for (const t of activeCounts ?? []) {
    if (t.owner_user_id) loadMap.set(t.owner_user_id, (loadMap.get(t.owner_user_id) ?? 0) + 1)
  }

  const ticketLat = ticket.latitude
  const ticketLng = ticket.longitude
  const hasCoords = ticketLat != null && ticketLng != null

  function buildCandidate(w: any): CandidateWorker {
    const territories = (w.user_territories ?? []) as Array<{
      territory_id: string
      territories: { centroid_lat: number | null; centroid_lng: number | null } | null
    }>
    let distance: number | null = null
    if (hasCoords && ticketLat != null && ticketLng != null) {
      const coords = territories
        .map(t => t.territories)
        .filter(t => t?.centroid_lat != null && t?.centroid_lng != null) as Array<{ centroid_lat: number; centroid_lng: number }>
      if (coords.length) {
        distance = Math.min(...coords.map(c =>
          haversineKm(
            { lat: ticketLat, lng: ticketLng },
            { lat: c.centroid_lat, lng: c.centroid_lng },
          )
        ))
      }
    }
    return {
      id: w.id,
      full_name: w.full_name,
      distance_km: distance,
      active_ticket_count: loadMap.get(w.id) ?? 0,
    }
  }

  if (isDevOfferWorkerPinEnabled()) {
    const pinId = await resolveDevPinnedWorkerId(ticket.organization_id)
    if (pinId) {
      const pinned = (workers as { id: string }[]).find((w) => w.id === pinId)
      if (pinned) return [buildCandidate(pinned)]
      return []
    }
  }

  function sortCandidates(list: CandidateWorker[]): CandidateWorker[] {
    return list.sort((a, b) => {
      // Primary: fewer active tickets first (load balance)
      if (a.active_ticket_count !== b.active_ticket_count)
        return a.active_ticket_count - b.active_ticket_count
      // Secondary: nearer first; nulls last
      if (a.distance_km == null && b.distance_km == null) return 0
      if (a.distance_km == null) return 1
      if (b.distance_km == null) return -1
      return a.distance_km - b.distance_km
    })
  }

  // First pass — territory-scoped (worker's territory is ticket node or an ancestor)
  if (ticket.territory_id) {
    const parentOf = await loadTerritoryParentMap(ticket.organization_id)
    const territoryCandidates: CandidateWorker[] = []
    for (const w of workers as any[]) {
      if (excluded.has(w.id)) continue
      const territories = (w.user_territories ?? []) as Array<{ territory_id: string }>
      const workerTerritoryIds = territories.map((t) => t.territory_id)
      if (
        !workerTerritoryCoversTicket(
          workerTerritoryIds,
          ticket.territory_id as string,
          parentOf,
        )
      ) {
        continue
      }
      territoryCandidates.push(buildCandidate(w))
    }
    if (territoryCandidates.length > 0) return sortCandidates(territoryCandidates)
    // Fall through → org-wide fallback below
  }

  // Org-wide fallback — try everyone who hasn't been offered yet
  const allCandidates: CandidateWorker[] = []
  for (const w of workers as any[]) {
    if (excluded.has(w.id)) continue
    allCandidates.push(buildCandidate(w))
  }
  return sortCandidates(allCandidates)
}

/**
 * Find the single nearest eligible worker (or null if none).
 */
export async function findNearestAvailableWorker(ticketId: string): Promise<CandidateWorker | null> {
  const list = await listCandidateWorkers(ticketId)
  return list[0] ?? null
}

/**
 * Resolve the worker mapped to the ticket's territory hierarchy.
 *
 * Walks from the ticket's territory up through parents (ward → mandal → district → …).
 * At each level, finds workers whose user_territories row matches that exact node.
 * When multiple workers share a level, round-robin picks the next worker in rotation.
 */
export async function findTerritoryOwner(ticketId: string): Promise<TerritoryOwnerMatch | null> {
  const supabase = createSupabaseServiceClient()

  const { data: ticket } = await supabase
    .from('tickets')
    .select('id, organization_id, territory_id, offered_worker_ids')
    .eq('id', ticketId)
    .single()
  if (!ticket || !ticket.territory_id) return null

  const parentOf = await loadTerritoryParentMap(ticket.organization_id)
  const chain = buildTerritoryAncestorChain(ticket.territory_id as string, parentOf)

  const excluded = new Set<string>((ticket.offered_worker_ids as string[] | null) ?? [])
  const filedByWorkerId = await resolveWorkerFiledByUserId(ticketId)
  if (filedByWorkerId) excluded.add(filedByWorkerId)

  const { data: workers } = await supabase
    .from('users')
    .select(`id, full_name, user_territories(territory_id)`)
    .eq('organization_id', ticket.organization_id)
    .eq('role_id', GROUND_WORKER_ROLE_ID)
    .eq('active', true)
  if (!workers || workers.length === 0) return null

  if (isDevOfferWorkerPinEnabled()) {
    const pinId = await resolveDevPinnedWorkerId(ticket.organization_id)
    if (pinId) {
      const pinned = (workers as { id: string; full_name: string }[]).find((w) => w.id === pinId)
      if (pinned) {
        return {
          worker: {
            id: pinned.id,
            full_name: pinned.full_name,
            distance_km: null,
            active_ticket_count: 0,
          },
          matchedTerritoryId: ticket.territory_id as string,
        }
      }
      return null
    }
  }

  for (const territoryId of chain) {
    const matches: CandidateWorker[] = []
    for (const w of workers as Array<{ id: string; full_name: string; user_territories?: Array<{ territory_id: string }> | null }>) {
      if (excluded.has(w.id)) continue
      const memberships = w.user_territories ?? []
      if (!memberships.some((m) => m.territory_id === territoryId)) continue
      matches.push({
        id: w.id,
        full_name: w.full_name,
        distance_km: null,
        active_ticket_count: 0,
      })
    }
    if (matches.length > 0) {
      const sortedIds = matches.map((m) => m.id).sort()
      const lastId = await getTerritoryAssignmentCursor(ticket.organization_id, territoryId)
      const pickedId = pickNextWorkerRoundRobin(sortedIds, lastId)
      const picked = matches.find((m) => m.id === pickedId)!
      return { worker: picked, matchedTerritoryId: territoryId }
    }
  }

  return null
}

/**
 * Read acceptance SLA (minutes) from organization_settings. Falls back to 2
 * for testing if no row is found.
 */
export async function getAcceptanceSlaMinutes(organizationId: string): Promise<number> {
  const supabase = createSupabaseServiceClient()
  const { data } = await supabase
    .from('organization_settings')
    .select('acceptance_sla_minutes')
    .eq('organization_id', organizationId)
    .maybeSingle()
  return data?.acceptance_sla_minutes ?? 2
}

/**
 * Create a new "offered" assignment for this worker and update the ticket.
 * Marks any previous is_current=true assignments on this ticket as not
 * current. Does NOT change stage if the ticket is already in_progress
 * from a prior acceptance (safety guard — reoffer only happens after
 * the prior offer expired without acceptance).
 */
export async function offerTicketToWorker(args: {
  ticketId: string
  workerId: string
  assignedByUserId?: string | null
  reason?: string
  /**
   * WhatsApp intake: nearest-worker offer while ticket remains in CS triage
   * (`needs_triage` stays true). CS manual assign still requires triage complete.
   */
  parallelWithTriage?: boolean
}): Promise<{ ok: true; assignmentId: string; expiresAt: string } | { ok: false; error: string }> {
  const supabase = createSupabaseServiceClient()

  const { data: ticket } = await supabase
    .from('tickets')
    .select(
      'id, organization_id, stage, sub_status, needs_triage, offered_worker_ids, assignment_attempt_count',
    )
    .eq('id', args.ticketId)
    .single()
  if (!ticket) return { ok: false, error: 'ticket_not_found' }

  const triageCheck = await assertTicketReadyForWorkerAssignment(args.ticketId)
  if (!triageCheck.ok && !args.parallelWithTriage) {
    return { ok: false, error: TRIAGE_REQUIRED_ERROR }
  }

  const workerId = await applyDevOfferWorkerPin({
    ticketId: args.ticketId,
    workerId: args.workerId,
    organizationId: ticket.organization_id,
  })

  const slaMinutes = await getAcceptanceSlaMinutes(ticket.organization_id)
  const now = new Date()
  const expiresAt = new Date(now.getTime() + slaMinutes * 60 * 1000).toISOString()

  // Expire any stale current offers on this ticket.
  await supabase
    .from('ticket_assignments')
    .update({ is_current: false })
    .eq('ticket_id', args.ticketId)
    .eq('is_current', true)

  const { data: assignment, error } = await supabase
    .from('ticket_assignments')
    .insert({
      ticket_id: args.ticketId,
      worker_user_id: workerId,
      assigned_by: args.assignedByUserId ?? null,
      status: 'offered',
      expires_at: expiresAt,
      offered_at: now.toISOString(),
      is_current: true,
    })
    .select('id')
    .single()

  if (error || !assignment) return { ok: false, error: error?.message ?? 'insert_failed' }

  const offeredList = new Set<string>(((ticket.offered_worker_ids as string[] | null) ?? []))
  offeredList.add(workerId)

  const ticketPatch: Record<string, unknown> = {
    owner_user_id: workerId,
    stage: 'in_progress',
    sub_status: 'assigned_awaiting_acceptance',
    assignment_attempt_count: ((ticket as any).assignment_attempt_count ?? 0) + 1,
    offered_worker_ids: Array.from(offeredList),
    updated_at: now.toISOString(),
  }
  if (!args.parallelWithTriage) {
    ticketPatch.needs_triage = false
  }

  await supabase.from('tickets').update(ticketPatch).eq('id', args.ticketId)

  await supabase.from('ticket_stage_history').insert({
    ticket_id: args.ticketId,
    from_stage: ticket.stage,
    to_stage: 'in_progress',
    from_sub_status: ticket.sub_status,
    to_sub_status: 'assigned_awaiting_acceptance',
    changed_by: args.assignedByUserId ?? null,
    change_reason:
      args.reason ??
      (args.parallelWithTriage
        ? `Parallel intake offer (${slaMinutes}m acceptance window; CS triage continues)`
        : `Offered to worker (${slaMinutes}m acceptance window)`),
    system_action: !args.assignedByUserId,
  })

  await supabase.from('audit_logs').insert({
    organization_id: ticket.organization_id,
    event_type: 'ticket_offered_to_worker',
    entity_type: 'ticket',
    entity_id: args.ticketId,
    actor_type: args.assignedByUserId ? 'user' : 'system',
    actor_user_id: args.assignedByUserId ?? null,
    new_value_json: {
      worker_id: workerId,
      assignment_id: assignment.id,
      expires_at: expiresAt,
      sla_minutes: slaMinutes,
    },
  })

  // Citizen notification is non-critical — fire-and-forget is fine here.
  notifyCitizenOfTicketUpdate({
    ticketId: args.ticketId,
    prevSubStatus: ticket.sub_status as any,
    newSubStatus: 'assigned_awaiting_acceptance',
    newStage: 'in_progress',
    workerUserId: workerId,
    key: 'assigned_awaiting_acceptance',
  }).catch(() => {})

  // CRITICAL: await the worker notification so serverless functions don't
  // terminate the in-flight Telegram POST when the parent function returns.
  // notifyWorkerOfAssignment swallows its own errors, so awaiting is safe.
  await notifyWorkerOfAssignment(args.ticketId, workerId)

  return { ok: true, assignmentId: assignment.id, expiresAt }
}

/**
 * Directly assign a ticket to a worker WITHOUT an acceptance step.
 *
 * Unlike offerTicketToWorker (which creates an "offered" assignment the worker
 * must accept before the acceptance SLA expires), this immediately makes the
 * worker the owner and moves the ticket into the accepted/in-progress state.
 * This is used when a worker definitively owns the ticket's territory, so the
 * ticket should land straight in their queue.
 */
export async function directAssignTicketToWorker(args: {
  ticketId: string
  workerId: string
  assignedByUserId?: string | null
  reason?: string
  /** Intake: assign while CS triage continues (`needs_triage` stays true). */
  parallelWithTriage?: boolean
  matchedTerritoryId?: string | null
}): Promise<{ ok: true; assignmentId: string } | { ok: false; error: string }> {
  const supabase = createSupabaseServiceClient()

  const { data: ticket } = await supabase
    .from('tickets')
    .select('id, organization_id, stage, sub_status, anonymous_flag, citizen_id, offered_worker_ids, assignment_attempt_count')
    .eq('id', args.ticketId)
    .single()
  if (!ticket) return { ok: false, error: 'ticket_not_found' }

  if (!args.parallelWithTriage) {
    const triageCheck = await assertTicketReadyForWorkerAssignment(args.ticketId)
    if (!triageCheck.ok) return { ok: false, error: TRIAGE_REQUIRED_ERROR }
  }

  const now = new Date()
  const nowIso = now.toISOString()

  const { data: settings } = await supabase
    .from('organization_settings')
    .select('first_contact_sla_hours, resolution_plan_sla_hours')
    .eq('organization_id', ticket.organization_id)
    .maybeSingle()
  const firstContactHours = (settings as { first_contact_sla_hours?: number } | null)?.first_contact_sla_hours ?? 1
  const resolutionHours = (settings as { resolution_plan_sla_hours?: number } | null)?.resolution_plan_sla_hours ?? 24
  const slaFirstContactDueAt = new Date(now.getTime() + firstContactHours * 60 * 60 * 1000).toISOString()
  const slaResolutionDueAt = new Date(now.getTime() + resolutionHours * 60 * 60 * 1000).toISOString()

  // Retire any current offer/assignment on this ticket.
  await supabase
    .from('ticket_assignments')
    .update({ is_current: false })
    .eq('ticket_id', args.ticketId)
    .eq('is_current', true)

  const { data: assignment, error } = await supabase
    .from('ticket_assignments')
    .insert({
      ticket_id: args.ticketId,
      worker_user_id: args.workerId,
      assigned_by: args.assignedByUserId ?? null,
      status: 'force_assigned',
      offered_at: nowIso,
      responded_at: nowIso,
      is_current: true,
    })
    .select('id')
    .single()
  if (error || !assignment) return { ok: false, error: error?.message ?? 'insert_failed' }

  const offeredList = new Set<string>(((ticket.offered_worker_ids as string[] | null) ?? []))
  offeredList.add(args.workerId)

  const ticketPatch: Record<string, unknown> = {
    owner_user_id: args.workerId,
    stage: 'in_progress',
    sub_status: 'accepted_by_worker',
    accepted_at: nowIso,
    sla_first_contact_due_at: slaFirstContactDueAt,
    sla_resolution_due_at: slaResolutionDueAt,
    sla_breached_flag: false,
    assignment_attempt_count: ((ticket as { assignment_attempt_count?: number }).assignment_attempt_count ?? 0) + 1,
    offered_worker_ids: Array.from(offeredList),
    last_updated_by_user_id: args.assignedByUserId ?? null,
    updated_at: nowIso,
  }
  if (!args.parallelWithTriage) {
    ticketPatch.needs_triage = false
  }

  await supabase.from('tickets').update(ticketPatch).eq('id', args.ticketId)

  await supabase.from('ticket_stage_history').insert({
    ticket_id: args.ticketId,
    from_stage: ticket.stage,
    to_stage: 'in_progress',
    from_sub_status: ticket.sub_status,
    to_sub_status: 'accepted_by_worker',
    changed_by: args.assignedByUserId ?? null,
    change_reason: args.reason ?? 'Auto-assigned to territory owner',
    system_action: !args.assignedByUserId,
  })

  await supabase.from('audit_logs').insert({
    organization_id: ticket.organization_id,
    event_type: 'ticket_auto_assigned_to_territory_owner',
    entity_type: 'ticket',
    entity_id: args.ticketId,
    actor_type: args.assignedByUserId ? 'user' : 'system',
    actor_user_id: args.assignedByUserId ?? null,
    new_value_json: { worker_id: args.workerId, assignment_id: assignment.id },
    metadata_json: args.matchedTerritoryId
      ? { territory_id: args.matchedTerritoryId }
      : null,
  })

  notifyCitizenOfTicketUpdate({
    ticketId: args.ticketId,
    prevSubStatus: ticket.sub_status as any,
    newSubStatus: 'accepted_by_worker',
    newStage: 'in_progress',
    workerUserId: args.workerId,
    key: 'accepted_by_worker',
  }).catch(() => {})

  // Await so serverless functions don't kill the in-flight worker notification.
  await notifyWorkerOfDirectAssignment(args.ticketId, args.workerId)

  return { ok: true, assignmentId: assignment.id }
}

/**
 * Territory-hierarchy auto-assign: resolve territory (if needed), walk up the
 * tree, round-robin among workers at the closest matching level, direct-assign.
 */
export async function autoAssignTicketByTerritory(
  ticketId: string,
  opts?: {
    parallelWithTriage?: boolean
    resolveTerritory?: boolean
    locationText?: string | null
    issueText?: string | null
    organizationId?: string
  },
): Promise<TerritoryAutoAssignResult> {
  const supabase = createSupabaseServiceClient()
  const { data: ticketRow } = await supabase
    .from('tickets')
    .select('organization_id, territory_id, location_text, original_issue_text')
    .eq('id', ticketId)
    .maybeSingle()

  if (!ticketRow) return { routed: 'none', reason: 'assign_failed' }

  const organizationId = opts?.organizationId ?? (ticketRow.organization_id as string)
  const locationText = opts?.locationText ?? (ticketRow.location_text as string | null)
  const issueText = opts?.issueText ?? (ticketRow.original_issue_text as string | null)

  if (opts?.resolveTerritory !== false) {
    const shouldResolve =
      !ticketRow.territory_id || !!(locationText?.trim() || issueText?.trim())
    if (shouldResolve) {
      await resolveAndApplyTicketTerritory({
        ticketId,
        organizationId,
        locationText,
        issueText,
        force: !!(locationText?.trim() || issueText?.trim()),
      })
    }
  }

  if (!opts?.parallelWithTriage) {
    const triageCheck = await assertTicketReadyForWorkerAssignment(ticketId)
    if (!triageCheck.ok) return { routed: 'none', reason: 'assign_failed' }
  }

  const match = await findTerritoryOwner(ticketId)
  if (!match) {
    const { data: refreshed } = await supabase
      .from('tickets')
      .select('territory_id')
      .eq('id', ticketId)
      .maybeSingle()
    return {
      routed: 'none',
      reason: refreshed?.territory_id ? 'no_worker' : 'no_territory',
    }
  }

  const res = await directAssignTicketToWorker({
    ticketId,
    workerId: match.worker.id,
    assignedByUserId: null,
    reason: opts?.parallelWithTriage
      ? 'Auto-assigned to territory worker at intake (CS triage continues)'
      : 'Auto-assigned to territory worker',
    parallelWithTriage: opts?.parallelWithTriage,
    matchedTerritoryId: match.matchedTerritoryId,
  })

  if (!res.ok) return { routed: 'none', reason: 'assign_failed' }

  await advanceTerritoryRoundRobinCursor(organizationId, match.matchedTerritoryId, match.worker.id)

  return {
    routed: 'direct',
    workerId: match.worker.id,
    matchedTerritoryId: match.matchedTerritoryId,
  }
}

/** Called from WhatsApp, Telegram, and manual intake after ticket creation. */
export async function intakeTerritoryAutoAssign(args: {
  ticketId: string
  ticketNumber?: string
  organizationId: string
  locationText?: string | null
  issueText?: string | null
  source: string
}): Promise<TerritoryAutoAssignResult> {
  console.log('[territoryAssign] start', {
    ticketId: args.ticketId,
    ticketNumber: args.ticketNumber,
    source: args.source,
  })

  try {
    const result = await autoAssignTicketByTerritory(args.ticketId, {
      parallelWithTriage: true,
      resolveTerritory: true,
      organizationId: args.organizationId,
      locationText: args.locationText,
      issueText: args.issueText,
    })

    if (result.routed === 'direct') {
      console.log('[territoryAssign] assigned', {
        ticketId: args.ticketId,
        ticketNumber: args.ticketNumber,
        source: args.source,
        workerId: result.workerId,
        matchedTerritoryId: result.matchedTerritoryId,
      })
    } else {
      console.log('[territoryAssign] skipped', {
        ticketId: args.ticketId,
        ticketNumber: args.ticketNumber,
        source: args.source,
        reason: result.reason,
      })
    }

    return result
  } catch (err) {
    console.error('[territoryAssign] error', {
      ticketId: args.ticketId,
      ticketNumber: args.ticketNumber,
      source: args.source,
      error: err instanceof Error ? err.message : String(err),
    })
    return { routed: 'none', reason: 'assign_failed' }
  }
}

/** Post-triage territory auto-assign (CS flows, confirm-ai hook). */
export async function autoRouteNewTicket(ticketId: string): Promise<
  | { routed: 'direct'; workerId: string }
  | { routed: 'none' }
> {
  const result = await autoAssignTicketByTerritory(ticketId, { parallelWithTriage: false })
  if (result.routed === 'direct') {
    return { routed: 'direct', workerId: result.workerId }
  }
  return { routed: 'none' }
}

/**
 * The cron-tick worker.
 *
 * 1. Find ticket_assignments where status='offered' AND is_current=true AND
 *    expires_at < now. For each:
 *      - mark the assignment as expired
 *      - look up max_assignment_attempts for the org
 *      - if attempts_remaining > 0, find the next nearest worker and offer
 *      - else bounce the ticket to 'sla_breach_escalation_queue' and flag
 *        the ticket as sla_breached_flag=true
 * 2. Also: find tickets with sla_first_contact_due_at < now where
 *    sla_breached_flag=false → set flag + audit log. Same for
 *    sla_resolution_due_at.
 */
export async function expireStaleAssignments(): Promise<{
  expired: number
  reoffered: number
  escalated: number
  sla_breached: number
}> {
  const supabase = createSupabaseServiceClient()
  const nowIso = new Date().toISOString()

  let expired = 0
  let reoffered = 0
  let escalated = 0
  let sla_breached = 0

  const { data: stale } = await supabase
    .from('ticket_assignments')
    .select('id, ticket_id, worker_user_id, expires_at')
    .eq('status', 'offered')
    .eq('is_current', true)
    .lt('expires_at', nowIso)

  for (const a of (stale ?? [])) {
    expired++
    await supabase
      .from('ticket_assignments')
      .update({ status: 'expired', responded_at: nowIso, is_current: false })
      .eq('id', a.id)

    const { data: ticket } = await supabase
      .from('tickets')
      .select(
        'id, ticket_number, organization_id, stage, sub_status, assignment_attempt_count, needs_triage, source_channel',
      )
      .eq('id', a.ticket_id)
      .single()
    if (!ticket) continue
    if (ticket.needs_triage === true) {
      const parallelWhatsAppOffer =
        ticket.source_channel === 'whatsapp' &&
        ticket.sub_status === 'assigned_awaiting_acceptance'
      if (!parallelWhatsAppOffer) continue
    }

    // Tell the worker whose offer just expired that the ticket has moved on,
    // so their stale Accept/Reject buttons in Telegram aren't a black hole.
    // Awaited so the serverless function doesn't terminate the in-flight POST.
    if (a.worker_user_id) {
      await notifyWorkerOfReassignment(a.worker_user_id, ticket.ticket_number)
    }

    const { data: settings } = await supabase
      .from('organization_settings')
      .select('max_assignment_attempts')
      .eq('organization_id', ticket.organization_id)
      .maybeSingle()
    const maxAttempts = settings?.max_assignment_attempts ?? 3

    if ((ticket.assignment_attempt_count ?? 0) >= maxAttempts) {
      // Bounce to escalation queue
      await supabase
        .from('tickets')
        .update({
          stage: 'on_hold',
          sub_status: 'sla_breach_escalation_queue',
          sla_breached_flag: true,
          needs_triage: true,
          updated_at: nowIso,
        })
        .eq('id', ticket.id)

      await supabase.from('ticket_stage_history').insert({
        ticket_id: ticket.id,
        from_stage: ticket.stage,
        to_stage: 'on_hold',
        from_sub_status: ticket.sub_status,
        to_sub_status: 'sla_breach_escalation_queue',
        change_reason: `Exhausted ${maxAttempts} worker offers without acceptance`,
        system_action: true,
      })

      await supabase.from('audit_logs').insert({
        organization_id: ticket.organization_id,
        event_type: 'ticket_escalated_no_acceptance',
        entity_type: 'ticket',
        entity_id: ticket.id,
        actor_type: 'system',
        metadata_json: { max_attempts: maxAttempts, last_worker: a.worker_user_id },
      })
      escalated++
      continue
    }

    const next = await findNearestAvailableWorker(ticket.id)
    if (!next) {
      await supabase
        .from('tickets')
        .update({
          stage: 'on_hold',
          sub_status: 'sla_breach_escalation_queue',
          sla_breached_flag: true,
          needs_triage: true,
          updated_at: nowIso,
        })
        .eq('id', ticket.id)
      await supabase.from('audit_logs').insert({
        organization_id: ticket.organization_id,
        event_type: 'ticket_no_candidate_worker',
        entity_type: 'ticket',
        entity_id: ticket.id,
        actor_type: 'system',
      })
      escalated++
      continue
    }

    const result = await offerTicketToWorker({
      ticketId: ticket.id,
      workerId: next.id,
      assignedByUserId: null,
      reason: 'Auto re-offer after prior offer expired',
      parallelWithTriage:
        ticket.needs_triage === true && ticket.source_channel === 'whatsapp',
    })
    if (result.ok) reoffered++
  }

  // SLA breach scan — first-contact + resolution.
  const { data: breaches } = await supabase
    .from('tickets')
    .select('id, organization_id, sla_first_contact_due_at, sla_resolution_due_at, first_contacted_at, closed_at')
    .eq('sla_breached_flag', false)
    .or(`sla_first_contact_due_at.lt.${nowIso},sla_resolution_due_at.lt.${nowIso}`)

  for (const t of (breaches ?? [])) {
    const firstContactBreached =
      t.sla_first_contact_due_at && new Date(t.sla_first_contact_due_at) < new Date(nowIso) && !t.first_contacted_at
    const resolutionBreached =
      t.sla_resolution_due_at && new Date(t.sla_resolution_due_at) < new Date(nowIso) && !t.closed_at
    if (!firstContactBreached && !resolutionBreached) continue

    await supabase.from('tickets').update({ sla_breached_flag: true, updated_at: nowIso }).eq('id', t.id)
    await supabase.from('audit_logs').insert({
      organization_id: t.organization_id,
      event_type: 'ticket_sla_breached',
      entity_type: 'ticket',
      entity_id: t.id,
      actor_type: 'system',
      metadata_json: { first_contact: firstContactBreached, resolution: resolutionBreached },
    })
    sla_breached++
  }

  return { expired, reoffered, escalated, sla_breached }
}
