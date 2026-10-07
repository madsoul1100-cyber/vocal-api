import crypto from 'node:crypto'
import { dbQuery } from '@/lib/db.js'
import { tenantApp } from '@/config/tenant.config.js'
import { updateTicketStage } from '@/services/ticketService.js'
import { HttpError } from '../common.js'
import { recordCaseEvent } from '../cases/events.js'
import { createEscalation } from '../cases/escalations.js'
import { enqueueJob } from '../jobs/queue.js'
import { getBharosaSettings } from '../settings.js'
import { runContentAgent, type ContentFormat } from '../ai/contentAgent.js'
import { replyToForThread, sendEmail } from './emailProvider.js'
import { sendWhatsApp } from './whatsapp.js'

export type CommChannel = 'email' | 'whatsapp' | 'sms' | 'letter' | 'social_post'
export type CommPurpose =
  | 'authority_complaint' | 'follow_up' | 'escalation' | 'citizen_update'
  | 'information_request' | 'public_post' | 'authority_reply' | 'other'

export interface Recipient {
  contact_id?: string | null
  name: string | null
  email?: string | null
  phone?: string | null
  office?: string | null
  designation?: string | null
  kind: 'to' | 'cc'
}

export interface CommunicationRow {
  id: string
  organization_id: string
  ticket_id: string | null
  task_id: string | null
  channel: CommChannel
  direction: 'outbound' | 'inbound'
  purpose: CommPurpose
  status: string
  approval_by: 'citizen' | 'staff' | 'none'
  language: string
  subject: string | null
  body: string | null
  translations_json: Record<string, { subject?: string | null; body: string }> | null
  recipients_json: Recipient[]
  from_address: string | null
  reply_to_address: string | null
  thread_key: string | null
  version: number
  previous_version_id: string | null
  in_reply_to_id: string | null
  follow_up_of_id: string | null
  follow_up_count: number
  next_follow_up_at: string | null
  follow_up_stopped_at: string | null
  escalation_level: number
  ai_run_id: string | null
  approved_by_user_id: string | null
  approved_by_citizen_id: string | null
  approved_at: string | null
  rejected_reason: string | null
  sent_at: string | null
  delivered_at: string | null
  provider: string | null
  provider_message_id: string | null
  summary_json: Record<string, unknown> | null
  created_by_user_id: string | null
  created_by_citizen_id: string | null
  created_at: string
  updated_at: string
}

const FORMAT_TO_CHANNEL: Record<ContentFormat, CommChannel> = {
  authority_email: 'email',
  follow_up_email: 'email',
  escalation_email: 'email',
  letter: 'letter',
  whatsapp_message: 'whatsapp',
  social_post: 'social_post',
  citizen_update: 'whatsapp',
}

const FORMAT_TO_PURPOSE: Record<ContentFormat, CommPurpose> = {
  authority_email: 'authority_complaint',
  follow_up_email: 'follow_up',
  escalation_email: 'escalation',
  letter: 'authority_complaint',
  whatsapp_message: 'authority_complaint',
  social_post: 'public_post',
  citizen_update: 'citizen_update',
}

function newThreadKey(): string {
  return crypto.randomBytes(8).toString('hex')
}

export async function resolveRecipients(
  orgId: string,
  input: { contact_ids?: unknown; cc_contact_ids?: unknown; emails?: unknown },
): Promise<Recipient[]> {
  const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 10) : [])
  const to = ids(input.contact_ids)
  const cc = ids(input.cc_contact_ids)
  const all = [...to, ...cc]
  const out: Recipient[] = []
  if (all.length) {
    const res = await dbQuery<{ id: string; contact_name: string; email: string | null; phone: string | null; whatsapp: string | null; organization_name: string | null; role_designation: string | null }>(
      `SELECT id, contact_name, email, phone, whatsapp, organization_name, role_designation
       FROM directory_contacts WHERE organization_id = $1 AND id = ANY($2::uuid[]) AND active = true`,
      [orgId, all],
    )
    const byId = new Map(res.rows.map((r) => [r.id, r]))
    for (const id of all) {
      const c = byId.get(id)
      if (!c) throw new HttpError(400, `Unknown directory contact ${id}`)
      out.push({
        contact_id: c.id,
        name: c.contact_name,
        email: c.email,
        phone: c.whatsapp ?? c.phone,
        office: c.organization_name,
        designation: c.role_designation,
        kind: cc.includes(id) && !to.includes(id) ? 'cc' : 'to',
      })
    }
  }
  if (Array.isArray(input.emails)) {
    for (const e of input.emails.slice(0, 5)) {
      if (typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim())) {
        out.push({ name: null, email: e.trim().toLowerCase(), kind: 'to' })
      }
    }
  }
  return out
}

