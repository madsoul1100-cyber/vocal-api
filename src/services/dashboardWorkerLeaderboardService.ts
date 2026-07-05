/**
 * Ground worker leaderboard for the web leadership dashboard.
 *
 * - **assigned**: distinct tickets created in range + territory where the worker was
 *   accepted/force-assigned and COALESCE(responded_at, offered_at) falls in [from, to].
 * - **resolved**: tickets created in range + territory, closed in [from, to], owner at close.
 * - **pending**: open tickets currently owned by worker (snapshot), territory scoped only.
 */

import { createSupabaseServiceClient } from '@/lib/supabase.js'
import { isPostgresMode, dbQuery } from '@/lib/db.js'
import {
  buildDashboardWebMeta,
  buildDashboardWebTerritorySqlClause,
  type ResolvedDashboardWebFilters,
} from '@/services/dashboardWebFiltersService.js'

export type WorkerLeaderboardMetric = 'overall' | 'assigned' | 'resolved' | 'pending'

export interface WorkerLeaderboardEntry {
  worker_id: string
  name: string
  avatar_url: string | null
  assigned: number
  resolved: number
  pending: number
}

export interface WorkerLeaderboardResponse {
  chart_type: 'leaderboard'
  metric: WorkerLeaderboardMetric
  title: string
  entries: WorkerLeaderboardEntry[]
  meta: ReturnType<typeof buildDashboardWebMeta>
}

export function parseWorkerLeaderboardMetric(raw: unknown): WorkerLeaderboardMetric {
  const s = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (s === 'assigned' || s === 'resolved' || s === 'pending') return s
  return 'overall'
}

function sortOrderSql(metric: WorkerLeaderboardMetric): string {
  switch (metric) {
    case 'assigned':
      return 'assigned DESC, resolved DESC, pending ASC, u.full_name ASC'
    case 'resolved':
      return 'resolved DESC, assigned DESC, pending ASC, u.full_name ASC'
    case 'pending':
      return 'pending DESC, resolved DESC, assigned DESC, u.full_name ASC'
    default:
      return 'resolved DESC, assigned DESC, pending ASC, u.full_name ASC'
  }
}

async function loadLeaderboardPg(
  orgId: string,
  resolved: ResolvedDashboardWebFilters,
  metric: WorkerLeaderboardMetric,
): Promise<WorkerLeaderboardEntry[]> {
  const { dateRange } = resolved
  const fromIso = dateRange.createdFrom.toISOString()
  const toIso = dateRange.createdTo.toISOString()

  const territory = buildDashboardWebTerritorySqlClause(resolved, 't', 4)
  if (territory.clause === 'FALSE') {
    return []
  }

  const params: unknown[] = [orgId, fromIso, toIso, ...territory.params, resolved.segmentLimit]
  const limitParam = `$${params.length}`

  const res = await dbQuery<{
    worker_id: string
    full_name: string
    image_url: string | null
    assigned: string
    resolved: string
    pending: string
  }>(
    `WITH scoped_tickets AS (
       SELECT t.id, t.owner_user_id, t.stage, t.closed_at
       FROM tickets t
       WHERE t.organization_id = $1
         AND t.created_at >= $2
         AND t.created_at <= $3
         AND ${territory.clause}
     ),
     assigned_counts AS (
       SELECT ta.worker_user_id, COUNT(DISTINCT ta.ticket_id)::int AS assigned
       FROM ticket_assignments ta
       INNER JOIN scoped_tickets st ON st.id = ta.ticket_id
       WHERE ta.status IN ('accepted', 'force_assigned')
         AND COALESCE(ta.responded_at, ta.offered_at) >= $2
         AND COALESCE(ta.responded_at, ta.offered_at) <= $3
       GROUP BY ta.worker_user_id
     ),
     resolved_counts AS (
       SELECT st.owner_user_id AS worker_user_id, COUNT(*)::int AS resolved
       FROM scoped_tickets st
       WHERE st.stage = 'closed'
         AND st.owner_user_id IS NOT NULL
         AND st.closed_at IS NOT NULL
         AND st.closed_at >= $2
         AND st.closed_at <= $3
       GROUP BY st.owner_user_id
     ),
     pending_counts AS (
       SELECT t.owner_user_id AS worker_user_id, COUNT(*)::int AS pending
       FROM tickets t
       WHERE t.organization_id = $1
         AND t.stage <> 'closed'
         AND t.owner_user_id IS NOT NULL
         AND ${territory.clause}
       GROUP BY t.owner_user_id
     )
     SELECT
       u.id AS worker_id,
       u.full_name,
       u.image_url,
       COALESCE(a.assigned, 0)::text AS assigned,
       COALESCE(r.resolved, 0)::text AS resolved,
       COALESCE(p.pending, 0)::text AS pending
     FROM users u
     INNER JOIN roles ro ON ro.id = u.role_id AND ro.name = 'ground_worker'
     LEFT JOIN assigned_counts a ON a.worker_user_id = u.id
     LEFT JOIN resolved_counts r ON r.worker_user_id = u.id
     LEFT JOIN pending_counts p ON p.worker_user_id = u.id
     WHERE u.organization_id = $1
       AND u.active = true
       AND (
         COALESCE(a.assigned, 0) > 0
         OR COALESCE(r.resolved, 0) > 0
         OR COALESCE(p.pending, 0) > 0
       )
     ORDER BY ${sortOrderSql(metric)}
     LIMIT ${limitParam}`,
    params,
  )

  return res.rows.map((row) => ({
    worker_id: row.worker_id,
    name: row.full_name,
    avatar_url: row.image_url,
    assigned: Number(row.assigned),
    resolved: Number(row.resolved),
    pending: Number(row.pending),
  }))
}

