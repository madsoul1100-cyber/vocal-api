import type { NextFunction, Request, Response } from 'express'
import { dbQuery, isPostgresMode } from '@/lib/db.js'

export type StaffUser = {
  id: string
  organization_id: string
  full_name?: string
  roles?: { name: string } | null
}

/** GRO = Grievance Redressal Officer. Maps onto existing privileged roles. */
export const GRO_ROLES = ['super_admin', 'central_support'] as const
export const CASE_WORKER_ROLES = [
  ...GRO_ROLES,
  'state_leader',
  'district_leader',
  'ground_worker',
  'legal_support',
] as const
export const COMMS_APPROVER_ROLES = [...GRO_ROLES] as const
export const PUBLIC_POST_APPROVER_ROLES = [...GRO_ROLES, 'media_volunteer'] as const
export const TENANT_ADMIN_ROLES = ['super_admin'] as const

export function roleOf(user: StaffUser): string {
  return user.roles?.name ?? ''
}

export function hasRole(user: StaffUser, roles: readonly string[]): boolean {
  return roles.includes(roleOf(user))
}

export function isGro(user: StaffUser): boolean {
  return hasRole(user, GRO_ROLES)
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    public details?: unknown,
  ) {
    super(message)
  }
}

export function assert(cond: unknown, status: number, message: string, code?: string): asserts cond {
  if (!cond) throw new HttpError(status, message, code)
}

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>

/** Wraps an async route so HttpError becomes a JSON response and other errors reach errorHandler. */
export function route(fn: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch((err: unknown) => {
      if (err instanceof HttpError) {
        res.status(err.status).json({
          error: err.message,
          ...(err.code ? { code: err.code } : {}),
          ...(err.details !== undefined ? { details: err.details } : {}),
        })
        return
      }
      next(err)
    })
  }
}

export function staffUser(req: Request): StaffUser {
  return (req as Request & { vocalUser: StaffUser }).vocalUser
}

export function requireRoles(roles: readonly string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = staffUser(req)
    if (!user || !hasRole(user, roles)) {
      res.status(403).json({ error: 'Insufficient role' })
      return
    }
    next()
  }
}

export function requirePostgres(_req: Request, res: Response, next: NextFunction) {
  if (!isPostgresMode()) {
    res.status(503).json({ error: 'Bharosa modules require DATABASE_URL (Postgres/RDS)' })
    return
  }
  next()
}

export function clientIp(req: Request): string {
  const fwd = req.headers['x-forwarded-for']
  const first = Array.isArray(fwd) ? fwd[0] : fwd?.split(',')[0]
  return (first ?? req.socket.remoteAddress ?? '').trim()
}

/**
 * Per-instance fixed-window limiter for public endpoints. Durable limits that
 * matter for cost/abuse (OTP sends) are enforced in the database instead.
 */
export function rateLimit(opts: { windowMs: number; max: number; key?: (req: Request) => string }) {
  const hits = new Map<string, { count: number; resetAt: number }>()
  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now()
    const k = opts.key ? opts.key(req) : clientIp(req)
    const h = hits.get(k)
    if (!h || h.resetAt <= now) {
      hits.set(k, { count: 1, resetAt: now + opts.windowMs })
      if (hits.size > 50_000) for (const [key, v] of hits) if (v.resetAt <= now) hits.delete(key)
      next()
      return
    }
    if (++h.count > opts.max) {
      res.setHeader('Retry-After', String(Math.ceil((h.resetAt - now) / 1000)))
      res.status(429).json({ error: 'Too many requests. Please slow down.', code: 'RATE_LIMITED' })
      return
    }
    next()
  }
}

const orgSlugCache = new Map<string, { id: string; expires: number }>()

/**
 * Resolve tenant for unauthenticated (citizen/public) requests.
 * Order: `X-Org-Slug` header → `?org=` query → ORG_ID env.
 */
export async function resolvePublicOrgId(req: Request): Promise<string> {
  const header = req.headers['x-org-slug']
  const slugRaw = (Array.isArray(header) ? header[0] : header) ?? (typeof req.query.org === 'string' ? req.query.org : '')
  const slug = slugRaw.trim().toLowerCase()
  if (slug) {
    const cached = orgSlugCache.get(slug)
    if (cached && cached.expires > Date.now()) return cached.id
    const res = await dbQuery<{ id: string }>(
      'SELECT id FROM organizations WHERE slug = $1 AND active = true LIMIT 1',
      [slug],
    )
    const id = res.rows[0]?.id
    if (!id) throw new HttpError(404, 'Unknown organization', 'ORG_NOT_FOUND')
    orgSlugCache.set(slug, { id, expires: Date.now() + 5 * 60_000 })
    return id
  }
  const envOrg = process.env.ORG_ID?.trim()
  if (!envOrg) throw new HttpError(500, 'ORG_ID is not configured', 'ORG_NOT_CONFIGURED')
  return envOrg
}

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

export function str(v: unknown, max = 5000): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t ? t.slice(0, max) : null
}

export function num(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

export function bool(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v
  if (v === 'true') return true
  if (v === 'false') return false
  return null
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function uuid(v: unknown): string | null {
  return typeof v === 'string' && UUID_RE.test(v.trim()) ? v.trim() : null
}

export function uuidParam(req: Request, name: string): string {
  const id = uuid(req.params[name])
  if (!id) throw new HttpError(400, `Invalid ${name}`)
  return id
}

export function oneOf<T extends string>(v: unknown, allowed: readonly T[]): T | null {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : null
}

export function pageParams(query: Record<string, unknown>): { limit: number; offset: number; page: number } {
  const limit = Math.min(Math.max(Number(query.limit) || 25, 1), 100)
  const page = Math.max(Number(query.page) || 1, 1)
  return { limit, page, offset: (page - 1) * limit }
}

/**
 * Guard for server-side fetches of tenant-configured URLs (feeds, directory
 * sources). Resolves the host and rejects loopback/private/link-local targets.
 */
export async function assertPublicHttpUrl(raw: string): Promise<URL> {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new HttpError(400, 'Invalid URL')
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new HttpError(400, 'Only http(s) URLs are allowed')
  const host = u.hostname.replace(/^\[|\]$/g, '')
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(host)) throw new HttpError(400, 'URL host is not allowed')
  const { lookup } = await import('node:dns/promises')
  const addrs = await lookup(host, { all: true }).catch(() => [])
  if (!addrs.length) throw new HttpError(400, 'URL host could not be resolved')
  for (const { address } of addrs) {
    if (isPrivateAddress(address)) throw new HttpError(400, 'URL resolves to a private address')
  }
  return u
}

function isPrivateAddress(ip: string): boolean {
  if (ip.includes(':')) {
    const v = ip.toLowerCase()
    if (v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80')) return true
    const mapped = v.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    return mapped ? isPrivateAddress(mapped[1]) : false
  }
  const [a, b] = ip.split('.').map(Number)
  return (
    a === 10 || a === 127 || a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  )
}

export type Language = 'te' | 'en'
export const SUPPORTED_LANGUAGES: readonly Language[] = ['te', 'en']

export function parseLanguage(v: unknown, fallback: Language = 'te'): Language {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : ''
  if (s === 'en' || s === 'english') return 'en'
  if (s === 'te' || s === 'telugu' || s === 'tel') return 'te'
  return fallback
}

export function languageName(lang: string): string {
  return lang === 'te' ? 'Telugu (తెలుగు script)' : 'English'
}
