/**
 * Backward-compatible alias while vocal-app migrates from Clerk session → JWT Bearer.
 *
 * Today both names use the same middleware (JWT + optional dev bypass).
 * When Clerk is re-enabled, implement Clerk verification here and use
 * `requireStaffAuth` below to try JWT first, then Clerk.
 */
export { requireAuth, requireAuth as requireClerkAuth } from '@/middleware/requireAuth.js'

import type { NextFunction, Request, Response } from 'express'
import { requireAuth } from '@/middleware/requireAuth.js'

/** Accept either auth path during migration (currently identical to requireAuth). */
export async function requireStaffAuth(req: Request, res: Response, next: NextFunction) {
  return requireAuth(req, res, next)
}
