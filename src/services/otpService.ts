import crypto from 'node:crypto'
import { createSupabaseServiceClient } from '@/lib/supabase.js'
import { deliverStaffOtp, getOtpDeliveryStatus } from '@/lib/otp/delivery.js'
import { exposeDevOtpInApi, otpTtlMinutes } from '@/lib/otp/config.js'
import type { OtpPurpose } from '@/lib/otp/types.js'
import { hashPassword, verifyPassword } from '@/services/authService.js'

export type { OtpPurpose }
export { getOtpDeliveryStatus }

const OTP_LENGTH = 6
const MAX_VERIFY_ATTEMPTS = 5
const RESEND_COOLDOWN_MS = 60 * 1000

function otpTtlMs(): number {
  return otpTtlMinutes() * 60 * 1000
}

function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase()
}

/** E.164-ish: digits only with leading + */
export function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, '')
  if (digits.length < 10 || digits.length > 15) return null
  if (digits.length === 10) return `+91${digits}`
  if (digits.startsWith('91') && digits.length === 12) return `+${digits}`
  return `+${digits}`
}

function phoneLast10(raw: string): string {
  return raw.replace(/\D/g, '').slice(-10)
}

/** Match stored vs input even when DB has 9120… and sign-in sends +919120… */
export function phonesMatch(stored: string | null | undefined, input: string): boolean {
  const normalizedInput = normalizePhone(input)
  if (!normalizedInput) return false
  const storedRaw = stored?.trim()
  if (!storedRaw) return false

  const normalizedStored = normalizePhone(storedRaw)
  if (normalizedStored && normalizedStored === normalizedInput) return true

  const a = phoneLast10(storedRaw)
  const b = phoneLast10(input)
  return a.length === 10 && b.length === 10 && a === b
}

type StaffOtpLookupResult =
  | { ok: true; user: Record<string, unknown> }
  | { ok: false; error: string; status: number }

export type OtpStaffIdentifier = {
  email?: string
  phone?: string
}

const USER_OTP_SELECT = '*, roles(*), organizations(name)'

function parseOtpStaffIdentifier(ident: OtpStaffIdentifier): {
  ok: true
  emailRaw: string
  phoneRaw: string
  normalizedEmail: string
  normalizedPhone: string | null
} | { ok: false; error: string; status: number } {
  const emailRaw = ident.email?.trim() ?? ''
  const phoneRaw = ident.phone?.trim() ?? ''

  if (!emailRaw && !phoneRaw) {
    return { ok: false, error: 'Enter your email or mobile number', status: 400 }
  }

  const normalizedEmail = emailRaw ? normalizeEmail(emailRaw) : ''
  if (emailRaw && !normalizedEmail) {
    return { ok: false, error: 'Enter a valid email address', status: 400 }
  }

  const normalizedPhone = phoneRaw ? normalizePhone(phoneRaw) : null
  if (phoneRaw && !normalizedPhone) {
    return {
      ok: false,
      error: 'Enter a valid mobile number (10 digits, or +91…)',
      status: 400,
    }
  }

  return { ok: true, emailRaw, phoneRaw, normalizedEmail, normalizedPhone }
}

async function findStaffUserByPhone(
  normalizedPhone: string,
  phoneRaw: string,
): Promise<Record<string, unknown> | null> {
  const supabase = createSupabaseServiceClient()

  const { data: exact } = await supabase
    .from('users')
    .select(USER_OTP_SELECT)
    .eq('phone', normalizedPhone)
    .maybeSingle()
  if (exact) return exact as Record<string, unknown>

  const digits = normalizedPhone.replace(/\D/g, '')
  const variants = new Set<string>([
    digits,
    `+${digits}`,
    digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : '',
    digits.length === 10 ? `91${digits}` : '',
    digits.length === 12 && digits.startsWith('91') ? `+${digits}` : '',
  ])
  for (const variant of variants) {
    if (!variant) continue
    const { data } = await supabase
      .from('users')
      .select(USER_OTP_SELECT)
      .eq('phone', variant)
      .maybeSingle()
    if (data) return data as Record<string, unknown>
  }

  const { data: rows } = await supabase
    .from('users')
    .select(USER_OTP_SELECT)
    .not('phone', 'is', null)

  const matches = (rows ?? []).filter((row) =>
    phonesMatch((row as { phone?: string | null }).phone, phoneRaw),
  )
  if (matches.length === 1) return matches[0] as Record<string, unknown>
  return null
}

