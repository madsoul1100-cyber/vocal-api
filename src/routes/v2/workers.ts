import { Router } from 'express'
import { requireClerkAuth } from '@/middleware/clerkAuth.js'
import { repairClerkAccountByEmail } from '@/lib/clerkAdmin.js'
import {
  canAccessWorkersPage,
  createOrgUser,
  listWorkersV2,
  parseWorkersV2ListQuery,
  processActivationRequest,
  workersV2FiltersEcho,
} from '@/services/workersManagementService.js'

const router = Router()

type VocalUser = {
  id: string
  organization_id: string
  roles?: { name: string } | null
}

/** v2: paginated staff list + pending activations; filters, sort, org summary counts */
router.get('/', requireClerkAuth, async (req, res) => {
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

router.post('/', requireClerkAuth, async (req, res) => {
  const user = (req as typeof req & { vocalUser: VocalUser }).vocalUser
  const result = await createOrgUser(user, req.body ?? {})
  if (!result.ok) {
    res.status(result.status).json({ error: result.error })
    return
  }
  res.json({ ok: true, id: result.id })
})

/** Fix Clerk account stuck on /sign-in/factor-one (verify email + clear MFA). */
router.post('/repair-clerk', requireClerkAuth, async (req, res) => {
  const user = (req as typeof req & { vocalUser: VocalUser }).vocalUser
  if (!canAccessWorkersPage(user.roles?.name)) {
    res.status(403).json({ error: 'Insufficient role' })
    return
  }
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : ''
  if (!email) {
    res.status(400).json({ error: 'email is required' })
    return
  }
  const clerkUserId = await repairClerkAccountByEmail(email)
  if (!clerkUserId) {
    res.status(404).json({ error: 'No Clerk user found for this email' })
    return
  }
  res.json({ ok: true, clerk_user_id: clerkUserId })
})

router.post('/activation/:id', requireClerkAuth, async (req, res) => {
  const user = (req as typeof req & { vocalUser: VocalUser }).vocalUser
  const result = await processActivationRequest(user, String(req.params.id), req.body ?? {})
  if (!result.ok) {
    res.status(result.status).json({ error: result.error })
    return
  }
  res.json({ ok: true })
})

export default router
