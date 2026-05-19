import { Router } from 'express'
import { formatUserResponse } from '@/services/authService.js'
import { requireClerkAuth } from '@/middleware/clerkAuth.js'

const router = Router()

/** Current staff user (Clerk session → users.clerk_user_id). */
router.get('/me', requireClerkAuth, async (req, res) => {
  const user = (req as typeof req & { vocalUser: Record<string, unknown> }).vocalUser
  res.json(formatUserResponse(user))
})

export default router