async function lookupStaffUserForOtp(ident: OtpStaffIdentifier): Promise<StaffOtpLookupResult> {
  const parsed = parseOtpStaffIdentifier(ident)
  if (!parsed.ok) return parsed

  const { emailRaw, phoneRaw, normalizedEmail, normalizedPhone } = parsed
  const supabase = createSupabaseServiceClient()

  if (normalizedEmail && normalizedPhone) {
    const { data: user } = await supabase
      .from('users')
      .select(USER_OTP_SELECT)
      .eq('email', normalizedEmail)
      .maybeSingle()

    if (!user) {
      return { ok: false, error: 'No account found with this email', status: 404 }
    }

    const storedPhone = (user as Record<string, unknown>).phone as string | null | undefined
    if (!storedPhone?.trim()) {
      return {
        ok: false,
        error:
          'No mobile number on this account. Sign in with email only, or ask your admin to add your phone.',
        status: 403,
      }
    }

    if (!phonesMatch(storedPhone, phoneRaw)) {
      return {
        ok: false,
        error: 'This mobile number does not match the phone saved on your account',
        status: 404,
      }
    }

    return { ok: true, user: user as Record<string, unknown> }
  }

  if (normalizedEmail) {
    const { data: user } = await supabase
      .from('users')
      .select(USER_OTP_SELECT)
      .eq('email', normalizedEmail)
      .maybeSingle()

    if (!user) {
      return { ok: false, error: 'No account found with this email', status: 404 }
    }

    return { ok: true, user: user as Record<string, unknown> }
  }

  const user = await findStaffUserByPhone(normalizedPhone!, phoneRaw)
  if (!user) {
    const { data: rows } = await supabase.from('users').select(USER_OTP_SELECT).not('phone', 'is', null)
    const matches = (rows ?? []).filter((row) =>
      phonesMatch((row as { phone?: string | null }).phone, phoneRaw),
    )
    if (matches.length > 1) {
      return {
        ok: false,
        error: 'Multiple accounts match this mobile number. Sign in with your email instead.',
        status: 409,
      }
    }
    return { ok: false, error: 'No account found with this mobile number', status: 404 }
  }

  return { ok: true, user }
}

function generateOtpCode(): string {
  const n = crypto.randomInt(0, 10 ** OTP_LENGTH)
  return String(n).padStart(OTP_LENGTH, '0')
}

async function hashOtp(code: string): Promise<string> {
  return hashPassword(code)
}

function maskDestination(channel: 'sms' | 'email', dest: string): string {
  if (channel === 'email') {
    const [local, domain] = dest.split('@')
    if (!domain) return '***'
    const head = local.slice(0, 2)
    return `${head}***@${domain}`
  }
  const tail = dest.slice(-4)
  return `***${tail}`
}

export async function findStaffUserByEmailAndPhone(
  email?: string,
  phone?: string,
): Promise<Record<string, unknown> | null> {
  const result = await lookupStaffUserForOtp({ email, phone })
  return result.ok ? result.user : null
}

function assertUserCanAuthenticate(
  user: Record<string, unknown>,
): { ok: true } | { error: string; code?: string; status: number } {
  if (!user.active) {
    return { error: 'Account is inactive. Contact your admin.', code: 'INACTIVE', status: 403 }
  }
  if (!user.approved_at) {
    return {
      error: 'Account pending approval from Super Admin or Central Support',
      code: 'PENDING_ACTIVATION',
      status: 403,
    }
  }
  return { ok: true }
}

export async function requestStaffOtp(args: {
  email?: string
  phone?: string
  purpose: OtpPurpose
}): Promise<
  | {
      ok: true
      sent_to: 'sms' | 'email'
      masked_destination: string
      provider: string
      delivery_mode: string
      dev_code?: string
    }
  | { ok: false; error: string; status: number }
