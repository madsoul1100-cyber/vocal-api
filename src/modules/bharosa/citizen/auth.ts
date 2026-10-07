import crypto from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'
import jwt from 'jsonwebtoken'
import { dbQuery } from '@/lib/db.js'
import { smsProvider } from '@/lib/otp/delivery.js'
import { exposeDevOtpInApi, otpAppName, resolveOtpDeliveryMode } from '@/lib/otp/config.js'
import { normalizePhone } from '@/services/otpService.js'
import { HttpError } from '../common.js'
import { getBharosaSettings } from '../settings.js'

const CITIZEN_AUDIENCE = 'bharosa-citizen'
const CITIZEN_TOKEN_TTL = process.env.CITIZEN_JWT_EXPIRES_IN?.trim() || '30d'

function secret(): string {
  const s = process.env.JWT_SECRET ?? ''
  if (s.length < 32) throw new HttpError(500, 'JWT_SECRET must be set (min 32 characters)')
  return s
}

function hashCode(phone: string, code: string): string {
  return crypto.createHmac('sha256', secret()).update(`${phone}:${code}`).digest('hex')
}

export function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex')
}

function maskPhone(p: string): string {
  return `${p.slice(0, 3)}******${p.slice(-4)}`
}

export interface CitizenRow {
  id: string
  organization_id: string
  display_name: string | null
  phone_e164: string | null
  email: string | null
  preferred_language: string
  phone_verified_at: string | null
  whatsapp_opt_in: boolean
  blocked_at: string | null
}

export async function requestCitizenOtp(args: {
  orgId: string
  phoneRaw: string
  ip: string
}): Promise<{ sent: true; masked_phone: string; expires_in_seconds: number; resend_after_seconds: number; dev_code?: string }> {
  const phone = normalizePhone(args.phoneRaw)
  if (!phone) throw new HttpError(400, 'Enter a valid mobile number', 'INVALID_PHONE')
  const settings = await getBharosaSettings(args.orgId)
  const { otp } = settings

  const blocked = await dbQuery(
    `SELECT 1 FROM citizens WHERE organization_id = $1 AND phone_e164 = $2 AND blocked_at IS NOT NULL`,
    [args.orgId, phone],
  )
  if (blocked.rowCount) throw new HttpError(403, 'This number cannot submit right now. Contact support.', 'BLOCKED')

  const stats = await dbQuery<{ phone_hour: string; ip_hour: string; last_at: string | null }>(
    `SELECT
       (SELECT COUNT(*) FROM citizen_otps WHERE organization_id = $1 AND phone_e164 = $2 AND created_at > now() - interval '1 hour')::text AS phone_hour,
       (SELECT COUNT(*) FROM citizen_otps WHERE request_ip = $3 AND created_at > now() - interval '1 hour')::text AS ip_hour,
       (SELECT MAX(created_at) FROM citizen_otps WHERE organization_id = $1 AND phone_e164 = $2)::text AS last_at`,
    [args.orgId, phone, args.ip],
  )
  const s = stats.rows[0]
  if (Number(s.phone_hour) >= otp.maxSendsPerPhonePerHour || (args.ip && Number(s.ip_hour) >= otp.maxSendsPerIpPerHour)) {
    throw new HttpError(429, 'Too many codes requested. Try again later or ask for an assisted call.', 'OTP_RATE_LIMIT')
  }
  if (s.last_at) {
    const waited = (Date.now() - new Date(s.last_at).getTime()) / 1000
    if (waited < otp.resendCooldownSeconds) {
      throw new HttpError(429, `Please wait ${Math.ceil(otp.resendCooldownSeconds - waited)} seconds before requesting another code`, 'OTP_COOLDOWN')
    }
  }

  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0')
  const provider = smsProvider()
  const outcome = await provider.send(phone, {
    code,
    purpose: 'login',
    appName: process.env.CITIZEN_OTP_APP_NAME?.trim() || otpAppName(),
    ttlMinutes: otp.ttlMinutes,
  })
  if (!outcome.ok) {
    console.error('[bharosa:otp]', outcome.error)
    throw new HttpError(503, 'Could not send the code. Try again, or request an assisted verification call.', 'OTP_SEND_FAILED')
  }

  await dbQuery(`UPDATE citizen_otps SET consumed_at = now() WHERE organization_id = $1 AND phone_e164 = $2 AND consumed_at IS NULL`, [
    args.orgId,
    phone,
  ])
  await dbQuery(
    `INSERT INTO citizen_otps (organization_id, phone_e164, code_hash, provider, expires_at, request_ip)
     VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5::int), $6)`,
    [args.orgId, phone, hashCode(phone, code), outcome.provider, otp.ttlMinutes, args.ip || null],
  )

  return {
    sent: true,
    masked_phone: maskPhone(phone),
    expires_in_seconds: otp.ttlMinutes * 60,
    resend_after_seconds: otp.resendCooldownSeconds,
    ...(resolveOtpDeliveryMode() === 'console' && exposeDevOtpInApi() ? { dev_code: code } : {}),
  }
}

