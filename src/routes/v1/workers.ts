import { Router } from 'express'
import { requireAuth } from '@/middleware/requireAuth.js'
import {
  canAccessWorkersPage,
  createOrgUser,
  deactivateOrgUser,
  getOrgUserById,
  getWorkersPageData,
  processActivationRequest,
  updateOrgUser,
} from '@/services/workersManagementService.js'

const router = Router()

type VocalUser = {
  id: string
  organization_id: string
  roles?: { name: string } | null
}

router.get('/', requireAuth, async (req, res) => {
  const user = (req as typeof req & { vocalUser: VocalUser }).vocalUser
  if (!canAccessWorkersPage(user.roles?.name)) {
    res.status(403).json({ error: 'Insufficient role' })
    return
  }

  const { workers, pending, territories, roles } = await getWorkersPageData(user.organization_id)
  const activeCount = workers.filter((w) => w.active).length

  res.json({
    workers,
    pending,
    territories,
    roles,
    activeCount,
    inactiveCount: workers.length - activeCount,
  })
})

router.post('/', requireAuth, async (req, res) => {
  const user = (req as typeof req & { vocalUser: VocalUser }).vocalUser
  const result = await createOrgUser(user, req.body ?? {})
  if (!result.ok) {
    res.status(result.status).json({ error: result.error })
    return
  }
  res.json({ ok: true, id: result.id })
})

router.post('/activation/:id', requireAuth, async (req, res) => {
  const user = (req as typeof req & { vocalUser: VocalUser }).vocalUser
  const result = await processActivationRequest(user, String(req.params.id), req.body ?? {})
  if (!result.ok) {
    res.status(result.status).json({ error: result.error })
    return
  }
  res.json({ ok: true })
})

router.get('/:id', requireAuth, async (req, res) => {
  const user = (req as typeof req & { vocalUser: VocalUser }).vocalUser
  const result = await getOrgUserById(user, String(req.params.id))
  if (!result.ok) {
    res.status(result.status).json({ error: result.error })
    return
  }
  res.json({ worker: result.worker })
})

router.patch('/:id', requireAuth, async (req, res) => {
  const user = (req as typeof req & { vocalUser: VocalUser }).vocalUser
  const result = await updateOrgUser(user, String(req.params.id), req.body ?? {})
  if (!result.ok) {
    res.status(result.status).json({ error: result.error })
    return
  }
  res.json({ ok: true, worker: result.worker })
})

router.delete('/:id', requireAuth, async (req, res) => {
  const user = (req as typeof req & { vocalUser: VocalUser }).vocalUser
  const result = await deactivateOrgUser(user, String(req.params.id))
  if (!result.ok) {
    res.status(result.status).json({ error: result.error })
    return
  }
  res.json({ ok: true, already_inactive: result.already_inactive ?? false })
})

export default router
