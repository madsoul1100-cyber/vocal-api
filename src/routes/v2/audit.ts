import { Router } from 'express'
import { requireAuth } from '@/middleware/requireAuth.js'
import { canAccessAudit, listAuditLogs } from '@/services/auditService.js'

const router = Router()

type VocalUser = {
  organization_id: string
  roles?: { name: string } | null
}

router.get('/', requireAuth, async (req, res) => {
  const user = (req as typeof req & { vocalUser: VocalUser }).vocalUser
  if (!canAccessAudit(user.roles?.name)) {
    res.status(403).json({ error: 'Insufficient role' })
    return
  }

  const actor = typeof req.query.actor === 'string' ? req.query.actor : undefined
  const event = typeof req.query.event === 'string' ? req.query.event : undefined
  const page = parseInt(typeof req.query.page === 'string' ? req.query.page : '1', 10)

  const result = await listAuditLogs(user.organization_id, {
    actor,
    event,
    page: Number.isFinite(page) ? page : 1,
  })

  res.json(result)
})

export default router