export async function verifyCitizenOtp(args: {
  orgId: string
  phoneRaw: string
  code: string
  displayName?: string | null
  language?: string | null
}): Promise<{ token: string; citizen: CitizenRow; is_new: boolean }> {
  const phone = normalizePhone(args.phoneRaw)
  if (!phone) throw new HttpError(400, 'Enter a valid mobile number', 'INVALID_PHONE')
  const code = args.code.replace(/\D/g, '')
  if (code.length !== 6) throw new HttpError(400, 'Enter the 6-digit code', 'INVALID_CODE')
  const settings = await getBharosaSettings(args.orgId)

  const row = (
    await dbQuery<{ id: string; code_hash: string; expires_at: string; attempt_count: number }>(
      `SELECT id, code_hash, expires_at, attempt_count FROM citizen_otps
       WHERE organization_id = $1 AND phone_e164 = $2 AND consumed_at IS NULL
       ORDER BY created_at DESC LIMIT 1`,
      [args.orgId, phone],
    )
  ).rows[0]
  if (!row) throw new HttpError(400, 'No active code. Request a new one.', 'OTP_NOT_FOUND')
  if (new Date(row.expires_at).getTime() < Date.now()) throw new HttpError(400, 'Code expired. Request a new one.', 'OTP_EXPIRED')
  if (row.attempt_count >= settings.otp.maxVerifyAttempts) {
    throw new HttpError(429, 'Too many attempts. Request a new code.', 'OTP_TOO_MANY_ATTEMPTS')
  }

  const expected = Buffer.from(row.code_hash, 'hex')
  const actual = Buffer.from(hashCode(phone, code), 'hex')
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    await dbQuery(`UPDATE citizen_otps SET attempt_count = attempt_count + 1 WHERE id = $1`, [row.id])
    throw new HttpError(401, 'Incorrect code', 'OTP_INVALID')
  }
  await dbQuery(`UPDATE citizen_otps SET consumed_at = now(), attempt_count = attempt_count + 1 WHERE id = $1`, [row.id])

  const language = args.language === 'en' ? 'en' : args.language === 'te' ? 'te' : null
  const name = args.displayName?.trim().slice(0, 120) || null

  const existing = (
    await dbQuery<{ id: string }>(
      `SELECT c.id FROM citizens c
       WHERE c.organization_id = $1
         AND (c.phone_e164 = $2 OR EXISTS (
           SELECT 1 FROM citizen_channel_identities i
           WHERE i.citizen_id = c.id AND (i.phone = $2 OR i.channel_user_id = $2)))
       ORDER BY c.created_at ASC LIMIT 1`,
      [args.orgId, phone],
    )
  ).rows[0]

  let citizenId: string
  const isNew = !existing
  if (existing) {
    citizenId = existing.id
    await dbQuery(
      `UPDATE citizens SET phone_e164 = $2, phone_verified_at = now(), verified = true,
              display_name = COALESCE($3, display_name),
              preferred_language = COALESCE($4, preferred_language), updated_at = now()
       WHERE id = $1`,
      [citizenId, phone, name, language],
    )
  } else {
    citizenId = (
      await dbQuery<{ id: string }>(
        `INSERT INTO citizens (organization_id, display_name, phone_e164, phone_verified_at, verified, preferred_language)
         VALUES ($1, $2, $3, now(), true, $4) RETURNING id`,
        [args.orgId, name, phone, language ?? settings.defaultLanguage],
      )
    ).rows[0].id
  }

  await dbQuery(
    `INSERT INTO citizen_channel_identities (citizen_id, channel, channel_user_id, phone)
     VALUES ($1, 'web', $2, $2)
     ON CONFLICT (channel, channel_user_id) DO UPDATE SET last_seen_at = now()`,
    [citizenId, phone],
  )

  const citizen = await loadCitizen(citizenId)
  if (!citizen) throw new HttpError(500, 'Citizen not found after verification')
  return { token: signCitizenToken(citizen), citizen, is_new: isNew }
}

