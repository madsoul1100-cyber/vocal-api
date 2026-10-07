import crypto from 'node:crypto'
import { dbQuery } from '@/lib/db.js'
import { createTicket } from '@/services/ticketService.js'
import {
  createTicketAttachmentUploadUrl,
  isValidTicketAttachmentStoragePath,
  verifyTicketAttachmentObject,
} from '@/services/attachmentService.js'
import { resolveIssueCategoryId } from '@/services/ticketIntakeAi.js'
import { tenantApp } from '@/config/tenant.config.js'
import { HttpError, num, str } from '../common.js'
import { recordCaseEvent } from '../cases/events.js'
import { enqueueJob } from '../jobs/queue.js'
import { runStructuringAgent, type StructuredFacts } from '../ai/structuringAgent.js'
import { sendEmail } from '../comms/emailProvider.js'
import { findOrCreateCitizenByPhone, loadCitizen, recordConsents, sha256, type CitizenRow } from './auth.js'

export interface LocationInput {
  text?: string | null
  latitude?: number | null
  longitude?: number | null
  source?: 'gps' | 'map_pin' | 'typed' | 'whatsapp_pin' | null
  precision_m?: number | null
}

function parseLocation(raw: unknown): LocationInput {
  if (!raw || typeof raw !== 'object') return {}
  const r = raw as Record<string, unknown>
  const lat = num(r.latitude ?? r.lat)
  const lng = num(r.longitude ?? r.lng)
  const validCoords = lat !== null && lng !== null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
  const source = str(r.source, 20)
  return {
    text: str(r.text, 500),
    latitude: validCoords ? lat : null,
    longitude: validCoords ? lng : null,
    source: (['gps', 'map_pin', 'typed', 'whatsapp_pin'].includes(source ?? '') ? source : null) as LocationInput['source'],
    precision_m: num(r.precision_m ?? r.accuracy),
  }
}

const SUBMISSION_COLUMNS = `id, organization_id, citizen_id, channel, status, language, raw_text, category_hint,
  issue_location_text, issue_latitude, issue_longitude, issue_location_source, issue_location_precision_m,
  reporter_location_text, reporter_latitude, reporter_longitude, reporter_location_source, reporter_location_precision_m,
  structured_json, citizen_answers_json, ticket_id, rejection_reason, confirmed_at, created_at, updated_at,
  subject, contact_name, contact_email, contact_phone, created_by_user_id`

export interface SubmissionRow {
  id: string
  organization_id: string
  citizen_id: string | null
  channel: string
  status: string
  language: string
  raw_text: string | null
  category_hint: string | null
  issue_location_text: string | null
  issue_latitude: number | null
  issue_longitude: number | null
  issue_location_source: string | null
  issue_location_precision_m: number | null
  reporter_location_text: string | null
  reporter_latitude: number | null
  reporter_longitude: number | null
  reporter_location_source: string | null
  reporter_location_precision_m: number | null
  structured_json: StructuredFacts | null
  citizen_answers_json: Record<string, string> | null
  ticket_id: string | null
  rejection_reason: string | null
  confirmed_at: string | null
  created_at: string
  updated_at: string
  subject: string | null
  contact_name: string | null
  contact_email: string | null
  contact_phone: string | null
  created_by_user_id: string | null
}

async function loadOwnSubmission(citizen: CitizenRow, id: string): Promise<SubmissionRow> {
  const res = await dbQuery<SubmissionRow>(
    `SELECT ${SUBMISSION_COLUMNS} FROM submissions WHERE id = $1 AND organization_id = $2 AND citizen_id = $3`,
    [id, citizen.organization_id, citizen.id],
  )
  const row = res.rows[0]
  if (!row) throw new HttpError(404, 'Submission not found')
  return row
}

export async function listEvidence(submissionId: string) {
  const res = await dbQuery(
    `SELECT id, file_name, mime_type, file_size_bytes, captured_at, created_at FROM submission_evidence
     WHERE submission_id = $1 ORDER BY created_at`,
    [submissionId],
  )
  return res.rows
}

