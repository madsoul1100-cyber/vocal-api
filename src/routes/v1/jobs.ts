import { Router } from 'express'
import { requireAuth } from '@/middleware/requireAuth.js'
import {
  canAccessJobs,
  listExpireJobRuns,
  runExpireAssignmentsJob,
} from '@/services/jobsService.js'

const router = Router()

type VocalUser = {
  id: string
  organization_id: string
  roles?: { name: string } | null
}

function requireJobsRole(req: Parameters<typeof requireAuth>[0], res: import('express').Response): VocalUser | null {
  const user = (req as typeof req & { vocalUser: VocalUser }).vocalUser
  if (!canAccessJobs(user.roles?.name)) {
    res.status(403).json({ error: 'Insufficient role' })
    return null
  }
  return user
}

router.get('/', requireAuth, async (req, res) => {
  const user = requireJobsRole(req, res)
  if (!user) return

  const runs = await listExpireJobRuns(user.organization_id)
  res.json({ runs })
})

router.post('/run-expire', requireAuth, async (req, res) => {
  const user = requireJobsRole(req, res)
  if (!user) return

  const result = await runExpireAssignmentsJob(user)
  if (!result.ok) {
    res.status(500).json({ ok: false, error: result.error })
    return
  }
  res.json(result)
})

export default router
