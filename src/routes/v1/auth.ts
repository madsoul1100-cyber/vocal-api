import { Router } from 'express'
import {
  formatUserResponse,
  issueTokenForUser,
  loginWithEmailPassword,
  setPasswordForUser,
  signPasswordSetupToken,
  verifyPasswordSetupToken,
} from '@/services/authService.js'
import { getOtpDeliveryStatus, requestStaffOtp, verifyStaffOtp } from '@/services/otpService.js'
import { requireAuth } from '@/middleware/requireAuth.js'

const router = Router()

/** Email + password → JWT (only when password_hash is set). */
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

    const session = await issueTokenForUser(result.user as Record<string, unknown>)
    res.json({
      token: session.token,
      user: formatUserResponse(session.user as Record<string, unknown>),
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Login failed'
    res.status(500).json({ error: msg })
  }
})

/** Which OTP providers are active (console vs AWS SES + Twilio). */
router.get('/otp/status', (_req, res) => {
  res.json(getOtpDeliveryStatus())
})

/** Send OTP via configured provider (SES email / Twilio SMS, or console in test mode). */
router.post('/otp/request', async (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email : ''
  const phone = typeof req.body?.phone === 'string' ? req.body.phone : ''
  const purpose =
    req.body?.purpose === 'forgot_password' ? ('forgot_password' as const) : ('login' as const)

  if (!email.trim() || !phone.trim()) {
    res.status(400).json({ error: 'email and phone are required' })
    return
  }

  const result = await requestStaffOtp({ email, phone, purpose })
  if (!result.ok) {
    res.status(result.status).json({ error: result.error })
    return
  }

  res.json({
    ok: true,
    sent_to: result.sent_to,
    masked_destination: result.masked_destination,
    provider: result.provider,
    delivery_mode: result.delivery_mode,
    ...(result.dev_code ? { dev_code: result.dev_code } : {}),
  })
})

/** Verify OTP → JWT, or setup_token when password must be created/reset. */
router.post('/otp/verify', async (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email : ''
  const phone = typeof req.body?.phone === 'string' ? req.body.phone : ''
  const otp = typeof req.body?.otp === 'string' ? req.body.otp : ''
  const purpose =
    req.body?.purpose === 'forgot_password' ? ('forgot_password' as const) : ('login' as const)

  if (!email.trim() || !phone.trim() || !otp.trim()) {
    res.status(400).json({ error: 'email, phone, and otp are required' })
    return
  }

  const result = await verifyStaffOtp({ email, phone, otp, purpose })
  if (!result.ok) {
    res.status(result.status).json({ error: result.error })
    return
  }

  if (result.needs_password) {
    const setup_token = signPasswordSetupToken(result.user.id as string)
    res.json({
      ok: true,
      needs_password: true,
      setup_token,
      user: formatUserResponse(result.user),
    })
    return
  }

  try {
    const session = await issueTokenForUser(result.user)
    res.json({
      ok: true,
      needs_password: false,
      token: session.token,
      user: formatUserResponse(session.user as Record<string, unknown>),
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Session failed'
    res.status(500).json({ error: msg })
  }
})

/** Set password after OTP (first login or forgot password). Returns JWT. */
router.post('/password/set', async (req, res) => {
  const setup_token = typeof req.body?.setup_token === 'string' ? req.body.setup_token : ''
  const password = typeof req.body?.password === 'string' ? req.body.password : ''

  if (!setup_token || !password) {
    res.status(400).json({ error: 'setup_token and password are required' })
    return
  }

  const userId = verifyPasswordSetupToken(setup_token)
  if (!userId) {
    res.status(401).json({ error: 'Invalid or expired setup session' })
    return
  }

  const updated = await setPasswordForUser(userId, password)
  if (!updated.ok) {
    res.status(updated.status).json({ error: updated.error })
    return
  }

  try {
    const session = await issueTokenForUser(updated.user as Record<string, unknown>)
    res.json({
      ok: true,
      token: session.token,
      user: formatUserResponse(session.user as Record<string, unknown>),
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Session failed'
    res.status(500).json({ error: msg })
  }
})

router.get('/me', requireAuth, async (req, res) => {
  const user = (req as typeof req & { vocalUser: Record<string, unknown> }).vocalUser
  res.json(formatUserResponse(user))
})

export default router
