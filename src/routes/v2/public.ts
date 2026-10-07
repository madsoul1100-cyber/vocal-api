import { Router, type Request } from 'express'
import { dbQuery } from '@/lib/db.js'
import { tenantApp } from '@/config/tenant.config.js'
import { resolveOtpDeliveryMode } from '@/lib/otp/config.js'
import {
  clientIp,
  HttpError,
  pageParams,
  parseLanguage,
  rateLimit,
  requirePostgres,
  resolvePublicOrgId,
  route,
  str,
  uuidParam,
  type Language,
} from '@/modules/bharosa/common.js'
import { getBharosaSettings } from '@/modules/bharosa/settings.js'
import {
  citizenFromReq,
  requestCitizenOtp,
  requireCitizen,
  updateCitizenProfile,
  verifyCitizenOtp,
} from '@/modules/bharosa/citizen/auth.js'
import {
  claimEmailSubmission,
  completeEvidenceUpload,
  confirmSubmission,
  createSubmission,
  deleteEvidence,
  getSubmissionForCitizen,
  issueEvidenceUploadUrl,
  structureSubmission,
  updateSubmission,
} from '@/modules/bharosa/citizen/submissions.js'
import {
  authoritySuggestionsForCitizen,
  getMyCase,
  getMyCommunication,
  listMyCases,
  publicStats,
  publicStatusByNumber,
  reopenCase,
  requestAuthorityEmail,
  respondToCase,
  submitFeedback,
  trackByToken,
  updateCaseConsents,
} from '@/modules/bharosa/citizen/cases.js'
import {
  approveCommunication,
  citizenView,
  editCommunication,
  rejectCommunication,
} from '@/modules/bharosa/comms/communications.js'
import { listPublicFeed } from '@/modules/bharosa/feed/feed.js'
import { translateTexts } from '@/modules/bharosa/ai/translation.js'

/**
 * Bharosa citizen + public API (`/v2/public`).
 * Tenant: `X-Org-Slug` header (or `?org=`), falling back to ORG_ID.
 * Citizen routes: `Authorization: Bearer <citizen token>` from /auth/otp/verify.
 */
const router = Router()
router.use(requirePostgres)

function lang(req: Request, fallback: Language = 'te'): Language {
  const header = req.headers['accept-language']
  const h = typeof header === 'string' ? header.split(',')[0]?.slice(0, 2) : undefined
  return parseLanguage(req.query.lang ?? h, fallback)
}

function citizenLang(req: Request): Language {
  const c = citizenFromReq(req)
  return lang(req, c.preferred_language === 'en' ? 'en' : 'te')
}

const CONSENT_TEXT_VERSION = 'v1'

// ---------------------------------------------------------------------------
// Public (no login)
// ---------------------------------------------------------------------------

router.get(
  '/config',
  route(async (req, res) => {
    const orgId = await resolvePublicOrgId(req)
    const settings = await getBharosaSettings(orgId)
    const cats = await dbQuery<{ id: string; name: string; parent_id: string | null }>(
      `SELECT id, name, parent_id FROM issue_categories
       WHERE active = true AND (organization_id = $1 OR organization_id IS NULL) ORDER BY sort_order, name`,
      [orgId],
    )
    res.json({
      app_name: tenantApp.name,
      languages: settings.languages,
      default_language: settings.defaultLanguage,
      otp: {
        length: 6,
        resend_after_seconds: settings.otp.resendCooldownSeconds,
        ttl_minutes: settings.otp.ttlMinutes,
        mode: resolveOtpDeliveryMode(),
      },
      consents: {
        text_version: CONSENT_TEXT_VERSION,
        required: ['terms', 'privacy'],
        optional: ['share_with_authority', 'whatsapp_updates', 'contact_by_phone', 'public_status', 'location_exact', 'media_use'],
      },
      evidence: { max_files: 10 },
      categories: cats.rows,
      features: {
        whatsapp_updates: settings.notifications.whatsappEnabled,
        verification_call: settings.verification.callAfterCreate,
        public_dashboard: true,
        feed: true,
      },
    })
  }),
)

router.post(
  '/auth/otp/request',
  rateLimit({ windowMs: 60_000, max: 10 }),
  route(async (req, res) => {
    const orgId = await resolvePublicOrgId(req)
    const phone = str(req.body?.phone, 20)
    if (!phone) throw new HttpError(400, 'phone is required', 'INVALID_PHONE')
    res.json(await requestCitizenOtp({ orgId, phoneRaw: phone, ip: clientIp(req) }))
  }),
)

