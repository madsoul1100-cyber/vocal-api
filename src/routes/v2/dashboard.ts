import { Router } from 'express'
import { requireClerkAuth } from '@/middleware/clerkAuth.js'
import {
  canAccessDashboard,
  dashboardRedirectForRole,
  getDashboardStats,
} from '@/services/dashboardService.js'

const router = Router()

type VocalUser = {
  organization_id: string
  roles?: { name: string } | null
}

router.get('/', requireClerkAuth, async (req, res) => {
  const user = (req as typeof req & { vocalUser: VocalUser }).vocalUser
  const role = user.roles?.name

  if (!canAccessDashboard(role)) {
    const redirect = dashboardRedirectForRole(role)
    res.status(403).json({
      error: 'Forbidden',
      ...(redirect ? { redirect } : {}),
    })
    return
  }

  const stats = await getDashboardStats(user.organization_id)
  res.json(stats)
})

export default router
