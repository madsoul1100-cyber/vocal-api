import { Router } from 'express'
import { requireClerkAuth } from '@/middleware/clerkAuth.js'
import { formatUserResponse } from '@/services/authService.js'

const router = Router()

/** @deprecated Prefer GET /v1/auth/me — kept for compatibility */
router.get('/', requireClerkAuth, async (req, res) => {
  const user = (req as typeof req & { vocalUser: Record<string, unknown> }).vocalUser
  res.json(formatUserResponse(user))
})

export default router