/**
 * Staff-assisted intake (phone call): link to the existing citizen for this
 * number or create one. The phone is NOT marked verified — the case still goes
 * through the verification call.
 */
export async function findOrCreateCitizenByPhone(args: {
  orgId: string
  phoneRaw: string
  displayName?: string | null
  language?: string | null
  channel: 'call' | 'manual'
}): Promise<CitizenRow> {
  const phone = normalizePhone(args.phoneRaw)
  if (!phone) throw new HttpError(400, 'Enter a valid mobile number', 'INVALID_PHONE')
  const language = args.language === 'en' ? 'en' : args.language === 'te' ? 'te' : null
  const name = args.displayName?.trim().slice(0, 120) || null

  const existing = (
    await dbQuery<{ id: string }>(
      `SELECT c.id FROM citizens c
       WHERE c.organization_id = $1
         AND (c.phone_e164 = $2 OR EXISTS (
           SELECT 1 FROM citizen_channel_identities i
           WHERE i.citizen_id = c.id AND (i.phone = $2 OR i.channel_user_id = $2)))
       ORDER BY c.created_at ASC LIMIT 1`,
      [args.orgId, phone],
    )
  ).rows[0]

  let citizenId: string
  if (existing) {
    citizenId = existing.id
    await dbQuery(
      `UPDATE citizens SET phone_e164 = COALESCE(phone_e164, $2), display_name = COALESCE(display_name, $3), updated_at = now() WHERE id = $1`,
      [citizenId, phone, name],
    )
  } else {
    const settings = await getBharosaSettings(args.orgId)
    citizenId = (
      await dbQuery<{ id: string }>(
        `INSERT INTO citizens (organization_id, display_name, phone_e164, preferred_language) VALUES ($1, $2, $3, $4) RETURNING id`,
        [args.orgId, name, phone, language ?? settings.defaultLanguage],
      )
    ).rows[0].id
  }
  await dbQuery(
    `INSERT INTO citizen_channel_identities (citizen_id, channel, channel_user_id, phone)
     VALUES ($1, $2, $3, $3)
     ON CONFLICT (channel, channel_user_id) DO UPDATE SET last_seen_at = now()`,
    [citizenId, args.channel, phone],
  )
  const citizen = await loadCitizen(citizenId)
  if (!citizen) throw new HttpError(500, 'Citizen not found')
  if (citizen.blocked_at) throw new HttpError(403, 'This number is blocked from submitting', 'BLOCKED')
  return citizen
}

export function signCitizenToken(c: { id: string; organization_id: string }): string {
  return jwt.sign({ sub: c.id, orgId: c.organization_id, typ: 'citizen' }, secret(), {
    audience: CITIZEN_AUDIENCE,
    expiresIn: CITIZEN_TOKEN_TTL as jwt.SignOptions['expiresIn'],
  })
}