async function addCommEvent(commId: string, type: string, extra: { userId?: string | null; citizenId?: string | null; provider?: string | null; providerEventId?: string | null; data?: unknown } = {}) {
  await dbQuery(
    `INSERT INTO communication_events (communication_id, event_type, provider, provider_event_id, actor_user_id, actor_citizen_id, data_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
    [commId, type, extra.provider ?? null, extra.providerEventId ?? null, extra.userId ?? null, extra.citizenId ?? null, extra.data ? JSON.stringify(extra.data) : null],
  )
}

export async function getCommunication(orgId: string, id: string): Promise<CommunicationRow> {
  const res = await dbQuery<CommunicationRow>(`SELECT * FROM communications WHERE id = $1 AND organization_id = $2`, [id, orgId])
  if (!res.rows[0]) throw new HttpError(404, 'Communication not found')
  return res.rows[0]
}

/** Draft a communication with the content agent. Nothing is sent until approved. */
export async function createDraftCommunication(args: {
  orgId: string
  ticketId: string
  format: ContentFormat
  recipients: Recipient[]
  language: 'en' | 'te'
  approvalBy: 'citizen' | 'staff'
  createdByUserId?: string | null
  createdByCitizenId?: string | null
  taskId?: string | null
  followUpOf?: CommunicationRow | null
  escalationLevel?: number
  instructions?: string | null
  priorThread?: string | null
}): Promise<CommunicationRow> {
  const channel = FORMAT_TO_CHANNEL[args.format]
  if (channel === 'email' && !args.recipients.some((r) => r.email)) {
    throw new HttpError(400, 'At least one recipient with an email address is required', 'NO_EMAIL_RECIPIENT')
  }
  if (channel === 'whatsapp' && args.format === 'whatsapp_message' && !args.recipients.some((r) => r.phone)) {
    throw new HttpError(400, 'At least one recipient with a WhatsApp/phone number is required')
  }

  const followUpNumber = args.followUpOf ? args.followUpOf.follow_up_count + 1 : 1
  const { content, runId, fallback } = await runContentAgent({
    orgId: args.orgId,
    ticketId: args.ticketId,
    format: args.format,
    recipients: args.recipients,
    priorThread: args.priorThread,
    followUpNumber,
    instructions: args.instructions,
  })
  const primary = content.versions[args.language]
  const threadKey = args.followUpOf?.thread_key ?? (channel === 'email' ? newThreadKey() : null)

  const res = await dbQuery<CommunicationRow>(
    `INSERT INTO communications (organization_id, ticket_id, task_id, channel, direction, purpose, status, approval_by,
        language, subject, body, translations_json, recipients_json, thread_key, follow_up_of_id, follow_up_count,
        escalation_level, ai_run_id, created_by_user_id, created_by_citizen_id, summary_json)
     VALUES ($1,$2,$3,$4,'outbound',$5,'pending_approval',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     RETURNING *`,
    [
      args.orgId, args.ticketId, args.taskId ?? null, channel, FORMAT_TO_PURPOSE[args.format], args.approvalBy,
      args.language, primary.subject ?? null, primary.body, JSON.stringify(content.versions), JSON.stringify(args.recipients),
      threadKey, args.followUpOf?.id ?? null, args.followUpOf ? followUpNumber : 0,
      args.escalationLevel ?? args.followUpOf?.escalation_level ?? 1, runId,
      args.createdByUserId ?? null, args.createdByCitizenId ?? null,
      JSON.stringify({ format: args.format, ai_fallback: fallback, warnings: content.warnings }),
    ],
  )
  const comm = res.rows[0]
  await addCommEvent(comm.id, 'created', { userId: args.createdByUserId, citizenId: args.createdByCitizenId, data: { ai_run_id: runId, fallback } })
  await recordCaseEvent({
    orgId: args.orgId,
    ticketId: args.ticketId,
    communicationId: comm.id,
    taskId: args.taskId,
    type: 'communication_drafted',
    actorType: 'ai_agent',
    actorLabel: 'content_agent',
    visibility: 'internal',
    data: { format: args.format, approval_by: args.approvalBy, recipients: args.recipients.map((r) => r.office ?? r.email) },
  })
  if (args.approvalBy === 'citizen') {
    await recordCaseEvent({
      orgId: args.orgId, ticketId: args.ticketId, communicationId: comm.id, type: 'authority_email_draft_ready',
      actorType: 'ai_agent', actorLabel: 'content_agent', visibility: 'citizen', data: { communication_id: comm.id },
    })
  }
  return comm
}

/** Edits create a new version; the old row is kept (superseded) for audit. */
export async function editCommunication(args: {
  orgId: string
  id: string
  editorUserId?: string | null
  editorCitizenId?: string | null
  patch: { subject?: string | null; body?: string | null; language?: 'en' | 'te' | null; recipients?: Recipient[] | null }
}): Promise<CommunicationRow> {
  const old = await getCommunication(args.orgId, args.id)
  if (!['draft', 'pending_approval'].includes(old.status)) throw new HttpError(409, 'Only drafts can be edited')
  if (args.editorCitizenId && old.created_by_citizen_id !== args.editorCitizenId) throw new HttpError(403, 'Not your draft')

  const language = args.patch.language ?? (old.language as 'en' | 'te')
  const translations = { ...(old.translations_json ?? {}) }
  const base = translations[language] ?? { subject: old.subject, body: old.body ?? '' }
  const subject = args.patch.subject !== undefined ? args.patch.subject : base.subject ?? null
  const body = args.patch.body ?? base.body
  translations[language] = { subject, body }
  const recipients = args.patch.recipients ?? old.recipients_json

  await dbQuery(`UPDATE communications SET status = 'superseded', updated_at = now() WHERE id = $1`, [old.id])
  const res = await dbQuery<CommunicationRow>(
    `INSERT INTO communications (organization_id, ticket_id, task_id, channel, direction, purpose, status, approval_by,
        language, subject, body, translations_json, recipients_json, thread_key, version, previous_version_id,
        follow_up_of_id, follow_up_count, escalation_level, ai_run_id, created_by_user_id, created_by_citizen_id, summary_json)
     SELECT organization_id, ticket_id, task_id, channel, direction, purpose, 'pending_approval', approval_by,
        $2, $3, $4, $5, $6, thread_key, version + 1, id,
        follow_up_of_id, follow_up_count, escalation_level, ai_run_id, created_by_user_id, created_by_citizen_id,
        COALESCE(summary_json, '{}'::jsonb) || jsonb_build_object('human_edited', true)
     FROM communications WHERE id = $1
     RETURNING *`,
    [old.id, language, subject, body, JSON.stringify(translations), JSON.stringify(recipients)],
  )
  const next = res.rows[0]
  await addCommEvent(next.id, 'edited', { userId: args.editorUserId, citizenId: args.editorCitizenId, data: { previous_version_id: old.id } })
  if (old.ai_run_id) {
    await dbQuery(`UPDATE ai_runs SET review_decision = 'edited', reviewed_at = now(), reviewed_by = $2 WHERE id = $1 AND review_decision IS NULL`, [
      old.ai_run_id,
      args.editorUserId ?? null,
    ])
  }
  return next
}

export async function approveCommunication(args: {
  orgId: string
  id: string
  approverUserId?: string | null
  approverCitizenId?: string | null
  language?: 'en' | 'te' | null
}): Promise<CommunicationRow> {
  const comm = await getCommunication(args.orgId, args.id)
  if (comm.status !== 'pending_approval' && comm.status !== 'draft') throw new HttpError(409, `Cannot approve a ${comm.status} communication`)
  if (comm.approval_by === 'citizen') {
    if (!args.approverCitizenId) throw new HttpError(403, 'This message must be approved by the citizen')
    const owner = await dbQuery<{ citizen_id: string | null }>(`SELECT citizen_id FROM tickets WHERE id = $1`, [comm.ticket_id])
    if (owner.rows[0]?.citizen_id !== args.approverCitizenId) throw new HttpError(403, 'Not your case')
  } else if (!args.approverUserId) {
    throw new HttpError(403, 'Staff approval required')
  }
  if (comm.created_by_user_id && comm.created_by_user_id === args.approverUserId && comm.purpose === 'public_post') {
    throw new HttpError(403, 'Public posts need approval from a different person')
  }

  let subject = comm.subject
  let body = comm.body
  let language = comm.language
  if (args.language && args.language !== comm.language && comm.translations_json?.[args.language]) {
    language = args.language
    subject = comm.translations_json[args.language].subject ?? subject
    body = comm.translations_json[args.language].body
  }

  const res = await dbQuery<CommunicationRow>(
    `UPDATE communications SET status = 'approved', approved_by_user_id = $3, approved_by_citizen_id = $4, approved_at = now(),
            language = $5, subject = $6, body = $7, updated_at = now()
     WHERE id = $1 AND organization_id = $2 RETURNING *`,
    [comm.id, args.orgId, args.approverUserId ?? null, args.approverCitizenId ?? null, language, subject, body],
  )
  const approved = res.rows[0]
  await addCommEvent(comm.id, 'approved', { userId: args.approverUserId, citizenId: args.approverCitizenId, data: { language } })
  if (comm.ai_run_id) {
    await dbQuery(`UPDATE ai_runs SET review_decision = COALESCE(review_decision, 'accepted'), reviewed_at = now(), reviewed_by = COALESCE(reviewed_by, $2) WHERE id = $1`, [
      comm.ai_run_id,
      args.approverUserId ?? null,
    ])
  }
  if (comm.ticket_id) {
    await recordCaseEvent({
      orgId: args.orgId,
      ticketId: comm.ticket_id,
      communicationId: comm.id,
      type: 'communication_approved',
      actorType: args.approverCitizenId ? 'citizen' : 'user',
      actorUserId: args.approverUserId,
      actorCitizenId: args.approverCitizenId,
      visibility: 'internal',
      data: { channel: comm.channel, purpose: comm.purpose, language },
    })
  }
  if (approved.channel === 'email' || approved.channel === 'whatsapp' || approved.channel === 'sms') {
    await dbQuery(`UPDATE communications SET status = 'queued' WHERE id = $1`, [comm.id])
    await addCommEvent(comm.id, 'queued')
    await enqueueJob({ type: 'send_communication', orgId: args.orgId, payload: { communication_id: comm.id }, idempotencyKey: `send:${comm.id}` })
    approved.status = 'queued'
  }
  return approved
}

export async function rejectCommunication(args: { orgId: string; id: string; userId?: string | null; citizenId?: string | null; reason: string }) {
  const comm = await getCommunication(args.orgId, args.id)
  if (!['pending_approval', 'draft', 'approved'].includes(comm.status)) throw new HttpError(409, `Cannot reject a ${comm.status} communication`)
  await dbQuery(`UPDATE communications SET status = 'rejected', rejected_reason = $2, updated_at = now() WHERE id = $1`, [comm.id, args.reason])
  await addCommEvent(comm.id, 'rejected', { userId: args.userId, citizenId: args.citizenId, data: { reason: args.reason } })
  if (comm.ai_run_id) {
    await dbQuery(`UPDATE ai_runs SET review_decision = 'rejected', review_notes = $2, reviewed_at = now() WHERE id = $1`, [comm.ai_run_id, args.reason])
  }
}

/** Letters and social posts are sent outside the system; staff record when they went out. */
export async function markSentManually(args: { orgId: string; id: string; userId: string; note?: string | null }) {
  const comm = await getCommunication(args.orgId, args.id)
  if (comm.status !== 'approved') throw new HttpError(409, 'Approve before marking as sent')
  await dbQuery(`UPDATE communications SET status = 'sent', sent_at = now(), provider = 'manual', updated_at = now() WHERE id = $1`, [comm.id])
  await addCommEvent(comm.id, 'sent', { userId: args.userId, provider: 'manual', data: { note: args.note ?? null } })
  if (comm.ticket_id) await afterSent(args.orgId, { ...comm, status: 'sent' })
}

function footerFor(lang: string, settingsFooter: { en: string; te: string }, ticketNumber: string | null): string {
  const f = lang === 'te' ? settingsFooter.te : settingsFooter.en
  return `\n\n--\n${f}${ticketNumber ? `\nRef: ${ticketNumber}` : ''}`
}

/** Job handler: deliver an approved communication through its provider. */
export async function deliverCommunication(orgId: string, id: string): Promise<{ status: string; provider?: string }> {
  const comm = await getCommunication(orgId, id)
  if (['sent', 'delivered', 'bounced', 'received'].includes(comm.status)) return { status: comm.status }
  if (comm.status !== 'queued' && comm.status !== 'approved') throw new Error(`Communication ${id} not approved (status=${comm.status})`)
  const settings = await getBharosaSettings(orgId)
  const ticket = comm.ticket_id
    ? (await dbQuery<{ ticket_number: string; citizen_name: string | null }>(
        `SELECT t.ticket_number, c.display_name AS citizen_name FROM tickets t LEFT JOIN citizens c ON c.id = t.citizen_id WHERE t.id = $1`,
        [comm.ticket_id],
      )).rows[0]
    : null

  let result: { ok: true; provider: string; messageId: string } | { ok: false; provider: string; error: string; permanent?: boolean }
  let replyTo: string | null = null
  if (comm.channel === 'email') {
    const to = comm.recipients_json.filter((r) => r.kind === 'to' && r.email).map((r) => r.email!)
    const cc = comm.recipients_json.filter((r) => r.kind === 'cc' && r.email).map((r) => r.email!)
    if (!to.length) throw new Error('No email recipients')
    replyTo = comm.thread_key ? replyToForThread(comm.thread_key) : null
    const fromName =
      settings.email.senderMode === 'citizen_name' && ticket?.citizen_name
        ? `${ticket.citizen_name} via ${tenantApp.name}`
        : tenantApp.name
    result = await sendEmail({
      to,
      cc,
      subject: comm.subject ?? `Grievance ${ticket?.ticket_number ?? ''}`,
      text: `${comm.body ?? ''}${footerFor(comm.language, settings.email.footer, ticket?.ticket_number ?? null)}`,
      replyTo,
      fromName,
      tags: { communication_id: comm.id, organization_id: orgId },
    })
  } else if (comm.channel === 'whatsapp' || comm.channel === 'sms') {
    const target = comm.recipients_json.find((r) => r.phone)
    if (!target?.phone) throw new Error('No phone recipient')
    result = await sendWhatsApp({ to: target.phone, body: comm.body ?? '' })
  } else {
    return { status: comm.status }
  }

  if (!result.ok) {
    await addCommEvent(comm.id, 'failed', { provider: result.provider, data: { error: result.error } })
    if ('permanent' in result && result.permanent) {
      await dbQuery(`UPDATE communications SET status = 'failed', updated_at = now() WHERE id = $1`, [comm.id])
      if (comm.ticket_id) {
        await createEscalation({
          orgId, ticketId: comm.ticket_id, communicationId: comm.id, target: 'gro', trigger: 'bounce',
          reason: `Message could not be sent: ${result.error}`, createdByAgent: 'delivery', dedupeKey: `send_failed:${comm.id}`,
        })
      }
      return { status: 'failed', provider: result.provider }
    }
    throw new Error(result.error)
  }

  await dbQuery(
    `UPDATE communications SET status = 'sent', sent_at = now(), provider = $2, provider_message_id = $3, reply_to_address = $4, updated_at = now()
     WHERE id = $1`,
    [comm.id, result.provider, result.messageId, replyTo],
  )
  await addCommEvent(comm.id, 'sent', { provider: result.provider, providerEventId: `sent:${result.messageId}` })
  if (comm.ticket_id) await afterSent(orgId, { ...comm, status: 'sent', sent_at: new Date().toISOString() })
  return { status: 'sent', provider: result.provider }
}

async function afterSent(orgId: string, comm: CommunicationRow) {
  const settings = await getBharosaSettings(orgId)
  const isAuthorityThread = ['authority_complaint', 'follow_up', 'escalation'].includes(comm.purpose)

  if (isAuthorityThread && comm.channel === 'email') {
    const intervals = settings.followUp.intervalsHours
    const nextIdx = comm.follow_up_count
    // After the last follow-up, one more check runs so the sweep can escalate.
    const hours = intervals[nextIdx] ?? (settings.followUp.escalateAfterLastFollowUp ? intervals[intervals.length - 1] : undefined)
    await dbQuery(
      `UPDATE communications SET next_follow_up_at = CASE WHEN $2::int IS NULL THEN NULL ELSE now() + make_interval(hours => $2::int) END WHERE id = $1`,
      [comm.id, hours ?? null],
    )
    if (comm.follow_up_of_id) {
      await dbQuery(`UPDATE communications SET next_follow_up_at = NULL WHERE id = $1`, [comm.follow_up_of_id])
    }
  }

  if (comm.task_id && isAuthorityThread) {
    await dbQuery(
      `UPDATE tasks SET status = 'waiting_for_reply', updated_at = now() WHERE id = $1 AND status NOT IN ('closed','cancelled')`,
      [comm.task_id],
    )
  }

  if (!comm.ticket_id) return
  const offices = comm.recipients_json.filter((r) => r.kind === 'to').map((r) => r.office ?? r.designation ?? r.name).filter(Boolean)
  const officeList = offices.join(', ') || (comm.language === 'te' ? 'సంబంధిత అధికారి' : 'the concerned authority')

  if (isAuthorityThread) {
    const isFollowUp = comm.purpose === 'follow_up'
    const isEscalation = comm.purpose === 'escalation'
    const en = isEscalation
      ? `Your complaint was escalated to ${officeList}.`
      : isFollowUp
        ? `A reminder was sent to ${officeList}.`
        : `Your complaint was emailed to ${officeList}.`
    const te = isEscalation
      ? `మీ ఫిర్యాదు ${officeList}కు ఉన్నత స్థాయికి పంపబడింది.`
      : isFollowUp
        ? `${officeList}కు గుర్తు చేస్తూ సందేశం పంపబడింది.`
        : `మీ ఫిర్యాదు ${officeList}కు ఇమెయిల్ ద్వారా పంపబడింది.`
    const citizenLang = (await dbQuery<{ l: string | null }>(`SELECT language AS l FROM tickets WHERE id = $1`, [comm.ticket_id])).rows[0]?.l ?? 'te'
    await recordCaseEvent({
      orgId,
      ticketId: comm.ticket_id,
      communicationId: comm.id,
      type: isEscalation ? 'authority_escalation_sent' : isFollowUp ? 'authority_follow_up_sent' : 'authority_email_sent',
      actorType: 'system',
      visibility: 'citizen',
      language: citizenLang,
      summary: citizenLang === 'te' ? te : en,
      data: { recipients: offices, channel: comm.channel },
    })

    const t = (await dbQuery<{ stage: string; sub_status: string }>(`SELECT stage, sub_status FROM tickets WHERE id = $1`, [comm.ticket_id])).rows[0]
    if (t && (t.stage === 'to_do' || t.stage === 'in_progress') && t.sub_status !== 'escalated_to_authority') {
      await updateTicketStage(comm.ticket_id, 'in_progress', 'escalated_to_authority', comm.approved_by_user_id, 'Grievance emailed to authority', !comm.approved_by_user_id)
    }
    await dbQuery(`UPDATE tickets SET routing_status = 'confirmed' WHERE id = $1 AND routing_status IN ('unrouted','suggested','uncertain')`, [comm.ticket_id])
  } else if (comm.purpose === 'public_post' || comm.channel === 'letter') {
    await recordCaseEvent({
      orgId, ticketId: comm.ticket_id, communicationId: comm.id, type: 'communication_sent',
      actorType: 'user', actorUserId: comm.approved_by_user_id, visibility: 'internal', data: { channel: comm.channel },
    })
  }
}

/** Delivery/bounce/complaint events from the provider (SES via SNS). */
export async function recordProviderEvent(args: {
  provider: string
  providerMessageId: string
  eventType: 'delivered' | 'bounced' | 'complaint' | 'failed'
  providerEventId?: string | null
  bouncedRecipients?: string[]
  permanent?: boolean
  raw?: unknown
}): Promise<{ matched: boolean }> {
  const res = await dbQuery<CommunicationRow>(`SELECT * FROM communications WHERE provider_message_id = $1 LIMIT 1`, [args.providerMessageId])
  const comm = res.rows[0]
  if (!comm) return { matched: false }

  await addCommEvent(comm.id, args.eventType, {
    provider: args.provider,
    providerEventId: args.providerEventId ?? `${args.eventType}:${args.providerMessageId}:${(args.bouncedRecipients ?? []).join(',')}`,
    data: args.raw,
  })

  if (args.eventType === 'delivered') {
    await dbQuery(`UPDATE communications SET status = CASE WHEN status = 'sent' THEN 'delivered' ELSE status END, delivered_at = COALESCE(delivered_at, now()), updated_at = now() WHERE id = $1`, [comm.id])
    if (comm.ticket_id) {
      await dbQuery(`UPDATE tickets SET routing_status = 'delivered' WHERE id = $1 AND routing_status <> 'bounced'`, [comm.ticket_id])
      await recordCaseEvent({
        orgId: comm.organization_id, ticketId: comm.ticket_id, communicationId: comm.id,
        type: 'authority_email_delivered', actorType: 'webhook', visibility: 'internal', data: { provider: args.provider },
      })
    }
    return { matched: true }
  }

  if (args.eventType === 'bounced' && args.permanent !== false) {
    await dbQuery(`UPDATE communications SET status = 'bounced', next_follow_up_at = NULL, updated_at = now() WHERE id = $1`, [comm.id])
    const bounced = new Set((args.bouncedRecipients ?? []).map((e) => e.toLowerCase()))
    for (const r of comm.recipients_json) {
      if (r.contact_id && r.email && (bounced.size === 0 || bounced.has(r.email.toLowerCase()))) {
        await dbQuery(
          `UPDATE directory_contacts SET bounce_count = bounce_count + 1, last_bounced_at = now(),
                  verification_status = CASE WHEN bounce_count + 1 >= 2 THEN 'outdated' ELSE verification_status END
           WHERE id = $1`,
          [r.contact_id],
        )
      }
    }
    if (comm.ticket_id) {
      await dbQuery(`UPDATE tickets SET routing_status = 'bounced' WHERE id = $1`, [comm.ticket_id])
      await createEscalation({
        orgId: comm.organization_id, ticketId: comm.ticket_id, communicationId: comm.id, target: 'gro', trigger: 'bounce',
        reason: `Email to ${[...bounced].join(', ') || 'authority'} bounced. Correct the contact and resend.`,
        createdByAgent: 'delivery', dedupeKey: `bounce:${comm.id}`,
      })
    }
  }
  return { matched: true }
}

/** Authority replied: thread it, stop follow-ups, flag the work, and summarize. */
export async function recordInboundReply(args: {
  threadKey: string | null
  inReplyToMessageIds: string[]
  fromEmail: string
  fromName: string | null
  subject: string | null
  text: string
  provider: string
  providerMessageId: string | null
  raw?: unknown
}): Promise<{ matched: boolean; communicationId?: string }> {
  let original: CommunicationRow | undefined
  if (args.threadKey) {
    original = (await dbQuery<CommunicationRow>(
      `SELECT * FROM communications WHERE thread_key = $1 AND direction = 'outbound' ORDER BY created_at ASC LIMIT 1`,
      [args.threadKey],
    )).rows[0]
  }
  if (!original && args.inReplyToMessageIds.length) {
    original = (await dbQuery<CommunicationRow>(
      `SELECT * FROM communications WHERE direction = 'outbound' AND provider_message_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM unnest($1::text[]) m WHERE m ILIKE '%' || provider_message_id || '%')
       ORDER BY created_at DESC LIMIT 1`,
      [args.inReplyToMessageIds],
    )).rows[0]
  }
  if (!original) return { matched: false }

  if (args.providerMessageId) {
    const dup = await dbQuery(`SELECT 1 FROM communications WHERE provider = $1 AND provider_message_id = $2 AND direction = 'inbound'`, [
      args.provider,
      args.providerMessageId,
    ])
    if (dup.rowCount) return { matched: true }
  }

  const inserted = await dbQuery<{ id: string }>(
    `INSERT INTO communications (organization_id, ticket_id, task_id, channel, direction, purpose, status, approval_by,
        language, subject, body, recipients_json, from_address, thread_key, in_reply_to_id, provider, provider_message_id, raw_inbound_json, sent_at)
     VALUES ($1,$2,$3,'email','inbound','authority_reply','received','none',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())
     RETURNING id`,
    [
      original.organization_id, original.ticket_id, original.task_id,
      /[\u0C00-\u0C7F]/.test(args.text) ? 'te' : 'en',
      args.subject, args.text.slice(0, 50_000),
      JSON.stringify([{ name: args.fromName, email: args.fromEmail, kind: 'to' }]),
      args.fromEmail, original.thread_key, original.id, args.provider, args.providerMessageId,
      args.raw ? JSON.stringify(args.raw) : null,
    ],
  )
  const replyId = inserted.rows[0].id
  await addCommEvent(original.id, 'reply_received', { provider: args.provider, data: { reply_id: replyId, from: args.fromEmail } })

  if (original.thread_key) {
    await dbQuery(
      `UPDATE communications SET follow_up_stopped_at = now(), next_follow_up_at = NULL
       WHERE thread_key = $1 AND direction = 'outbound' AND follow_up_stopped_at IS NULL`,
      [original.thread_key],
    )
  }
  if (original.task_id) {
    await dbQuery(`UPDATE tasks SET status = 'in_progress', updated_at = now() WHERE id = $1 AND status = 'waiting_for_reply'`, [original.task_id])
  }
  if (original.ticket_id) {
    await recordCaseEvent({
      orgId: original.organization_id, ticketId: original.ticket_id, communicationId: replyId, taskId: original.task_id,
      type: 'authority_reply_received', actorType: 'authority', actorLabel: args.fromName ?? args.fromEmail, visibility: 'internal',
      data: { from: args.fromEmail, subject: args.subject },
    })
    await enqueueJob({
      type: 'summarize_inbound_reply',
      orgId: original.organization_id,
      payload: { communication_id: replyId },
      idempotencyKey: `summarize:${replyId}`,
    })
  }
  return { matched: true, communicationId: replyId }
}

export async function listCommunicationsForTicket(orgId: string, ticketId: string) {
  const res = await dbQuery<CommunicationRow>(
    `SELECT * FROM communications WHERE organization_id = $1 AND ticket_id = $2 AND status <> 'superseded' ORDER BY created_at ASC`,
    [orgId, ticketId],
  )
  return res.rows
}

export async function listCommunicationEvents(commId: string) {
  const res = await dbQuery(
    `SELECT id, event_type, provider, data_json, created_at FROM communication_events WHERE communication_id = $1 ORDER BY created_at`,
    [commId],
  )
  return res.rows
}

export async function listCommunicationVersions(orgId: string, id: string) {
  const res = await dbQuery(
    `WITH RECURSIVE v AS (
       SELECT * FROM communications WHERE id = $1 AND organization_id = $2
       UNION ALL
       SELECT c.* FROM communications c JOIN v ON c.id = v.previous_version_id
     ) SELECT id, version, status, language, subject, body, created_by_user_id, created_by_citizen_id, created_at FROM v ORDER BY version DESC`,
    [id, orgId],
  )
  return res.rows
}

export async function listApprovalQueue(orgId: string, limit: number, offset: number) {
  const res = await dbQuery(
    `SELECT c.id, c.ticket_id, t.ticket_number, t.title AS ticket_title, c.channel, c.purpose, c.language, c.subject,
            c.recipients_json, c.version, c.summary_json, c.created_at
     FROM communications c LEFT JOIN tickets t ON t.id = c.ticket_id
     WHERE c.organization_id = $1 AND c.status = 'pending_approval' AND c.approval_by = 'staff'
     ORDER BY c.created_at ASC LIMIT $2 OFFSET $3`,
    [orgId, limit, offset],
  )
  return res.rows
}

/** Citizen-safe projection of a communication. */
export function citizenView(c: CommunicationRow) {
  return {
    id: c.id,
    channel: c.channel,
    direction: c.direction,
    purpose: c.purpose,
    status: c.status,
    needs_your_approval: c.approval_by === 'citizen' && c.status === 'pending_approval',
    language: c.language,
    subject: c.direction === 'outbound' ? c.subject : null,
    body: c.direction === 'outbound' ? c.body : null,
    translations: c.direction === 'outbound' ? c.translations_json : null,
    recipients:
      c.direction === 'outbound'
        ? c.recipients_json.map((r) => ({ name: r.name, office: r.office, designation: r.designation, email: r.email, kind: r.kind }))
        : [],
    reply_summary: c.direction === 'inbound' ? (c.summary_json as { citizen_summary?: unknown } | null)?.citizen_summary ?? null : null,
    sent_at: c.sent_at,
    delivered_at: c.delivered_at,
    created_at: c.created_at,
  }
}
