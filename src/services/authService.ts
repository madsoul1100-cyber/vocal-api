import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { createSupabaseServiceClient } from '@/lib/supabase.js'

const BCRYPT_ROUNDS = 12
const JWT_SECRET = process.env.JWT_SECRET ?? ''
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN ?? '7d'

export interface JwtPayload {
  sub: string
  orgId: string
  role: string
}

export interface PasswordSetupPayload {
  sub: string
  purpose: 'set_password'
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS)
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash)
}

export function signAccessToken(payload: JwtPayload): string {
  if (!JWT_SECRET || JWT_SECRET.length < 32) {
    throw new Error('JWT_SECRET must be set (min 32 characters)')
  }
  return jwt.sign(payload, JWT_SECRET, {
    expiresIn: JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'],
  })
}

const PASSWORD_SETUP_EXPIRES_IN = '15m'

export function signPasswordSetupToken(userId: string): string {
  if (!JWT_SECRET || JWT_SECRET.length < 32) {
    throw new Error('JWT_SECRET must be set (min 32 characters)')
  }
  return jwt.sign({ sub: userId, purpose: 'set_password' } satisfies PasswordSetupPayload, JWT_SECRET, {
    expiresIn: PASSWORD_SETUP_EXPIRES_IN,
  })
}

export function verifyPasswordSetupToken(token: string): string | null {
  if (!JWT_SECRET) return null
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as PasswordSetupPayload
    if (decoded?.purpose !== 'set_password' || !decoded?.sub) return null
    return decoded.sub
  } catch {
    return null
  }
}

export function verifyAccessToken(token: string): JwtPayload | null {
  if (!JWT_SECRET) return null
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload
    if (!decoded?.sub) return null
    return decoded
  } catch {
    return null
  }
}

function classifyLoginLookupError(message: string): {
  status: number
  code: string
  error: string
} {
  const m = message.toLowerCase()
  const connectivity =
    m.includes('connection terminated') ||
    m.includes('connection timeout') ||
    m.includes('connect etimedout') ||
    m.includes('econnrefused') ||
    m.includes('enotfound') ||
    m.includes('getaddrinfo') ||
    (m.includes('timeout') && m.includes('connect'))

  if (connectivity) {
    return {
      status: 503,
      code: 'DATABASE_UNAVAILABLE',
      error:
        'Cannot reach the database. Check DATABASE_URL, VPN, and RDS network access, then try again.',
    }
  }

  return {
    status: 503,
    code: 'DATABASE_ERROR',
    error: 'A database error occurred during sign-in. Try again or contact support.',
  }
}

export async function loginWithEmailPassword(email: string, password: string) {
  const supabase = createSupabaseServiceClient()
  const normalized = email.trim().toLowerCase()

  const { data: user, error } = await supabase
    .from('users')
    .select('*, roles(*), organizations(name)')
    .eq('email', normalized)
    .maybeSingle()

  if (error) {
    const classified = classifyLoginLookupError(error.message)
    return { ok: false as const, ...classified }
  }

  if (!user) {
    return { ok: false as const, error: 'Invalid email or password', status: 401 }
  }

  if (!user.active) {
    return {
      ok: false as const,
      error: 'Account is inactive. Contact Super Admin or Central Support.',
      code: 'INACTIVE',
      status: 403,
    }
  }

  if (!user.approved_at) {
    return {
      ok: false as const,
      error: 'Account pending approval from Super Admin or Central Support',
      code: 'PENDING_ACTIVATION',
      status: 403,
    }
  }

  const hash = user.password_hash as string | null
  if (!hash) {
    return {
      ok: false as const,
      error: 'No password set. Sign in with email, phone, and OTP to create your password.',
      code: 'PASSWORD_NOT_SET',
      status: 403,
    }
  }

  const valid = await verifyPassword(password, hash)
  if (!valid) {
    return { ok: false as const, error: 'Invalid email or password', status: 401 }
  }

  const roleName = (user.roles as { name: string } | null)?.name ?? ''
  const token = signAccessToken({
    sub: user.id,
    orgId: user.organization_id,
    role: roleName,
  })

  await supabase
    .from('users')
    .update({ last_login_at: new Date().toISOString() })
    .eq('id', user.id)

  return { ok: true as const, token, user }
}

export async function issueTokenForUser(user: Record<string, unknown>) {
  const roleName = (user.roles as { name: string } | null)?.name ?? ''
  const token = signAccessToken({
    sub: user.id as string,
    orgId: user.organization_id as string,
    role: roleName,
  })

  const supabase = createSupabaseServiceClient()
  await supabase
    .from('users')
    .update({ last_login_at: new Date().toISOString() })
    .eq('id', user.id)

  return { token, user }
}

export async function setPasswordForUser(userId: string, password: string) {
  if (password.length < 8) {
    return { ok: false as const, status: 400, error: 'password must be at least 8 characters' }
  }

  const supabase = createSupabaseServiceClient()
  const password_hash = await hashPassword(password)
  const { data: user, error } = await supabase
    .from('users')
    .update({ password_hash, updated_at: new Date().toISOString() })
    .eq('id', userId)
    .select('*, roles(*), organizations(name)')
    .single()

  if (error || !user) {
    return { ok: false as const, status: 500, error: error?.message ?? 'Update failed' }
  }

  return { ok: true as const, user }
}

export function formatUserResponse(user: Record<string, unknown>) {
  const roles = user.roles as { name: string; display_name: string } | null
  const org = user.organizations as { name: string } | null
  return {
    id: user.id,
    full_name: user.full_name,
    email: user.email,
    phone: user.phone,
    organization_id: user.organization_id,
    organization_name: org?.name ?? null,
    role: roles?.name ?? null,
    role_display_name: roles?.display_name ?? null,
  }
}
