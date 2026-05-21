import type { NextFunction, Request, Response } from 'express'
import { getAuth } from '@clerk/express'
import { getCurrentVocalUser } from '@/lib/auth.js'
import { getDevBypassVocalUser, isDevAuthBypassEnabled } from '@/lib/devAuth.js'

/** Requires a valid Clerk session and active Vocal user row (skipped in local dev when bypass is on). */
export async function requireClerkAuth(req: Request, res: Response, next: NextFunction) {
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

  const { userId } = getAuth(req)
  if (!userId) {
    res.status(401).json({
      error: 'Unauthorized',
      message:
        'Clerk session not verified. Ensure vocal-api has CLERK_SECRET_KEY and CLERK_PUBLISHABLE_KEY for the same Clerk app as vocal-web.',
    })
    return
  }

  const user = await getCurrentVocalUser(req)
  if (!user) {
    res.status(403).json({
      error: 'Staff profile not found',
      message:
        'Signed in with Clerk but no active users row for this clerk_user_id. Link the account in Supabase or run npm run seed:test-users from the monolith.',
      clerk_user_id: userId,
    })
    return
  }

  ;(req as Request & { vocalUser: typeof user }).vocalUser = user
  next()
}