router.post(
  '/auth/otp/verify',
  rateLimit({ windowMs: 60_000, max: 20 }),
  route(async (req, res) => {
    const orgId = await resolvePublicOrgId(req)
    const phone = str(req.body?.phone, 20)
    const code = str(req.body?.code, 10)
    if (!phone || !code) throw new HttpError(400, 'phone and code are required')
    const out = await verifyCitizenOtp({
      orgId, phoneRaw: phone, code, displayName: str(req.body?.display_name, 120), language: str(req.body?.language, 5),
    })
    res.json({ token: out.token, is_new: out.is_new, citizen: publicCitizen(out.citizen) })
  }),
)

router.get(
  '/track/:token',
  rateLimit({ windowMs: 60_000, max: 60 }),
  route(async (req, res) => {
    const orgId = await resolvePublicOrgId(req)
    res.json(await trackByToken(orgId, String(req.params.token), lang(req)))
  }),
)

router.get(
  '/status/:ticketNumber',
  rateLimit({ windowMs: 60_000, max: 30 }),
  route(async (req, res) => {
    const orgId = await resolvePublicOrgId(req)
    res.json(await publicStatusByNumber(orgId, String(req.params.ticketNumber), lang(req)))
  }),
)

const statsCache = new Map<string, { at: number; data: unknown }>()
router.get(
  '/stats',
  route(async (req, res) => {
    const orgId = await resolvePublicOrgId(req)
    const l = lang(req)
    const key = `${orgId}:${l}`
    const hit = statsCache.get(key)
    if (hit && Date.now() - hit.at < 5 * 60_000) {
      res.json(hit.data)
      return
    }
    const data = await publicStats(orgId, l)
    statsCache.set(key, { at: Date.now(), data })
    res.json(data)
  }),
)

router.get(
  '/feed',
  route(async (req, res) => {
    const orgId = await resolvePublicOrgId(req)
    const { limit, offset, page } = pageParams(req.query as Record<string, unknown>)
    const language = req.query.lang === 'te' || req.query.lang === 'en' ? (req.query.lang as string) : null
    res.json({ items: await listPublicFeed(orgId, { limit, offset, language }), page, limit })
  }),
)

// ---------------------------------------------------------------------------
// Citizen (OTP login)
// ---------------------------------------------------------------------------

function publicCitizen(c: ReturnType<typeof citizenFromReq>) {
  return {
    id: c.id,
    display_name: c.display_name,
    phone: c.phone_e164,
    email: c.email,
    preferred_language: c.preferred_language,
    whatsapp_opt_in: c.whatsapp_opt_in,
    phone_verified_at: c.phone_verified_at,
  }
}

const citizen = Router()
citizen.use(requireCitizen)

citizen.get('/me', route(async (req, res) => {
  res.json({ citizen: publicCitizen(citizenFromReq(req)) })
}))

citizen.patch('/me', route(async (req, res) => {
  const c = citizenFromReq(req)
  const b = req.body ?? {}
  const email = str(b.email, 200)
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Invalid email')
  const updated = await updateCitizenProfile(c.id, {
    display_name: str(b.display_name, 120),
    preferred_language: b.preferred_language === 'en' || b.preferred_language === 'te' ? b.preferred_language : null,
    whatsapp_opt_in: typeof b.whatsapp_opt_in === 'boolean' ? b.whatsapp_opt_in : null,
    email,
  })
  res.json({ citizen: updated ? publicCitizen(updated) : null })
}))

// Submissions (intake wizard)
citizen.post('/submissions', route(async (req, res) => {
  res.status(201).json(await createSubmission(citizenFromReq(req), req.body ?? {}))
}))
// Emailed complaint: the link in the acknowledgement email carries a one-time token.
citizen.post('/submissions/claim', rateLimit({ windowMs: 60_000, max: 10, key: (r) => `claim:${citizenFromReq(r).id}` }), route(async (req, res) => {
  res.json(await claimEmailSubmission(citizenFromReq(req), str(req.body?.token, 200) ?? ''))
}))
citizen.get('/submissions/:id', route(async (req, res) => {
  res.json(await getSubmissionForCitizen(citizenFromReq(req), uuidParam(req, 'id')))
}))
citizen.patch('/submissions/:id', route(async (req, res) => {
  res.json(await updateSubmission(citizenFromReq(req), uuidParam(req, 'id'), req.body ?? {}))
}))
citizen.post('/submissions/:id/evidence/upload-url', route(async (req, res) => {
  res.json(await issueEvidenceUploadUrl(citizenFromReq(req), uuidParam(req, 'id'), req.body ?? {}))
}))
citizen.post('/submissions/:id/evidence', route(async (req, res) => {
  res.status(201).json(await completeEvidenceUpload(citizenFromReq(req), uuidParam(req, 'id'), req.body ?? {}))
}))
citizen.delete('/submissions/:id/evidence/:evidenceId', route(async (req, res) => {
  await deleteEvidence(citizenFromReq(req), uuidParam(req, 'id'), uuidParam(req, 'evidenceId'))
  res.status(204).end()
}))
citizen.post('/submissions/:id/structure', rateLimit({ windowMs: 60_000, max: 10, key: (r) => `structure:${citizenFromReq(r).id}` }), route(async (req, res) => {
  res.json(await structureSubmission(citizenFromReq(req), uuidParam(req, 'id')))
}))
citizen.post('/submissions/:id/confirm', route(async (req, res) => {
  res.status(201).json(await confirmSubmission(citizenFromReq(req), uuidParam(req, 'id'), req.body ?? {}, clientIp(req)))
}))