export async function loadCitizen(id: string): Promise<CitizenRow | null> {
  const res = await dbQuery<CitizenRow>(
    `SELECT id, organization_id, display_name, phone_e164, email, preferred_language, phone_verified_at,
            whatsapp_opt_in, blocked_at
     FROM citizens WHERE id = $1`,
    [id],
  )
  return res.rows[0] ?? null
}

export function citizenFromReq(req: Request): CitizenRow {
  return (req as Request & { citizen: CitizenRow }).citizen
}

export async function requireCitizen(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization
  const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : ''
  if (!token) {
    res.status(401).json({ error: 'Sign in with your mobile number', code: 'CITIZEN_AUTH_REQUIRED' })
    return
  }
  let payload: { sub?: string; typ?: string }
  try {
    payload = jwt.verify(token, secret(), { audience: CITIZEN_AUDIENCE }) as { sub?: string; typ?: string }
  } catch {
    res.status(401).json({ error: 'Session expired. Sign in again.', code: 'CITIZEN_AUTH_INVALID' })
    return
  }
  if (payload.typ !== 'citizen' || !payload.sub) {
    res.status(401).json({ error: 'Invalid session', code: 'CITIZEN_AUTH_INVALID' })
    return
  }
  const citizen = await loadCitizen(payload.sub).catch(() => null)
  if (!citizen) {
    res.status(401).json({ error: 'Account not found', code: 'CITIZEN_AUTH_INVALID' })
    return
  }
  if (citizen.blocked_at) {
    res.status(403).json({ error: 'This account is restricted. Contact support.', code: 'BLOCKED' })
    return
  }
  ;(req as Request & { citizen: CitizenRow }).citizen = citizen
  next()
}

export async function updateCitizenProfile(
  citizenId: string,
  patch: { display_name?: string | null; preferred_language?: string | null; whatsapp_opt_in?: boolean | null; email?: string | null },
): Promise<CitizenRow | null> {
  await dbQuery(
    `UPDATE citizens SET
       display_name = COALESCE($2, display_name),
       preferred_language = COALESCE($3, preferred_language),
       whatsapp_opt_in = COALESCE($4, whatsapp_opt_in),
       email = COALESCE($5, email),
       updated_at = now()
     WHERE id = $1`,
    [citizenId, patch.display_name ?? null, patch.preferred_language ?? null, patch.whatsapp_opt_in ?? null, patch.email ?? null],
  )
  return loadCitizen(citizenId)
}

export async function recordConsents(args: {
  orgId: string
  citizenId: string
  ticketId?: string | null
  consents: Array<{ type: string; granted: boolean; text_version?: string }>
  language?: string | null
  channel?: string
  ip?: string
}): Promise<void> {
  const allowed = new Set([
    'terms', 'privacy', 'share_with_authority', 'contact_by_phone',
    'whatsapp_updates', 'public_status', 'location_exact', 'media_use',
  ])
  for (const c of args.consents) {
    if (!allowed.has(c.type)) continue
    await dbQuery(
      `INSERT INTO citizen_consents (organization_id, citizen_id, ticket_id, consent_type, granted, text_version, language, channel, source_ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [args.orgId, args.citizenId, args.ticketId ?? null, c.type, c.granted, c.text_version ?? 'v1', args.language ?? null, args.channel ?? 'web', args.ip ?? null],
    )
    if (c.type === 'whatsapp_updates') {
      await dbQuery(`UPDATE citizens SET whatsapp_opt_in = $2 WHERE id = $1`, [args.citizenId, c.granted])
    }
  }
}

export async function latestConsent(citizenId: string, type: string, ticketId?: string | null): Promise<boolean | null> {
  const res = await dbQuery<{ granted: boolean }>(
    `SELECT granted FROM citizen_consents
     WHERE citizen_id = $1 AND consent_type = $2 AND ($3::uuid IS NULL OR ticket_id IS NULL OR ticket_id = $3)
     ORDER BY created_at DESC LIMIT 1`,
    [citizenId, type, ticketId ?? null],
  )
  return res.rows[0]?.granted ?? null
}
