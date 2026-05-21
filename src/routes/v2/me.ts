import { Router } from 'express'
import { requireAuth } from '@/middleware/requireAuth.js'
import { formatUserResponse } from '@/services/authService.js'

const router = Router()

/** @deprecated Prefer GET /v1/auth/me — kept for compatibility */
router.get('/', requireAuth, async (req, res) => {
  const user = (req as typeof req & { vocalUser: Record<string, unknown> }).vocalUser
  res.json(formatUserResponse(user))
})

export default router