export async function getSubmissionForCitizen(citizen: CitizenRow, id: string) {
  const sub = await loadOwnSubmission(citizen, id)
  return { ...sub, evidence: await listEvidence(id) }
}

export async function createSubmission(citizen: CitizenRow, body: Record<string, unknown>) {
  const description = str(body.description, 8000)
  if (!description || description.length < 10) {
    throw new HttpError(400, 'Describe the problem in a few words (at least 10 characters)', 'DESCRIPTION_REQUIRED')
  }
  const language = body.language === 'en' ? 'en' : body.language === 'te' ? 'te' : citizen.preferred_language
  const issue = parseLocation(body.issue_location)
  const reporter = parseLocation(body.reporter_location)
  const idem = str(body.idempotency_key, 100)

  if (idem) {
    const prior = await dbQuery<SubmissionRow>(
      `SELECT ${SUBMISSION_COLUMNS} FROM submissions WHERE organization_id = $1 AND idempotency_key = $2`,
      [citizen.organization_id, idem],
    )
    if (prior.rows[0]) {
      if (prior.rows[0].citizen_id !== citizen.id) throw new HttpError(409, 'Idempotency key already used')
      return { ...prior.rows[0], evidence: await listEvidence(prior.rows[0].id) }
    }
  }

  const res = await dbQuery<SubmissionRow>(
    `INSERT INTO submissions (organization_id, citizen_id, channel, language, raw_text, category_hint,
        issue_location_text, issue_latitude, issue_longitude, issue_location_source, issue_location_precision_m,
        reporter_location_text, reporter_latitude, reporter_longitude, reporter_location_source, reporter_location_precision_m,
        idempotency_key)
     VALUES ($1,$2,'web',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     RETURNING ${SUBMISSION_COLUMNS}`,
    [
      citizen.organization_id, citizen.id, language, description, str(body.category_hint, 200),
      issue.text ?? null, issue.latitude ?? null, issue.longitude ?? null, issue.source ?? null, issue.precision_m ?? null,
      reporter.text ?? null, reporter.latitude ?? null, reporter.longitude ?? null, reporter.source ?? null, reporter.precision_m ?? null,
      idem,
    ],
  )
  return { ...res.rows[0], evidence: [] }
}

export async function updateSubmission(citizen: CitizenRow, id: string, body: Record<string, unknown>) {
  const sub = await loadOwnSubmission(citizen, id)
  await patchSubmission(sub, body)
  return getSubmissionForCitizen(citizen, id)
}

