import { Router } from 'express'
import {
  formatUserResponse,
  loginWithEmailPassword,
} from '@/services/authService.js'
import { requireAuth } from '@/middleware/requireAuth.js'

const router = Router()

router.post('/login', async (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email : ''
  const password = typeof req.body?.password === 'string' ? req.body.password : ''

  if (!email.trim() || !password) {
    res.status(400).json({ error: 'email and password are required' })
    return
  }

  try {
    const result = await loginWithEmailPassword(email, password)
    if (!result.ok) {
      const body: Record<string, unknown> = { error: result.error }
      if ('code' in result && result.code) body.code = result.code
      res.status(result.status).json(body)
      return
    }

    res.json({
      token: result.token,
      user: formatUserResponse(result.user as Record<string, unknown>),
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Login failed'
    res.status(500).json({ error: msg })
  }
})

router.get('/me', requireAuth, async (req, res) => {
  const user = (req as typeof req & { vocalUser: Record<string, unknown> }).vocalUser
  res.json(formatUserResponse(user))
})

export default router
