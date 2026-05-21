import type { NextFunction, Request, Response } from 'express'
import { getBearerToken, getCurrentVocalUser } from '@/lib/auth.js'
import { getDevBypassVocalUser, isDevAuthBypassEnabled } from '@/lib/devAuth.js'

/** Requires a valid JWT (or dev bypass when no Bearer token in development). */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const bearer = getBearerToken(req)

  if (bearer) {
    const user = await getCurrentVocalUser(req)
    if (!user) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid or expired Bearer token. Sign in again via POST /v1/auth/login.',
      })
      return
    }
    ;(req as Request & { vocalUser: typeof user }).vocalUser = user
    next()
    return
  }

  if (isDevAuthBypassEnabled()) {
    const user = await getDevBypassVocalUser()
    if (!user) {
      res.status(503).json({
        error: 'Dev auth bypass: no user found',
        message:
          'Add an active users row, set ORG_ID, or set DEV_USER_ID in .env.local',
      })
      return
    }
    ;(req as Request & { vocalUser: typeof user }).vocalUser = user
    next()
    return
  }

  res.status(401).json({
    error: 'Unauthorized',
    message: 'Missing Bearer token. Sign in via POST /v1/auth/login.',
  })
}
