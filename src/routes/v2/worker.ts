import { Router } from 'express'
import { requireAuth } from '@/middleware/requireAuth.js'
import { getCurrentWorkerOffer, getWorkerAssignments } from '@/services/workerQueueService.js'

const router = Router()

router.get('/assignments', requireAuth, async (req, res) => {
  const user = (req as typeof req & { vocalUser: { id: string; roles?: { name: string } } }).vocalUser
  if (user.roles?.name !== 'ground_worker') {
    res.status(403).json({ error: 'Ground workers only' })
    return
  }
  const payload = await getWorkerAssignments(user.id)
  res.json(payload)
})

router.get('/current-offer', requireAuth, async (req, res) => {
  const user = (req as typeof req & { vocalUser: { id: string; roles?: { name: string } } }).vocalUser
  if (user.roles?.name !== 'ground_worker') {
    res.json({ offer: null })
    return
  }
  const offer = await getCurrentWorkerOffer(user.id)
  res.json({ offer })
})

export default router
