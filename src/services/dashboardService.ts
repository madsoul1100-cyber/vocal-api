import { createSupabaseServiceClient } from '@/lib/supabase.js'
import { isPostgresMode, dbQuery } from '@/lib/db.js'
import type { TicketStage } from '@/types/database.js'

export const DASHBOARD_ROLES = ['super_admin', 'central_support', 'state_leader'] as const

/** Client-side redirect when role cannot access the dashboard page. */
export const DASHBOARD_ROLE_REDIRECTS: Record<string, string> = {
  ground_worker: '/my-assignments',
  district_leader: '/tickets',
}

export function canAccessDashboard(role: string | null | undefined): boolean {
  return !!role && (DASHBOARD_ROLES as readonly string[]).includes(role)
}

export function dashboardRedirectForRole(role: string | null | undefined): string | null {
  if (!role) return null
  return DASHBOARD_ROLE_REDIRECTS[role] ?? null
}

export interface DashboardCountLink {
  count: number
  href: string
}

export interface DashboardPipeline {
  total: number
  in_progress: number
  on_hold: number
  closed: number
  stage_counts: Record<TicketStage, number>
  stage_links: Record<TicketStage, string>
}

export interface DashboardOperationalHealth {
  avg_first_contact_minutes: number | null
  closed_this_week: number
  closed_wow_percent: number | null
  active_workers: { with_open_tickets: number; total_ground_workers: number }
  pending_offers: number
}

export interface DashboardRecentTicket {
  id: string
  ticket_number: string
  title: string | null
  stage: TicketStage
  severity: string | null
  created_at: string
  href: string
}

export interface DashboardStats {
  action_required: {
    awaiting_triage: DashboardCountLink
    pending_closure_review: DashboardCountLink
    critical_open: DashboardCountLink
    sla_breaches: DashboardCountLink
  }
  pipeline: DashboardPipeline
  operational_health: DashboardOperationalHealth
  recent_tickets: DashboardRecentTicket[]
  meta: {
    organization_id: string
    generated_at: string
  }
}

const STAGES: TicketStage[] = ['to_do', 'in_progress', 'on_hold', 'closed']

const STAGE_LINKS: Record<TicketStage, string> = {
  to_do: '/tickets?stage=to_do',
  in_progress: '/tickets?stage=in_progress',
  on_hold: '/tickets?stage=on_hold',
  closed: '/tickets?stage=closed',
}

function emptyStageCounts(): Record<TicketStage, number> {
  return { to_do: 0, in_progress: 0, on_hold: 0, closed: 0 }
}

function buildStageCounts(rows: Array<{ stage: string; c: number }>): Record<TicketStage, number> {
  const counts = emptyStageCounts()
  for (const row of rows) {
    const stage = row.stage as TicketStage
    if (STAGES.includes(stage)) counts[stage] = row.c
  }
  return counts
}

function pipelineFromStageCounts(stage_counts: Record<TicketStage, number>): DashboardPipeline {
  const total = STAGES.reduce((sum, s) => sum + stage_counts[s], 0)
  return {
    total,
    in_progress: stage_counts.in_progress,
    on_hold: stage_counts.on_hold,
    closed: stage_counts.closed,
    stage_counts,
    stage_links: STAGE_LINKS,
  }
}

function wowPercent(thisWeek: number, priorWeek: number): number | null {
  if (priorWeek === 0) return thisWeek > 0 ? 100 : null
  return Math.round(((thisWeek - priorWeek) / priorWeek) * 1000) / 10
}

function roundMinutes(value: number | null): number | null {
  if (value == null || Number.isNaN(value)) return null
  return Math.round(value)
}

export async function getDashboardStats(orgId: string): Promise<DashboardStats> {
  if (isPostgresMode()) return getDashboardStatsPg(orgId)
  return getDashboardStatsSupabase(orgId)
}

