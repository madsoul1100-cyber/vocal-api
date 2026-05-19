import type { NextFunction, Request, Response } from 'express'
import { getAuth } from '@clerk/express'
import { getCurrentVocalUser } from '@/lib/auth.js'

/** Requires a valid Clerk session and active Vocal user row. */
export async function requireClerkAuth(req: Request, res: Response, next: NextFunction) {
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
