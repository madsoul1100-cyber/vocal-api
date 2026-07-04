import { Router } from 'express'
import { requireAuth } from '@/middleware/requireAuth.js'
import {
  assertDashboardWebChartAccess,
  resolveDashboardWebChartFilters,
} from '@/services/dashboardWebFiltersService.js'
import { getTicketCategoryChart } from '@/services/dashboardTicketCategoryChartService.js'

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

  const resolved = await resolveDashboardWebChartFilters(user, req.query as Record<string, unknown>)
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

export default router
