import type { NextFunction, Request, Response } from 'express'

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
) {
  console.error('[vocal-api]', err)
  const message =
    err instanceof Error ? err.message : 'Internal server error'
  if (res.headersSent) return
  res.status(500).json({ error: message })
}