async function getDashboardStatsPg(orgId: string): Promise<DashboardStats> {
  const base = 'organization_id = $1'
  const [
    triageRes,
    closureReviewRes,
    criticalRes,
    slaBreachRes,
    stageRes,
    avgContactRes,
    closedWeekRes,
    closedPriorRes,
    activeOwnersRes,
    groundWorkersRes,
    pendingOffersRes,
    recentRes,
  ] = await Promise.all([
    dbQuery<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM tickets WHERE ${base} AND needs_triage = true`,
      [orgId],
    ),
    dbQuery<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM tickets WHERE ${base} AND needs_closure_review = true`,
      [orgId],
    ),
    dbQuery<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM tickets WHERE ${base} AND critical_flag = true AND stage <> 'closed'`,
      [orgId],
    ),
    dbQuery<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM tickets WHERE ${base} AND sub_status = 'sla_breach_escalation_queue'`,
      [orgId],
    ),
    dbQuery<{ stage: string; c: string }>(
      `SELECT stage, COUNT(*)::text AS c FROM tickets WHERE ${base} GROUP BY stage`,
      [orgId],
    ),
    dbQuery<{ avg_minutes: string | null }>(
      `SELECT AVG(EXTRACT(EPOCH FROM (accepted_at - created_at)) / 60.0)::text AS avg_minutes
       FROM tickets
       WHERE ${base}
         AND accepted_at IS NOT NULL
         AND accepted_at >= now() - interval '30 days'`,
      [orgId],
    ),
    dbQuery<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM tickets
       WHERE ${base} AND stage = 'closed' AND updated_at >= now() - interval '7 days'`,
      [orgId],
    ),
    dbQuery<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM tickets
       WHERE ${base}
         AND stage = 'closed'
         AND updated_at >= now() - interval '14 days'
         AND updated_at < now() - interval '7 days'`,
      [orgId],
    ),
    dbQuery<{ c: string }>(
      `SELECT COUNT(DISTINCT owner_user_id)::text AS c FROM tickets
       WHERE ${base} AND stage <> 'closed' AND owner_user_id IS NOT NULL`,
      [orgId],
    ),
    dbQuery<{ c: string }>(
      `SELECT COUNT(*)::text AS c
       FROM users u
       INNER JOIN roles r ON r.id = u.role_id
       WHERE u.organization_id = $1 AND u.active = true AND r.name = 'ground_worker'`,
      [orgId],
    ),
    dbQuery<{ c: string }>(
      `SELECT COUNT(*)::text AS c
       FROM ticket_assignments ta
       INNER JOIN tickets t ON t.id = ta.ticket_id
       WHERE t.organization_id = $1 AND ta.status = 'offered' AND ta.is_current = true`,
      [orgId],
    ),
    dbQuery<{
      id: string
      ticket_number: string
      title: string | null
      stage: TicketStage
      severity: string | null
      created_at: string
    }>(
      `SELECT id, ticket_number, title, stage, severity, created_at
       FROM tickets WHERE ${base}
       ORDER BY created_at DESC
       LIMIT 6`,
      [orgId],
    ),
  ])

  const stage_counts = buildStageCounts(
    stageRes.rows.map((r) => ({ stage: r.stage, c: Number(r.c) })),
  )
  const closedThisWeek = Number(closedWeekRes.rows[0]?.c ?? 0)
  const closedPriorWeek = Number(closedPriorRes.rows[0]?.c ?? 0)

  return assembleDashboard(orgId, {
    awaitingTriage: Number(triageRes.rows[0]?.c ?? 0),
    pendingClosureReview: Number(closureReviewRes.rows[0]?.c ?? 0),
    criticalOpen: Number(criticalRes.rows[0]?.c ?? 0),
    slaBreaches: Number(slaBreachRes.rows[0]?.c ?? 0),
    pipeline: pipelineFromStageCounts(stage_counts),
    avgFirstContactMinutes: roundMinutes(
      avgContactRes.rows[0]?.avg_minutes != null
        ? Number(avgContactRes.rows[0].avg_minutes)
        : null,
    ),
    closedThisWeek,
    closedWowPercent: wowPercent(closedThisWeek, closedPriorWeek),
    activeWorkersWithOpen: Number(activeOwnersRes.rows[0]?.c ?? 0),
    totalGroundWorkers: Number(groundWorkersRes.rows[0]?.c ?? 0),
    pendingOffers: Number(pendingOffersRes.rows[0]?.c ?? 0),
    recentRows: recentRes.rows,
  })
}

