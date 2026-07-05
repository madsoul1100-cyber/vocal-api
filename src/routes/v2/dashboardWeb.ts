import { Router } from 'express'
import { requireAuth } from '@/middleware/requireAuth.js'
import {
  assertDashboardWebChartAccess,
  DASHBOARD_WEB_DEFAULT_REGION_LIMIT,
  DASHBOARD_WEB_MAX_REGION_LIMIT,
  DASHBOARD_WEB_DEFAULT_SEGMENT_LIMIT,
  DASHBOARD_WEB_MAX_SEGMENT_LIMIT,
  resolveDashboardWebChartFilters,
} from '@/services/dashboardWebFiltersService.js'
import { getTicketCategoryChart } from '@/services/dashboardTicketCategoryChartService.js'
import { getRegionStageChart } from '@/services/dashboardRegionStageChartService.js'

const router = Router()

type VocalUser = {
  id: string
  organization_id: string
  roles?: { name: string } | null
}

function vocalUser(req: Parameters<typeof requireAuth>[0]): VocalUser {
  return (req as typeof req & { vocalUser: VocalUser }).vocalUser
}

/** Donut chart — tickets grouped by top-level category (created in date range, territory scoped). */
router.get('/charts/ticket-categories', requireAuth, async (req, res) => {
  const user = vocalUser(req)
  const access = assertDashboardWebChartAccess(user.roles?.name)
  if (!access.ok) {
    res.status(access.status).json({ error: access.error })
    return
  }

  const resolved = await resolveDashboardWebChartFilters(user, req.query as Record<string, unknown>, {
    defaultLimit: DASHBOARD_WEB_DEFAULT_SEGMENT_LIMIT,
    maxLimit: DASHBOARD_WEB_MAX_SEGMENT_LIMIT,
  })
  if (!resolved.ok) {
    res.status(resolved.status).json({ error: resolved.error })
    return
  }

  try {
    const chart = await getTicketCategoryChart(user.organization_id, resolved.filters)
    res.json(chart)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Chart query failed'
    res.status(500).json({ error: message })
  }
})

/** Stacked bar — top territories by ticket count, stacked by current stage. */
router.get('/charts/tickets-by-region-stage', requireAuth, async (req, res) => {
  const user = vocalUser(req)
  const access = assertDashboardWebChartAccess(user.roles?.name)
  if (!access.ok) {
    res.status(access.status).json({ error: access.error })
    return
  }

  const resolved = await resolveDashboardWebChartFilters(user, req.query as Record<string, unknown>, {
    defaultLimit: DASHBOARD_WEB_DEFAULT_REGION_LIMIT,
    maxLimit: DASHBOARD_WEB_MAX_REGION_LIMIT,
  })
  if (!resolved.ok) {
    res.status(resolved.status).json({ error: resolved.error })
    return
  }

  try {
    const chart = await getRegionStageChart(user.organization_id, resolved.filters)
    res.json(chart)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Chart query failed'
    res.status(500).json({ error: message })
  }
})

export default router
