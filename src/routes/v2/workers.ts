import { Router } from 'express'
import { requireAuth } from '@/middleware/requireAuth.js'
import {
  canAccessWorkersPage,
  createOrgUser,
  deactivateOrgUser,
  getOrgUserById,
  listWorkersV2,
  parseWorkersV2ListQuery,
  processActivationRequest,
  updateOrgUser,
  workersV2FiltersEcho,
} from '@/services/workersManagementService.js'

const router = Router()

type VocalUser = {
  id: string
  organization_id: string
  roles?: { name: string } | null
}

/** v2: paginated staff list + pending activations; filters, sort, org summary counts */
router.get('/', requireAuth, async (req, res) => {
  const user = (req as typeof req & { vocalUser: VocalUser }).vocalUser
  if (!canAccessWorkersPage(user.roles?.name)) {
    res.status(403).json({ error: 'Insufficient role' })
    return
  }

  const listOpts = parseWorkersV2ListQuery(req.query as Record<string, unknown>)

  try {
    const result = await listWorkersV2(user.organization_id, listOpts)
    res.json({
      workers: result.workers,
      pagination: result.pagination,
      pending: result.pending,
      pending_pagination: result.pending_pagination,
      summary: result.summary,
      territories: result.territories,
      roles: result.roles,
      filters: workersV2FiltersEcho(listOpts),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Workers list failed'
    res.status(500).json({ error: message })
  }
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

/** Soft-deactivate (active=false). Does not delete the users row. */
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