// Cases
citizen.get('/cases', route(async (req, res) => {
  const { limit, offset, page } = pageParams(req.query as Record<string, unknown>)
  res.json({ ...(await listMyCases(citizenFromReq(req), citizenLang(req), limit, offset)), page, limit })
}))
citizen.get('/cases/:id', route(async (req, res) => {
  res.json(await getMyCase(citizenFromReq(req), uuidParam(req, 'id'), citizenLang(req)))
}))
citizen.get('/cases/:id/authority-suggestions', route(async (req, res) => {
  res.json(await authoritySuggestionsForCitizen(citizenFromReq(req), uuidParam(req, 'id'), citizenLang(req)))
}))
citizen.post('/cases/:id/authority-email', rateLimit({ windowMs: 60_000, max: 5, key: (r) => `draft:${citizenFromReq(r).id}` }), route(async (req, res) => {
  res.status(201).json(await requestAuthorityEmail(citizenFromReq(req), uuidParam(req, 'id'), req.body ?? {}, clientIp(req)))
}))
citizen.post('/cases/:id/respond', route(async (req, res) => {
  res.json(await respondToCase(citizenFromReq(req), uuidParam(req, 'id'), req.body ?? {}))
}))
citizen.post('/cases/:id/feedback', route(async (req, res) => {
  res.json(await submitFeedback(citizenFromReq(req), uuidParam(req, 'id'), req.body ?? {}))
}))
citizen.post('/cases/:id/reopen', route(async (req, res) => {
  await reopenCase(citizenFromReq(req), uuidParam(req, 'id'), req.body ?? {})
  res.json({ ok: true })
}))
citizen.put('/cases/:id/consents', route(async (req, res) => {
  res.json(await updateCaseConsents(citizenFromReq(req), uuidParam(req, 'id'), req.body ?? {}, clientIp(req)))
}))

// Citizen-approved authority emails
citizen.patch('/communications/:id', route(async (req, res) => {
  const c = citizenFromReq(req)
  const id = uuidParam(req, 'id')
  await getMyCommunication(c, id)
  const b = req.body ?? {}
  const next = await editCommunication({
    orgId: c.organization_id, id, editorCitizenId: c.id,
    patch: {
      subject: b.subject !== undefined ? str(b.subject, 300) : undefined,
      body: str(b.body, 20_000),
      language: b.language === 'en' || b.language === 'te' ? b.language : null,
    },
  })
  res.json(citizenView(next))
}))
citizen.post('/communications/:id/approve', route(async (req, res) => {
  const c = citizenFromReq(req)
  const id = uuidParam(req, 'id')
  await getMyCommunication(c, id)
  const language = req.body?.language === 'en' || req.body?.language === 'te' ? req.body.language : null
  res.json(citizenView(await approveCommunication({ orgId: c.organization_id, id, approverCitizenId: c.id, language })))
}))
citizen.post('/communications/:id/reject', route(async (req, res) => {
  const c = citizenFromReq(req)
  const id = uuidParam(req, 'id')
  await getMyCommunication(c, id)
  await rejectCommunication({ orgId: c.organization_id, id, citizenId: c.id, reason: str(req.body?.reason, 1000) ?? 'Rejected by citizen' })
  res.json({ ok: true })
}))

citizen.post('/translate', rateLimit({ windowMs: 60_000, max: 30, key: (r) => `tr:${citizenFromReq(r).id}` }), route(async (req, res) => {
  const c = citizenFromReq(req)
  const texts = Array.isArray(req.body?.texts) ? (req.body.texts as unknown[]).map((t) => (typeof t === 'string' ? t.slice(0, 2000) : '')) : []
  if (!texts.length) throw new HttpError(400, 'texts[] is required')
  const target = req.body?.target === 'en' ? 'en' : 'te'
  res.json(await translateTexts({ texts, target, orgId: c.organization_id }))
}))

router.use(citizen)

export default router