async function patchSubmission(sub: SubmissionRow, body: Record<string, unknown>): Promise<void> {
  const id = sub.id
  if (!['draft', 'structured'].includes(sub.status)) throw new HttpError(409, 'Submission can no longer be edited')

  const sets: string[] = []
  const params: unknown[] = [id]
  const set = (col: string, val: unknown) => {
    params.push(val)
    sets.push(`${col} = $${params.length}`)
  }
  if (body.description !== undefined) set('raw_text', str(body.description, 8000))
  if (body.category_hint !== undefined) set('category_hint', str(body.category_hint, 200))
  if (body.language !== undefined) set('language', body.language === 'en' ? 'en' : 'te')
  if (body.issue_location !== undefined) {
    const l = parseLocation(body.issue_location)
    set('issue_location_text', l.text ?? null)
    set('issue_latitude', l.latitude ?? null)
    set('issue_longitude', l.longitude ?? null)
    set('issue_location_source', l.source ?? null)
    set('issue_location_precision_m', l.precision_m ?? null)
  }
  if (body.reporter_location !== undefined) {
    const l = parseLocation(body.reporter_location)
    set('reporter_location_text', l.text ?? null)
    set('reporter_latitude', l.latitude ?? null)
    set('reporter_longitude', l.longitude ?? null)
    set('reporter_location_source', l.source ?? null)
    set('reporter_location_precision_m', l.precision_m ?? null)
  }
  if (body.answers && typeof body.answers === 'object') {
    const answers: Record<string, string> = { ...(sub.citizen_answers_json ?? {}) }
    for (const [k, v] of Object.entries(body.answers as Record<string, unknown>)) {
      const s = str(v, 1000)
      if (s) answers[k.slice(0, 60)] = s
    }
    set('citizen_answers_json', JSON.stringify(answers))
  }
  if (!sets.length) return
  await dbQuery(`UPDATE submissions SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params)
}

function evidenceScope(submissionId: string): string {
  return `sub-${submissionId}`
}

export async function issueEvidenceUploadUrl(citizen: CitizenRow, id: string, body: Record<string, unknown>) {
  const sub = await loadOwnSubmission(citizen, id)
  if (!['draft', 'structured'].includes(sub.status)) throw new HttpError(409, 'Submission is closed for uploads')
  const count = await dbQuery<{ c: string }>(`SELECT COUNT(*)::text AS c FROM submission_evidence WHERE submission_id = $1`, [id])
  if (Number(count.rows[0].c) >= 10) throw new HttpError(400, 'Maximum 10 files per complaint')

  const file_name = str(body.file_name, 200) ?? 'evidence'
  const mime_type = str(body.mime_type, 100) ?? ''
  const file_size_bytes = num(body.file_size_bytes) ?? 0
  const result = await createTicketAttachmentUploadUrl({
    org_id: citizen.organization_id,
    ticket_id: evidenceScope(id),
    file_name,
    mime_type,
    file_size_bytes,
  })
  if ('error' in result) throw new HttpError(400, result.error)
  return result
}

export async function completeEvidenceUpload(citizen: CitizenRow, id: string, body: Record<string, unknown>) {
  await loadOwnSubmission(citizen, id)
  const storage_path = str(body.storage_path, 500)
  if (!storage_path || !isValidTicketAttachmentStoragePath(storage_path, citizen.organization_id, evidenceScope(id))) {
    throw new HttpError(400, 'Invalid storage_path')
  }
  if (!(await verifyTicketAttachmentObject(storage_path))) throw new HttpError(400, 'Upload not found in storage')
  const res = await dbQuery(
    `INSERT INTO submission_evidence (submission_id, file_name, storage_path, mime_type, file_size_bytes, sha256, captured_at, latitude, longitude)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, file_name, mime_type, file_size_bytes, created_at`,
    [
      id,
      str(body.file_name, 200) ?? 'evidence',
      storage_path,
      str(body.mime_type, 100),
      num(body.file_size_bytes),
      str(body.sha256, 64),
      str(body.captured_at, 40),
      num(body.latitude),
      num(body.longitude),
    ],
  )
  return res.rows[0]
}

export async function deleteEvidence(citizen: CitizenRow, id: string, evidenceId: string) {
  const sub = await loadOwnSubmission(citizen, id)
  if (!['draft', 'structured'].includes(sub.status)) throw new HttpError(409, 'Submission is closed for edits')
  await dbQuery(`DELETE FROM submission_evidence WHERE id = $1 AND submission_id = $2`, [evidenceId, id])
}

export async function structureSubmission(citizen: CitizenRow, id: string) {
  return structureLoaded(await loadOwnSubmission(citizen, id))
}

export async function structureLoaded(sub: SubmissionRow) {
  const id = sub.id
  if (!['draft', 'structured'].includes(sub.status)) throw new HttpError(409, 'Submission already confirmed')
  if (!sub.raw_text) throw new HttpError(400, 'Description is required')
  const evidence = await listEvidence(id)
  const { facts, runId, fallback } = await runStructuringAgent({
    orgId: sub.organization_id,
    submissionId: id,
    text: sub.raw_text,
    language: sub.language,
    issueLocationText: sub.issue_location_text,
    categoryHint: sub.category_hint,
    answers: sub.citizen_answers_json,
    evidenceCount: evidence.length,
  })
  await dbQuery(
    `UPDATE submissions SET structured_json = $2, ai_run_id = $3, status = 'structured', updated_at = now() WHERE id = $1`,
    [id, JSON.stringify(facts), runId],
  )
  return { submission_id: id, structured: facts, ai_fallback: fallback, ai_run_id: runId }
}

function newTrackingToken(): { token: string; hash: string } {
  const token = crypto.randomBytes(24).toString('base64url')
  return { token, hash: sha256(token) }
}

/**
 * Citizen confirms the structured summary → canonical case (ticket) is created.
 * Evidence moves to ticket_attachments; downstream AI/routing runs as jobs.
 */
export async function confirmSubmission(
  citizen: CitizenRow,
  id: string,
  body: Record<string, unknown>,
  ip: string,
) {
  const sub = await loadOwnSubmission(citizen, id)
  return convertSubmission(citizen, sub, body, ip, {
    channel: sub.channel === 'email' ? 'email' : 'web',
    actor: { type: 'citizen' },
    phoneVerified: true,
  })
}

interface ConvertOptions {
  channel: 'web' | 'email' | 'call'
  actor: { type: 'citizen' } | { type: 'user'; userId: string }
  /** True when the citizen proved the phone by OTP; otherwise verification must establish it. */
  phoneVerified: boolean
}

async function convertSubmission(
  citizen: CitizenRow,
  sub: SubmissionRow,
  body: Record<string, unknown>,
  ip: string,
  opts: ConvertOptions,
) {
  const id = sub.id
  if (sub.status === 'converted' && sub.ticket_id) {
    const t = await dbQuery<{ ticket_number: string }>(`SELECT ticket_number FROM tickets WHERE id = $1`, [sub.ticket_id])
    return { ticket_id: sub.ticket_id, ticket_number: t.rows[0]?.ticket_number, tracking_token: null, already_confirmed: true }
  }
  if (sub.status !== 'structured' || !sub.structured_json) {
    throw new HttpError(409, 'Review the AI summary first (POST /structure)', 'NOT_STRUCTURED')
  }

  const consents = Array.isArray(body.consents) ? (body.consents as Array<Record<string, unknown>>) : []
  const consentMap = new Map(consents.map((c) => [String(c.type), c.granted === true]))
  if (!consentMap.get('terms') || !consentMap.get('privacy')) {
    throw new HttpError(400, 'Accept the terms and privacy notice to submit', 'CONSENT_REQUIRED')
  }

  const facts = { ...sub.structured_json }
  const edits = (body.edits && typeof body.edits === 'object' ? body.edits : {}) as Record<string, unknown>
  const lang = sub.language === 'en' ? 'en' : 'te'
  const title = str(edits.title, 200) ?? facts.title[lang] ?? facts.title.en
  const summary = str(edits.summary, 4000) ?? facts.summary[lang] ?? facts.summary.en
  const categoryLabel = str(edits.category, 200) ?? facts.category ?? sub.category_hint
  const citizenEdited = !!(edits.title || edits.summary || edits.category)

  const issueText = [sub.raw_text, sub.citizen_answers_json ? Object.entries(sub.citizen_answers_json).map(([k, v]) => `${k}: ${v}`).join('\n') : null]
    .filter(Boolean)
    .join('\n\n')

  const staffUserId = opts.actor.type === 'user' ? opts.actor.userId : null
  const created = await createTicket({
    organizationId: citizen.organization_id,
    sourceChannel: opts.channel,
    citizenId: citizen.id,
    anonymousFlag: false,
    originalIssueText: issueText,
    title,
    locationText: sub.issue_location_text ?? facts.issue_location?.text ?? undefined,
    latitude: sub.issue_latitude ?? undefined,
    longitude: sub.issue_longitude ?? undefined,
    createdBySystem: !staffUserId,
    createdByUserId: staffUserId,
    stageHistoryReason: staffUserId
      ? `Staff logged ${opts.channel} complaint and confirmed AI summary with the citizen`
      : `Citizen confirmed AI-structured submission (${opts.channel}, OTP verified)`,
  })
  if (!created.success) throw new HttpError(500, created.error ?? 'Could not create case')

  const ticketId = created.ticketId
  const tracking = newTrackingToken()
  const category = categoryLabel ? await resolveIssueCategoryId(citizen.organization_id, categoryLabel) : null
  const shareExact = consentMap.get('location_exact') !== false

  await dbQuery(
    `UPDATE tickets SET
       normalized_summary = $2, category_id = COALESCE($3, category_id), severity = COALESCE(severity, $4),
       language = $5, issue_location_source = $6, issue_location_precision_m = $7,
       reporter_location_text = $8, reporter_latitude = $9, reporter_longitude = $10,
       reporter_location_source = $11, reporter_location_precision_m = $12,
       verification_status = 'in_verification', structured_facts_json = $13, citizen_confirmed_at = now(),
       tracking_token_hash = $14, public_status_enabled = $15,
       public_use_consent_status = CASE WHEN $16 THEN 'granted' ELSE 'denied' END,
       critical_flag = critical_flag OR $17, updated_at = now()
     WHERE id = $1`,
    [
      ticketId, summary, category?.id ?? null, facts.severity, sub.language,
      sub.issue_location_source, sub.issue_location_precision_m,
      sub.reporter_location_text,
      shareExact ? sub.reporter_latitude : null,
      shareExact ? sub.reporter_longitude : null,
      sub.reporter_location_source, sub.reporter_location_precision_m,
      JSON.stringify({ ...facts, citizen_edited: citizenEdited, citizen_edits: citizenEdited ? edits : undefined }),
      tracking.hash,
      consentMap.get('public_status') === true,
      consentMap.get('media_use') === true,
      facts.severity === 'critical' || facts.safety_risk === true,
    ],
  )

  await dbQuery(
    `INSERT INTO ticket_attachments (ticket_id, file_name, storage_path, mime_type, file_size_bytes, attachment_type, visibility, sha256, provenance)
     SELECT $1, e.file_name, e.storage_path, e.mime_type, e.file_size_bytes,
            CASE WHEN e.mime_type LIKE 'image/%' THEN 'image' WHEN e.mime_type LIKE 'video/%' THEN 'video'
                 WHEN e.mime_type LIKE 'audio/%' THEN 'audio' WHEN e.mime_type = 'application/pdf' THEN 'document' ELSE 'other' END,
            'citizen', e.sha256, $3::text
     FROM submission_evidence e WHERE e.submission_id = $2`,
    [ticketId, id, opts.channel === 'call' ? 'staff_call_upload' : `citizen_${opts.channel}_upload`],
  )

  await dbQuery(
    `UPDATE submissions SET status = 'converted', ticket_id = $2, confirmed_at = now(), updated_at = now() WHERE id = $1`,
    [id, ticketId],
  )

  await recordConsents({
    orgId: citizen.organization_id,
    citizenId: citizen.id,
    ticketId,
    consents: consents.map((c) => ({ type: String(c.type), granted: c.granted === true, text_version: str(c.text_version, 20) ?? 'v1' })),
    language: sub.language,
    channel: opts.channel === 'call' ? 'call_verbal' : opts.channel,
    ip,
  })

  if (opts.phoneVerified) {
    await dbQuery(
      `INSERT INTO verification_checks (organization_id, ticket_id, citizen_id, method, status, mode, provider, result_json, completed_at)
       VALUES ($1, $2, $3, 'otp', 'passed', 'automated', 'citizen_otp', $4, now())`,
      [citizen.organization_id, ticketId, citizen.id, JSON.stringify({ phone_verified_at: citizen.phone_verified_at })],
    )
  }

  await recordCaseEvent({
    orgId: citizen.organization_id,
    ticketId,
    type: 'case_created',
    actorType: staffUserId ? 'user' : 'citizen',
    actorCitizenId: staffUserId ? null : citizen.id,
    actorUserId: staffUserId,
    visibility: 'citizen',
    language: sub.language,
    summary: sub.language === 'te' ? `మీ ఫిర్యాదు ${created.ticketNumber} నమోదు చేయబడింది.` : `Your complaint ${created.ticketNumber} has been registered.`,
    data: {
      submission_id: id, channel: opts.channel, phone_verified: opts.phoneVerified,
      ai_summary_edited: citizenEdited, evidence_count: (await listEvidence(id)).length,
    },
  })

  await enqueueJob({
    type: 'post_case_create',
    orgId: citizen.organization_id,
    payload: { ticket_id: ticketId, force_verification_call: !opts.phoneVerified },
    idempotencyKey: `post_case_create:${ticketId}`,
  })

  return {
    ticket_id: ticketId,
    ticket_number: created.ticketNumber,
    tracking_token: tracking.token,
    already_confirmed: false,
  }
}

// ---------------------------------------------------------------------------
// Assisted intake (citizen phoned in; staff logs the complaint)
// ---------------------------------------------------------------------------

async function loadAssistedSubmission(orgId: string, id: string): Promise<SubmissionRow> {
  const res = await dbQuery<SubmissionRow>(
    `SELECT ${SUBMISSION_COLUMNS} FROM submissions WHERE id = $1 AND organization_id = $2 AND channel = 'call'`,
    [id, orgId],
  )
  if (!res.rows[0]) throw new HttpError(404, 'Submission not found')
  return res.rows[0]
}

async function citizenForSubmission(sub: SubmissionRow): Promise<CitizenRow> {
  if (!sub.citizen_id) throw new HttpError(409, 'Submission has no citizen')
  const c = await loadCitizen(sub.citizen_id)
  if (!c) throw new HttpError(404, 'Citizen not found')
  return c
}

/** Staff starts an assisted intake: creates the draft and runs AI structuring in one step. */
export async function createAssistedSubmission(user: { id: string; organization_id: string }, body: Record<string, unknown>) {
  const phone = str(body.phone, 20)
  if (!phone) throw new HttpError(400, 'Citizen phone number is required', 'INVALID_PHONE')
  const description = str(body.description, 8000)
  if (!description || description.length < 10) throw new HttpError(400, 'Describe the problem (at least 10 characters)', 'DESCRIPTION_REQUIRED')
  const language = body.language === 'en' ? 'en' : 'te'
  const citizen = await findOrCreateCitizenByPhone({
    orgId: user.organization_id, phoneRaw: phone, displayName: str(body.citizen_name, 120), language, channel: 'call',
  })
  const issue = parseLocation(body.issue_location)
  const res = await dbQuery<SubmissionRow>(
    `INSERT INTO submissions (organization_id, citizen_id, channel, language, raw_text, category_hint,
        issue_location_text, issue_latitude, issue_longitude, issue_location_source, issue_location_precision_m,
        contact_name, contact_phone, created_by_user_id, idempotency_key)
     VALUES ($1,$2,'call',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING ${SUBMISSION_COLUMNS}`,
    [
      user.organization_id, citizen.id, language, description, str(body.category_hint, 200),
      issue.text ?? null, issue.latitude ?? null, issue.longitude ?? null, issue.source ?? 'typed', issue.precision_m ?? null,
      str(body.citizen_name, 120), citizen.phone_e164, user.id, str(body.idempotency_key, 100),
    ],
  )
  const sub = res.rows[0]
  const structured = await structureLoaded(sub)
  return {
    ...structured,
    citizen: { id: citizen.id, display_name: citizen.display_name, phone: citizen.phone_e164, phone_verified: !!citizen.phone_verified_at },
  }
}

export async function getAssistedSubmission(orgId: string, id: string) {
  const sub = await loadAssistedSubmission(orgId, id)
  return { ...sub, evidence: await listEvidence(id) }
}

export async function updateAssistedSubmission(orgId: string, id: string, body: Record<string, unknown>) {
  const sub = await loadAssistedSubmission(orgId, id)
  await patchSubmission(sub, body)
  if (body.restructure === true) return structureLoaded(await loadAssistedSubmission(orgId, id))
  return getAssistedSubmission(orgId, id)
}

export async function issueAssistedEvidenceUploadUrl(orgId: string, id: string, body: Record<string, unknown>) {
  const sub = await loadAssistedSubmission(orgId, id)
  return issueEvidenceUploadUrl(await citizenForSubmission(sub), id, body)
}

export async function completeAssistedEvidenceUpload(orgId: string, id: string, body: Record<string, unknown>) {
  const sub = await loadAssistedSubmission(orgId, id)
  return completeEvidenceUpload(await citizenForSubmission(sub), id, body)
}

/**
 * Staff read back the AI summary to the citizen and recorded verbal consent.
 * The phone is unverified, so a verification call is always started.
 */
export async function confirmAssistedSubmission(user: { id: string; organization_id: string }, id: string, body: Record<string, unknown>, ip: string) {
  const sub = await loadAssistedSubmission(user.organization_id, id)
  const citizen = await citizenForSubmission(sub)
  return convertSubmission(citizen, sub, body, ip, { channel: 'call', actor: { type: 'user', userId: user.id }, phoneVerified: false })
}

// ---------------------------------------------------------------------------
// Email intake (citizen emailed the intake address)
// ---------------------------------------------------------------------------

const EMAIL_INTAKE_PER_SENDER_PER_DAY = 5
const CLAIM_TTL_DAYS = 14

/**
 * Inbound email that is not a reply to an authority thread. Becomes a draft
 * submission; a job structures it and emails the sender a link to verify their
 * mobile and confirm. Nothing becomes a case without OTP.
 */
export async function createEmailSubmission(args: {
  orgId: string
  fromEmail: string
  fromName: string | null
  subject: string | null
  text: string
  messageId: string | null
}): Promise<{ created: boolean; submission_id?: string; reason?: string }> {
  const email = args.fromEmail.trim().toLowerCase()
  if (/^(mailer-daemon|postmaster|no-?reply|do-?not-?reply|bounce)/i.test(email.split('@')[0] ?? '')) {
    return { created: false, reason: 'automated_sender' }
  }
  const body = args.text.trim()
  if (body.length < 10) return { created: false, reason: 'empty' }

  if (args.messageId) {
    const dup = await dbQuery<{ id: string }>(
      `SELECT id FROM submissions WHERE organization_id = $1 AND inbound_message_id = $2`,
      [args.orgId, args.messageId],
    )
    if (dup.rows[0]) return { created: false, submission_id: dup.rows[0].id, reason: 'duplicate' }
  }
  const recent = await dbQuery<{ c: number }>(
    `SELECT COUNT(*)::int AS c FROM submissions WHERE organization_id = $1 AND lower(contact_email) = $2 AND created_at > now() - interval '1 day'`,
    [args.orgId, email],
  )
  if (recent.rows[0].c >= EMAIL_INTAKE_PER_SENDER_PER_DAY) return { created: false, reason: 'rate_limited' }

  const language = /[\u0C00-\u0C7F]/.test(body) ? 'te' : 'en'
  const raw = [args.subject?.trim(), body].filter(Boolean).join('\n\n').slice(0, 8000)
  const res = await dbQuery<{ id: string }>(
    `INSERT INTO submissions (organization_id, channel, language, raw_text, subject, contact_email, contact_name, inbound_message_id)
     VALUES ($1,'email',$2,$3,$4,$5,$6,$7)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [args.orgId, language, raw, args.subject?.slice(0, 300) ?? null, email, args.fromName?.slice(0, 120) ?? null, args.messageId],
  )
  const id = res.rows[0]?.id
  if (!id) return { created: false, reason: 'duplicate' }
  await enqueueJob({ type: 'structure_submission', orgId: args.orgId, payload: { submission_id: id }, idempotencyKey: `structure_submission:${id}` })
  return { created: true, submission_id: id }
}

/** Job: structure an emailed complaint and send the sender a "finish your complaint" link. */
export async function processEmailSubmission(submissionId: string) {
  const res = await dbQuery<SubmissionRow>(`SELECT ${SUBMISSION_COLUMNS} FROM submissions WHERE id = $1`, [submissionId])
  const sub = res.rows[0]
  if (!sub) return { skipped: 'not_found' }
  if (sub.channel !== 'email' || !sub.contact_email) return { skipped: 'not_email' }
  if (!['draft', 'structured'].includes(sub.status)) return { skipped: sub.status }

  const structured = sub.status === 'draft' ? await structureLoaded(sub) : null
  const facts = structured?.structured ?? sub.structured_json
  const token = crypto.randomBytes(24).toString('base64url')
  await dbQuery(
    `UPDATE submissions SET claim_token_hash = $2, claim_expires_at = now() + make_interval(days => $3::int), updated_at = now() WHERE id = $1`,
    [sub.id, sha256(token), CLAIM_TTL_DAYS],
  )

  const lang = sub.language === 'te' ? 'te' : 'en'
  const base = (process.env.PUBLIC_APP_URL || process.env.CITIZEN_APP_URL || '').replace(/\/$/, '')
  const link = `${base}/complete/${token}`
  const title = facts?.title?.[lang] ?? facts?.title?.en ?? sub.subject ?? ''
  const app = tenantApp.name
  const text =
    lang === 'te'
      ? `నమస్తే${sub.contact_name ? ` ${sub.contact_name}` : ''},\n\nమీ ఫిర్యాదు మాకు అందింది: "${title}".\n\nదీన్ని నమోదు చేయడానికి, మీ మొబైల్ నంబర్‌ను ధృవీకరించి సారాంశాన్ని నిర్ధారించండి (2 నిమిషాలు):\n${link}\n\nఈ లింక్ ${CLAIM_TTL_DAYS} రోజులు చెల్లుతుంది. మీరు ఈ ఫిర్యాదు పంపకపోతే ఈ ఇమెయిల్‌ను విస్మరించండి.\n\n— ${app}`
      : `Hello${sub.contact_name ? ` ${sub.contact_name}` : ''},\n\nWe received your complaint: "${title}".\n\nTo register it, verify your mobile number and confirm the summary (takes 2 minutes):\n${link}\n\nThis link is valid for ${CLAIM_TTL_DAYS} days. If you did not send this complaint, ignore this email.\n\n— ${app}`
  const sent = await sendEmail({
    to: [sub.contact_email],
    subject: lang === 'te' ? `${app}: మీ ఫిర్యాదును పూర్తి చేయండి` : `${app}: finish registering your complaint`,
    text,
    tags: { purpose: 'email_intake_ack', submission: sub.id },
  })
  if (!sent.ok && !sent.permanent) throw new Error(sent.error)
  return { structured: !!structured, ack_sent: sent.ok, ai_fallback: structured?.ai_fallback ?? null }
}

/** Citizen opened the link from the acknowledgement email and signed in by OTP. */
export async function claimEmailSubmission(citizen: CitizenRow, token: string) {
  if (!token || token.length < 16) throw new HttpError(404, 'This link is invalid or has expired', 'CLAIM_INVALID')
  const res = await dbQuery<SubmissionRow & { claim_expires_at: string | null }>(
    `SELECT ${SUBMISSION_COLUMNS}, claim_expires_at FROM submissions
     WHERE organization_id = $1 AND claim_token_hash = $2 AND channel = 'email'`,
    [citizen.organization_id, sha256(token)],
  )
  const sub = res.rows[0]
  if (!sub || !sub.claim_expires_at || new Date(sub.claim_expires_at).getTime() < Date.now()) {
    throw new HttpError(404, 'This link is invalid or has expired', 'CLAIM_INVALID')
  }
  if (sub.citizen_id && sub.citizen_id !== citizen.id) throw new HttpError(409, 'This complaint was already claimed', 'CLAIM_TAKEN')
  if (!['draft', 'structured'].includes(sub.status)) throw new HttpError(409, 'This complaint was already submitted', 'ALREADY_CONFIRMED')
  await dbQuery(
    `UPDATE submissions SET citizen_id = $2, claimed_at = COALESCE(claimed_at, now()), updated_at = now() WHERE id = $1`,
    [sub.id, citizen.id],
  )
  if (!citizen.email && sub.contact_email) {
    await dbQuery(`UPDATE citizens SET email = $2 WHERE id = $1 AND email IS NULL`, [citizen.id, sub.contact_email])
  }
  return getSubmissionForCitizen(citizen, sub.id)
}

export async function rotateTrackingToken(orgId: string, ticketId: string): Promise<string> {
  const t = newTrackingToken()
  await dbQuery(`UPDATE tickets SET tracking_token_hash = $3 WHERE id = $1 AND organization_id = $2`, [ticketId, orgId, t.hash])
  return t.token
}
