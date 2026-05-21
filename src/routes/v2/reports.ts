import { Router } from 'express'
import { requireAuth } from '@/middleware/requireAuth.js'
import { canAccessReports, getReportsSummary } from '@/services/reportsService.js'

const router = Router()

type VocalUser = {
  organization_id: string
  roles?: { name: string } | null
}

router.get('/', requireAuth, async (req, res) => {
  const user = (req as typeof req & { vocalUser: VocalUser }).vocalUser
  if (!canAccessReports(user.roles?.name)) {
    res.status(403).json({ error: 'Insufficient role' })
    return
  }

  const summary = await getReportsSummary(user.organization_id)
  res.json(summary)
})

export default router