async function getDashboardStatsSupabase(orgId: string): Promise<DashboardStats> {
  const supabase = createSupabaseServiceClient()
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString()

  const [
    triageRes,
    closureReviewRes,
    criticalRes,
    slaBreachRes,
    stageRowsRes,
    avgContactRes,
    closedWeekRes,
    closedPriorRes,
    openOwnersRes,
    groundWorkersRes,
    pendingOffersRes,
    recentRes,
  ] = await Promise.all([
    supabase
      .from('tickets')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .eq('needs_triage', true),
    supabase
      .from('tickets')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .eq('needs_closure_review', true),
    supabase
      .from('tickets')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .eq('critical_flag', true)
      .neq('stage', 'closed'),
    supabase
      .from('tickets')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .eq('sub_status', 'sla_breach_escalation_queue'),
    supabase.from('tickets').select('stage').eq('organization_id', orgId),
    supabase
      .from('tickets')
      .select('accepted_at, created_at')
      .eq('organization_id', orgId)
      .not('accepted_at', 'is', null)
      .gte('accepted_at', thirtyDaysAgo)
      .limit(5000),
    supabase
      .from('tickets')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .eq('stage', 'closed')
      .gte('updated_at', sevenDaysAgo),
    supabase
      .from('tickets')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .eq('stage', 'closed')
      .gte('updated_at', fourteenDaysAgo)
      .lt('updated_at', sevenDaysAgo),
    supabase
      .from('tickets')
      .select('owner_user_id')
      .eq('organization_id', orgId)
      .neq('stage', 'closed')
      .not('owner_user_id', 'is', null),
    supabase
      .from('users')
      .select('id, roles!inner(name)', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .eq('active', true)
      .eq('roles.name', 'ground_worker'),
    supabase
      .from('ticket_assignments')
      .select('id, tickets!inner(organization_id)', { count: 'exact', head: true })
      .eq('status', 'offered')
      .eq('is_current', true)
      .eq('tickets.organization_id', orgId),
    supabase
      .from('tickets')
      .select('id, ticket_number, title, stage, severity, created_at')
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false })
      .limit(6),
  ])

  const stageCountsMap: Record<string, number> = {}
  for (const row of stageRowsRes.data ?? []) {
    const stage = String(row.stage)
    stageCountsMap[stage] = (stageCountsMap[stage] ?? 0) + 1
  }
  const stage_counts = buildStageCounts(
    Object.entries(stageCountsMap).map(([stage, c]) => ({ stage, c })),
  )

  let avgMinutes: number | null = null
  const contactRows = avgContactRes.data ?? []
  if (contactRows.length > 0) {
    let sum = 0
    let n = 0
    for (const row of contactRows) {
      const accepted = row.accepted_at ? new Date(row.accepted_at as string).getTime() : NaN
      const created = row.created_at ? new Date(row.created_at as string).getTime() : NaN
      if (!Number.isNaN(accepted) && !Number.isNaN(created)) {
        sum += (accepted - created) / 60_000
        n++
      }
    }
    avgMinutes = n > 0 ? roundMinutes(sum / n) : null
  }

  const ownerIds = new Set(
    (openOwnersRes.data ?? []).map((r) => r.owner_user_id as string).filter(Boolean),
  )

  const closedThisWeek = closedWeekRes.count ?? 0
  const closedPriorWeek = closedPriorRes.count ?? 0

  return assembleDashboard(orgId, {
    awaitingTriage: triageRes.count ?? 0,
    pendingClosureReview: closureReviewRes.count ?? 0,
    criticalOpen: criticalRes.count ?? 0,
    slaBreaches: slaBreachRes.count ?? 0,
    pipeline: pipelineFromStageCounts(stage_counts),
    avgFirstContactMinutes: avgMinutes,
    closedThisWeek,
    closedWowPercent: wowPercent(closedThisWeek, closedPriorWeek),
    activeWorkersWithOpen: ownerIds.size,
    totalGroundWorkers: groundWorkersRes.count ?? 0,
    pendingOffers: pendingOffersRes.count ?? 0,
    recentRows: (recentRes.data ?? []) as Array<{
      id: string
      ticket_number: string
      title: string | null
      stage: TicketStage
      severity: string | null
      created_at: string
    }>,
  })
}

function assembleDashboard(
  orgId: string,
  data: {
    awaitingTriage: number
    pendingClosureReview: number
    criticalOpen: number
    slaBreaches: number
    pipeline: DashboardPipeline
    avgFirstContactMinutes: number | null
    closedThisWeek: number
    closedWowPercent: number | null
    activeWorkersWithOpen: number
    totalGroundWorkers: number
    pendingOffers: number
    recentRows: Array<{
      id: string
      ticket_number: string
      title: string | null
      stage: TicketStage
      severity: string | null
      created_at: string
    }>
  },
): DashboardStats {
  return {
    action_required: {
      awaiting_triage: { count: data.awaitingTriage, href: '/triage' },
      pending_closure_review: {
        count: data.pendingClosureReview,
        href: '/tickets?needs_closure_review=true',
      },
      critical_open: { count: data.criticalOpen, href: '/tickets?severity=critical' },
      sla_breaches: { count: data.slaBreaches, href: '/tickets?stage=on_hold' },
    },
    pipeline: data.pipeline,
    operational_health: {
      avg_first_contact_minutes: data.avgFirstContactMinutes,
      closed_this_week: data.closedThisWeek,
      closed_wow_percent: data.closedWowPercent,
      active_workers: {
        with_open_tickets: data.activeWorkersWithOpen,
        total_ground_workers: data.totalGroundWorkers,
      },
      pending_offers: data.pendingOffers,
    },
    recent_tickets: data.recentRows.map((row) => ({
      id: row.id,
      ticket_number: row.ticket_number,
      title: row.title,
      stage: row.stage,
      severity: row.severity,
      created_at: row.created_at,
      href: `/tickets/${row.id}`,
    })),
    meta: {
      organization_id: orgId,
      generated_at: new Date().toISOString(),
    },
  }
}
