import { Router } from 'express'
import { requireAuth } from '@/middleware/requireAuth.js'
import {
  assertDashboardWebChartAccess,
  DASHBOARD_WEB_DEFAULT_REGION_LIMIT,
  DASHBOARD_WEB_MAX_REGION_LIMIT,
  DASHBOARD_WEB_DEFAULT_SEGMENT_LIMIT,
  DASHBOARD_WEB_MAX_SEGMENT_LIMIT,
  DASHBOARD_WEB_DEFAULT_LEADERBOARD_LIMIT,
  DASHBOARD_WEB_MAX_LEADERBOARD_LIMIT,
  DASHBOARD_WEB_DEFAULT_MONTH_COUNT,
  DASHBOARD_WEB_MAX_MONTH_COUNT,
  resolveDashboardWebChartFilters,
  resolveDashboardWebTerritoryChartFilters,
} from '@/services/dashboardWebFiltersService.js'
import { getTicketCategoryChart } from '@/services/dashboardTicketCategoryChartService.js'
import { getRegionStageChart } from '@/services/dashboardRegionStageChartService.js'
import {
  getWorkerLeaderboard,
  parseWorkerLeaderboardMetric,
} from '@/services/dashboardWorkerLeaderboardService.js'
import { getDashboardWebKpis } from '@/services/dashboardWebKpisService.js'
import { getCategoryMonthlyChart } from '@/services/dashboardCategoryMonthlyChartService.js'
import { getStageMonthlyChart } from '@/services/dashboardStageMonthlyChartService.js'
import { getTerritoryHeatmapChart, resolveDashboardWebHeatmapFilters } from '@/services/dashboardTerritoryHeatmapService.js'

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

/** Ground worker leaderboard — assigned / resolved / pending in territory + date scope. */
router.get('/charts/worker-leaderboard', requireAuth, async (req, res) => {
  const user = vocalUser(req)
  const access = assertDashboardWebChartAccess(user.roles?.name)
  if (!access.ok) {
    res.status(access.status).json({ error: access.error })
    return
  }

  const resolved = await resolveDashboardWebChartFilters(user, req.query as Record<string, unknown>, {
    defaultLimit: DASHBOARD_WEB_DEFAULT_LEADERBOARD_LIMIT,
    maxLimit: DASHBOARD_WEB_MAX_LEADERBOARD_LIMIT,
  })
  if (!resolved.ok) {
    res.status(resolved.status).json({ error: resolved.error })
    return
  }

  const metric = parseWorkerLeaderboardMetric(req.query.metric)

  try {
    const chart = await getWorkerLeaderboard(user.organization_id, resolved.filters, metric)
    res.json(chart)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Chart query failed'
    res.status(500).json({ error: message })
  }
})

/** Stacked bar time series — tickets by top-level category per calendar month (territory only). */
router.get('/charts/tickets-by-category-monthly', requireAuth, async (req, res) => {
  const user = vocalUser(req)
  const access = assertDashboardWebChartAccess(user.roles?.name)
  if (!access.ok) {
    res.status(access.status).json({ error: access.error })
    return
  }

  const resolved = await resolveDashboardWebTerritoryChartFilters(
    user,
    req.query as Record<string, unknown>,
    {
      defaultLimit: DASHBOARD_WEB_DEFAULT_SEGMENT_LIMIT,
      maxLimit: DASHBOARD_WEB_MAX_SEGMENT_LIMIT,
      defaultMonths: DASHBOARD_WEB_DEFAULT_MONTH_COUNT,
      maxMonths: DASHBOARD_WEB_MAX_MONTH_COUNT,
    },
  )
  if (!resolved.ok) {
    res.status(resolved.status).json({ error: resolved.error })
    return
  }

  try {
    const chart = await getCategoryMonthlyChart(user.organization_id, resolved.filters)
    res.json(chart)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Chart query failed'
    res.status(500).json({ error: message })
  }
})

/** Grouped bar time series — tickets by pipeline stage at each month-end snapshot (territory only). */
router.get('/charts/tickets-by-stage-monthly', requireAuth, async (req, res) => {
  const user = vocalUser(req)
  const access = assertDashboardWebChartAccess(user.roles?.name)
  if (!access.ok) {
    res.status(access.status).json({ error: access.error })
    return
  }

  const resolved = await resolveDashboardWebTerritoryChartFilters(
    user,
    req.query as Record<string, unknown>,
    {
      defaultLimit: 4,
      maxLimit: 4,
      defaultMonths: DASHBOARD_WEB_DEFAULT_MONTH_COUNT,
      maxMonths: DASHBOARD_WEB_MAX_MONTH_COUNT,
    },
  )
  if (!resolved.ok) {
    res.status(resolved.status).json({ error: resolved.error })
    return
  }

  try {
    const chart = await getStageMonthlyChart(user.organization_id, resolved.filters)
    res.json(chart)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Chart query failed'
    res.status(500).json({ error: message })
  }
})

/** District heat map — ticket counts per Telangana district (metric + period controls only). */
router.get('/charts/territory-heatmap', requireAuth, async (req, res) => {
  const user = vocalUser(req)
  const access = assertDashboardWebChartAccess(user.roles?.name)
  if (!access.ok) {
    res.status(access.status).json({ error: access.error })
    return
  }

  const resolved = resolveDashboardWebHeatmapFilters(user.roles?.name, req.query as Record<string, unknown>)
  if (!resolved.ok) {
    res.status(resolved.status).json({ error: resolved.error })
    return
  }

  try {
    const chart = await getTerritoryHeatmapChart(user.organization_id, resolved.filters)
    res.json(chart)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Chart query failed'
    res.status(500).json({ error: message })
  }
})

/** KPI row — tickets created/closed, open pipeline, needs action (territory + date scoped). */
router.get('/kpis', requireAuth, async (req, res) => {
  const user = vocalUser(req)
  const access = assertDashboardWebChartAccess(user.roles?.name)
  if (!access.ok) {
    res.status(access.status).json({ error: access.error })
    return
  }

  const resolved = await resolveDashboardWebChartFilters(user, req.query as Record<string, unknown>, {
    defaultLimit: 1,
    maxLimit: 1,
  })
  if (!resolved.ok) {
    res.status(resolved.status).json({ error: resolved.error })
    return
  }

  try {
    const kpis = await getDashboardWebKpis(user.organization_id, resolved.filters)
    res.json(kpis)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'KPI query failed'
    res.status(500).json({ error: message })
  }
})

export default router