> {
  const lookup = await lookupStaffUserForOtp({ email: args.email, phone: args.phone })
  if (!lookup.ok) {
    return { ok: false, error: lookup.error, status: lookup.status }
  }
  const user = lookup.user

  const gate = assertUserCanAuthenticate(user)
  if ('error' in gate) {
    return { ok: false, error: gate.error, status: gate.status ?? 403 }
  }

  const parsedIdent = parseOtpStaffIdentifier({ email: args.email, phone: args.phone })
  if (!parsedIdent.ok) {
    return { ok: false, error: parsedIdent.error, status: parsedIdent.status }
  }

  const supabase = createSupabaseServiceClient()
  const userId = user.id as string
  const accountEmail = typeof user.email === 'string' ? normalizeEmail(user.email) : ''
  const accountPhoneRaw = typeof user.phone === 'string' ? user.phone.trim() : ''
  const accountPhone = accountPhoneRaw ? normalizePhone(accountPhoneRaw) : null

  if (!accountEmail && !accountPhone) {
    return {
      ok: false,
      error: 'Account has no email or mobile number on file. Contact your admin.',
      status: 403,
    }
  }

  const { emailRaw, phoneRaw } = parsedIdent
  const channelPreference =
    phoneRaw && !emailRaw ? ('sms_first' as const) : emailRaw && !phoneRaw ? ('email_first' as const) : undefined

  const recent = await supabase
    .from('staff_auth_otps')
    .select('created_at')
    .eq('user_id', userId)
    .eq('purpose', args.purpose)
    .is('consumed_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (recent.data?.created_at) {
    const age = Date.now() - new Date(recent.data.created_at as string).getTime()
    if (age < RESEND_COOLDOWN_MS) {
      return { ok: false, error: 'Please wait a minute before requesting another code', status: 429 }
    }
  }

  await supabase
    .from('staff_auth_otps')
    .update({ consumed_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('purpose', args.purpose)
    .is('consumed_at', null)

  const code = generateOtpCode()
  const code_hash = await hashOtp(code)
  const expires_at = new Date(Date.now() + otpTtlMs()).toISOString()

  const delivery = await deliverStaffOtp({
    code,
    purpose: args.purpose,
    email: accountEmail || undefined,
    phone: accountPhone || undefined,
    channelPreference,
  })

  if (!delivery.ok) {
    return { ok: false, error: delivery.error, status: 503 }
  }

  const { channel, destination, provider, dev_code } = delivery.result

  const { error: insertErr } = await supabase.from('staff_auth_otps').insert({
    user_id: userId,
    purpose: args.purpose,
    channel,
    destination,
    code_hash,
    expires_at,
  })

  if (insertErr) {
    return { ok: false, error: insertErr.message, status: 500 }
  }

  const status = getOtpDeliveryStatus()

  return {
    ok: true,
    sent_to: channel,
    masked_destination: maskDestination(channel, destination),
    provider,
    delivery_mode: status.mode,
    ...(dev_code && exposeDevOtpInApi() ? { dev_code } : {}),
  }
}

export async function verifyStaffOtp(args: {
  email?: string
  phone?: string
  otp: string
  purpose: OtpPurpose
}): Promise<
  | {
      ok: true
      user: Record<string, unknown>
      needs_password: boolean
    }
  | { ok: false; error: string; status: number }
> {
  const user = await findStaffUserByEmailAndPhone(args.email, args.phone)
  if (!user) {
    return { ok: false, error: 'Invalid verification', status: 401 }
  }

  const gate = assertUserCanAuthenticate(user)
  if ('error' in gate) {
    return { ok: false, error: gate.error, status: gate.status ?? 403 }
  }

  const code = args.otp.trim().replace(/\D/g, '')
  if (code.length !== OTP_LENGTH) {
    return { ok: false, error: 'Invalid verification code', status: 400 }
  }

  const supabase = createSupabaseServiceClient()
  const userId = user.id as string

  const { data: row } = await supabase
    .from('staff_auth_otps')
    .select('id, code_hash, expires_at, attempt_count, consumed_at')
    .eq('user_id', userId)
    .eq('purpose', args.purpose)
    .is('consumed_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!row) {
    return { ok: false, error: 'No active code. Request a new one.', status: 400 }
  }

  if (row.consumed_at) {
    return { ok: false, error: 'Code already used', status: 400 }
  }

  if (new Date(row.expires_at as string).getTime() < Date.now()) {
    return { ok: false, error: 'Code expired. Request a new one.', status: 400 }
  }

  const attempts = (row.attempt_count as number) + 1
  if (attempts > MAX_VERIFY_ATTEMPTS) {
    return { ok: false, error: 'Too many attempts. Request a new code.', status: 429 }
  }

  const valid = await verifyPassword(code, row.code_hash as string)
  if (!valid) {
    await supabase.from('staff_auth_otps').update({ attempt_count: attempts }).eq('id', row.id)
    return { ok: false, error: 'Invalid verification code', status: 401 }
  }

  await supabase
    .from('staff_auth_otps')
    .update({ consumed_at: new Date().toISOString(), attempt_count: attempts })
    .eq('id', row.id)

  const hasPassword = !!(user.password_hash as string | null)
  const needs_password = !hasPassword || args.purpose === 'forgot_password'

  return { ok: true, user, needs_password }
}
