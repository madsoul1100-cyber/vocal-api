import type { NextFunction, Request, Response } from 'express'
import { getCurrentVocalUser } from '@/lib/auth.js'

export async function requireJwtAuth(req: Request, res: Response, next: NextFunction) {
  const user = await getCurrentVocalUser(req)
  if (!user) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }
  ;(req as Request & { vocalUser: typeof user }).vocalUser = user
  next()
}