function ticketMatchesTerritory(
  territoryId: string | null,
  resolved: ResolvedDashboardWebFilters,
): boolean {
  const { territoryIds, includeNullTerritory } = resolved
  if (territoryIds.length === 0 && !includeNullTerritory) return false
  if (territoryId == null) return includeNullTerritory
  return territoryIds.includes(territoryId)
}

async function loadLeaderboardSupabase(
  orgId: string,
  resolved: ResolvedDashboardWebFilters,
  metric: WorkerLeaderboardMetric,
): Promise<WorkerLeaderboardEntry[]> {
  const { dateRange } = resolved
  const supabase = createSupabaseServiceClient()

  const { data: workers } = await supabase
    .from('users')
    .select('id, full_name, image_url, roles!inner(name)')
    .eq('organization_id', orgId)
    .eq('active', true)
    .eq('roles.name', 'ground_worker')

  const { data: periodTickets } = await supabase
    .from('tickets')
    .select('id, owner_user_id, stage, closed_at, territory_id, created_at')
    .eq('organization_id', orgId)
    .gte('created_at', dateRange.createdFrom.toISOString())
    .lte('created_at', dateRange.createdTo.toISOString())

  const scopedTicketIds = new Set(
    (periodTickets ?? [])
      .filter((t) => ticketMatchesTerritory(t.territory_id as string | null, resolved))
      .map((t) => t.id as string),
  )

  const { data: assignments } = await supabase
    .from('ticket_assignments')
    .select('ticket_id, worker_user_id, status, responded_at, offered_at')
    .in('status', ['accepted', 'force_assigned'])

  const assignedByWorker = new Map<string, Set<string>>()
  for (const row of assignments ?? []) {
    if (!scopedTicketIds.has(row.ticket_id as string)) continue
    const at = (row.responded_at ?? row.offered_at) as string | null
    if (!at) continue
    const ts = new Date(at).getTime()
    if (ts < dateRange.createdFrom.getTime() || ts > dateRange.createdTo.getTime()) continue
    const wid = row.worker_user_id as string
    if (!assignedByWorker.has(wid)) assignedByWorker.set(wid, new Set())
    assignedByWorker.get(wid)!.add(row.ticket_id as string)
  }

  const resolvedByWorker = new Map<string, number>()
  for (const t of periodTickets ?? []) {
    if (!scopedTicketIds.has(t.id as string)) continue
    if (t.stage !== 'closed' || !t.owner_user_id || !t.closed_at) continue
    const closedAt = new Date(t.closed_at as string).getTime()
    if (closedAt < dateRange.createdFrom.getTime() || closedAt > dateRange.createdTo.getTime()) {
      continue
    }
    const wid = t.owner_user_id as string
    resolvedByWorker.set(wid, (resolvedByWorker.get(wid) ?? 0) + 1)
  }

  const { data: openTickets } = await supabase
    .from('tickets')
    .select('owner_user_id, territory_id, stage')
    .eq('organization_id', orgId)
    .neq('stage', 'closed')
    .not('owner_user_id', 'is', null)

  const pendingByWorker = new Map<string, number>()
  for (const t of openTickets ?? []) {
    if (!ticketMatchesTerritory(t.territory_id as string | null, resolved)) continue
    const wid = t.owner_user_id as string
    pendingByWorker.set(wid, (pendingByWorker.get(wid) ?? 0) + 1)
  }

  const entries: WorkerLeaderboardEntry[] = (workers ?? []).map((w) => {
    const id = w.id as string
    return {
      worker_id: id,
      name: w.full_name as string,
      avatar_url: (w.image_url as string | null) ?? null,
      assigned: assignedByWorker.get(id)?.size ?? 0,
      resolved: resolvedByWorker.get(id) ?? 0,
      pending: pendingByWorker.get(id) ?? 0,
    }
  }).filter((e) => e.assigned > 0 || e.resolved > 0 || e.pending > 0)

  entries.sort((a, b) => {
    if (metric === 'assigned') {
      return b.assigned - a.assigned || b.resolved - a.resolved || a.pending - b.pending
    }
    if (metric === 'resolved') {
      return b.resolved - a.resolved || b.assigned - a.assigned || a.pending - b.pending
    }
    if (metric === 'pending') {
      return b.pending - a.pending || b.resolved - a.resolved || b.assigned - a.assigned
    }
    return (
      b.resolved - a.resolved ||
      b.assigned - a.assigned ||
      a.pending - b.pending ||
      a.name.localeCompare(b.name)
    )
  })

  return entries.slice(0, resolved.segmentLimit)
}

export async function getWorkerLeaderboard(
  orgId: string,
  resolved: ResolvedDashboardWebFilters,
  metric: WorkerLeaderboardMetric,
): Promise<WorkerLeaderboardResponse> {
  const entries = isPostgresMode()
    ? await loadLeaderboardPg(orgId, resolved, metric)
    : await loadLeaderboardSupabase(orgId, resolved, metric)

  return {
    chart_type: 'leaderboard',
    metric,
    title: 'Ground worker leaderboard',
    entries,
    meta: buildDashboardWebMeta(orgId, resolved, { metric }),
  }
}
