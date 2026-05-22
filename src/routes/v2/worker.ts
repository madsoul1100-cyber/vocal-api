import { Router } from 'express'
import { requireAuth } from '@/middleware/requireAuth.js'
import { getCurrentWorkerOffer, getWorkerAssignments } from '@/services/workerQueueService.js'
import {
  getWorkerAssignmentsSummary,
  listWorkerAssignmentsV2,
  parseWorkerAssignmentsBucketQuery,
  parseWorkerAssignmentsListQuery,
} from '@/services/workerAssignmentsListService.js'

const router = Router()

function requireGroundWorker(
  req: Parameters<typeof requireAuth>[0],
  res: import('express').Response,
): { id: string; roles?: { name: string } } | null {
  const user = (req as typeof req & { vocalUser: { id: string; roles?: { name: string } } }).vocalUser
  if (user.roles?.name !== 'ground_worker') {
    res.status(403).json({ error: 'Ground workers only' })
    return null
  }
  return user
}

/** Tab badge counts (unfiltered totals). */
router.get('/assignments/summary', requireAuth, async (req, res) => {
  const user = requireGroundWorker(req, res)
  if (!user) return

  try {
    const summary = await getWorkerAssignmentsSummary(user.id)
    res.json(summary)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Summary failed'
    res.status(500).json({ error: message })
  }
})

/**
 * Without `bucket`: legacy payload (offered + activeTickets + telegramLinked).
 * With `bucket=offered|active|closed`: paginated list for that tab.
 */
router.get('/assignments', requireAuth, async (req, res) => {
  const user = requireGroundWorker(req, res)
  if (!user) return

  const bucket = parseWorkerAssignmentsBucketQuery(req.query as Record<string, unknown>)
  if (!bucket) {
    const payload = await getWorkerAssignments(user.id)
    res.json(payload)
    return
  }

  const opts = parseWorkerAssignmentsListQuery(req.query as Record<string, unknown>, bucket)
  try {
    const result = await listWorkerAssignmentsV2(user.id, bucket, opts)
    res.json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'List failed'
    res.status(500).json({ error: message })
  }
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
