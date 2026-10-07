import { dbQuery } from '@/lib/db.js'
import { updateTicketStage } from '@/services/ticketService.js'
import { signedUrlsFor } from '@/services/attachmentService.js'
import { HttpError, str, uuid, type Language } from '../common.js'
import type { CitizenRow } from './auth.js'
import { latestConsent, recordConsents, sha256 } from './auth.js'
import {
  CITIZEN_STATUS_LABELS,
  CITIZEN_STATUS_ORDER,
  CITIZEN_SUB_STATUS_HINTS,
  citizenSummaryForEvent,
  listCaseEvents,
  projectCitizenStatus,
  recordCaseEvent,
  type CitizenStatus,
} from '../cases/events.js'
import { createEscalation } from '../cases/escalations.js'
import { suggestAuthorities } from '../directory/routing.js'
import {
  citizenView,
  createDraftCommunication,
  listCommunicationsForTicket,
  resolveRecipients,
} from '../comms/communications.js'

const REOPEN_WINDOW_DAYS = 30

interface CitizenTicketRow {
  id: string
  organization_id: string
  ticket_number: string
  title: string | null
  normalized_summary: string | null
  original_issue_text: string | null
  stage: string
  sub_status: string
  outcome: string | null
  verification_status: string | null
  routing_status: string | null
  language: string | null
  location_text: string | null
  category_name: string | null
  area_name: string | null
  severity: string | null
  created_at: string
  updated_at: string
  closed_at: string | null
  reopened_count: number
  citizen_feedback_json: Record<string, unknown> | null
  public_status_enabled: boolean
  structured_facts_json: Record<string, unknown> | null
}

const TICKET_SELECT = `t.id, t.organization_id, t.ticket_number, t.title, t.normalized_summary, t.original_issue_text, t.stage, t.sub_status,
  t.outcome, t.verification_status, t.routing_status, t.language, t.location_text, c.name AS category_name, tr.name AS area_name,
  t.severity, t.created_at, t.updated_at, t.closed_at, t.reopened_count, t.citizen_feedback_json, t.public_status_enabled,
  t.structured_facts_json`

const TICKET_FROM = `FROM tickets t
  LEFT JOIN issue_categories c ON c.id = t.category_id
  LEFT JOIN territories tr ON tr.id = t.territory_id`

async function loadOwnTicket(citizen: CitizenRow, ticketId: string): Promise<CitizenTicketRow> {
  if (!uuid(ticketId)) throw new HttpError(400, 'Invalid case id')
  const res = await dbQuery<CitizenTicketRow>(
    `SELECT ${TICKET_SELECT} ${TICKET_FROM} WHERE t.id = $1 AND t.citizen_id = $2 AND t.organization_id = $3`,
    [ticketId, citizen.id, citizen.organization_id],
  )
  if (!res.rows[0]) throw new HttpError(404, 'Case not found')
  return res.rows[0]
}

function statusBlock(t: CitizenTicketRow, lang: Language) {
  const status = projectCitizenStatus(t)
  const hint = CITIZEN_SUB_STATUS_HINTS[t.sub_status]?.[lang] ?? null
  const terminal = status === 'resolved' || status === 'cancelled'
  const currentIdx = CITIZEN_STATUS_ORDER.indexOf(status === 'on_hold' ? 'in_progress' : status)
  return {
    code: status,
    label: CITIZEN_STATUS_LABELS[status][lang],
    hint,
    steps: CITIZEN_STATUS_ORDER.map((s, i) => ({
      code: s,
      label: CITIZEN_STATUS_LABELS[s][lang],
      state: status === 'cancelled' ? (i === 0 ? 'done' : 'skipped') : i < currentIdx || (terminal && i === currentIdx) ? 'done' : i === currentIdx ? 'current' : 'upcoming',
    })),
    on_hold: status === 'on_hold',
  }
}

export async function listMyCases(citizen: CitizenRow, lang: Language, limit: number, offset: number) {
  const res = await dbQuery<CitizenTicketRow & { pending_approvals: number; total: string }>(
    `SELECT ${TICKET_SELECT},
            (SELECT COUNT(*)::int FROM communications cm WHERE cm.ticket_id = t.id AND cm.status = 'pending_approval' AND cm.approval_by = 'citizen') AS pending_approvals,
            COUNT(*) OVER()::text AS total
     ${TICKET_FROM}
     WHERE t.citizen_id = $1 AND t.organization_id = $2
     ORDER BY t.updated_at DESC LIMIT $3 OFFSET $4`,
    [citizen.id, citizen.organization_id, limit, offset],
  )
  return {
    count: Number(res.rows[0]?.total ?? 0),
    cases: res.rows.map((t) => {
      const s = statusBlock(t, lang)
      return {
        id: t.id,
        ticket_number: t.ticket_number,
        title: t.title,
        category: t.category_name,
        area: t.area_name,
        status: { code: s.code, label: s.label, hint: s.hint },
        needs_action: t.pending_approvals > 0 || t.sub_status === 'awaiting_citizen_response' || t.sub_status === 'awaiting_documents_evidence',
        pending_approvals: t.pending_approvals,
        created_at: t.created_at,
        updated_at: t.updated_at,
      }
    }),
  }
}

function citizenTimeline(events: Awaited<ReturnType<typeof listCaseEvents>>, lang: Language) {
  return events
    .map((e) => {
      const text = citizenSummaryForEvent(e, lang)
      if (!text) return null
      return {
        id: e.id,
        type: e.event_type,
        text,
        actor: e.actor_type === 'citizen' ? 'you' : e.actor_type === 'authority' ? 'authority' : 'team',
        at: e.created_at,
      }
    })
    .filter((x): x is NonNullable<typeof x> => !!x)
}

export async function getMyCase(citizen: CitizenRow, ticketId: string, lang: Language) {
  const t = await loadOwnTicket(citizen, ticketId)
  const [events, comms, attachments, consents] = await Promise.all([
    listCaseEvents(t.id, ['citizen', 'public']),
    listCommunicationsForTicket(t.organization_id, t.id),
    dbQuery<{ id: string; file_name: string; mime_type: string | null; attachment_type: string | null; storage_path: string; created_at: string }>(
      `SELECT id, file_name, mime_type, attachment_type, storage_path, created_at FROM ticket_attachments
       WHERE ticket_id = $1 AND COALESCE(visibility, 'internal') IN ('citizen','public') ORDER BY created_at`,
      [t.id],
    ),
    dbQuery<{ consent_type: string; granted: boolean }>(
      `SELECT DISTINCT ON (consent_type) consent_type, granted FROM citizen_consents
       WHERE citizen_id = $1 AND (ticket_id = $2 OR ticket_id IS NULL) ORDER BY consent_type, created_at DESC`,
      [citizen.id, t.id],
    ),
  ])
  const urls = await signedUrlsFor(attachments.rows.map((a) => a.storage_path))
  const visibleComms = comms.filter((c) => c.purpose !== 'citizen_update' && c.status !== 'rejected')
  const facts = (t.structured_facts_json ?? {}) as { missing_questions?: unknown; title?: Record<string, string>; summary?: Record<string, string> }

  return {
    id: t.id,
    ticket_number: t.ticket_number,
    title: facts.title?.[lang] ?? t.title,
    summary: facts.summary?.[lang] ?? t.normalized_summary ?? t.original_issue_text,
    category: t.category_name,
    area: t.area_name,
    location_text: t.location_text,
    language: t.language,
    created_at: t.created_at,
    updated_at: t.updated_at,
    closed_at: t.closed_at,
    status: statusBlock(t, lang),
    verification_status: t.verification_status,
    routing_status: t.routing_status,
    actions: {
      approve_communications: visibleComms.filter((c) => c.approval_by === 'citizen' && c.status === 'pending_approval').map((c) => c.id),
      can_request_authority_email: canRequestAuthorityEmail(t, visibleComms),
      respond_requested: t.sub_status === 'awaiting_citizen_response' || t.sub_status === 'awaiting_documents_evidence',
      can_give_feedback: t.stage === 'closed' && !t.citizen_feedback_json,
      can_reopen: canReopen(t),
    },
    timeline: citizenTimeline(events, lang),
    communications: visibleComms.map(citizenView),
    evidence: attachments.rows.map((a) => ({
      id: a.id, file_name: a.file_name, mime_type: a.mime_type, type: a.attachment_type, url: urls[a.storage_path] ?? null, created_at: a.created_at,
    })),
    consents: Object.fromEntries(consents.rows.map((c) => [c.consent_type, c.granted])),
    feedback: t.citizen_feedback_json,
  }
}

function canRequestAuthorityEmail(t: CitizenTicketRow, comms: Awaited<ReturnType<typeof listCommunicationsForTicket>>): boolean {
  if (t.stage === 'closed' || t.verification_status === 'failed') return false
  return !comms.some(
    (c) => c.direction === 'outbound' && c.purpose === 'authority_complaint' && !['rejected', 'superseded', 'failed', 'bounced'].includes(c.status),
  )
}

function canReopen(t: CitizenTicketRow): boolean {
  if (t.stage !== 'closed' || !t.closed_at) return false
  return Date.now() - new Date(t.closed_at).getTime() < REOPEN_WINDOW_DAYS * 86400_000
}

/** Citizen-safe authority suggestions (no internal notes or scores beyond confidence). */
export async function authoritySuggestionsForCitizen(citizen: CitizenRow, ticketId: string, lang: Language) {
  const t = await loadOwnTicket(citizen, ticketId)
  const r = await suggestAuthorities(t.organization_id, t.id, { persist: true })
  return {
    uncertain: r.uncertain,
    message: r.uncertain
      ? lang === 'te'
        ? 'సరైన కార్యాలయాన్ని మా బృందం నిర్ధారిస్తుంది. మీరు సూచించిన వాటిలో ఎంచుకోవచ్చు లేదా మా బృందానికి వదిలేయవచ్చు.'
        : 'Our team will confirm the right office. You can pick one of these or leave it to the team.'
      : null,
    candidates: r.candidates
      .filter((c) => c.has_email)
      .map((c) => ({
        contact_id: c.contact_id,
        office: c.organization_name,
        designation: c.role_designation,
        department: c.department,
        covers: c.territory_names,
        confidence: Math.round(c.confidence * 100) / 100,
        reason: c.reasons[0] ?? null,
      })),
  }
}

/** Citizen asks the AI to draft the grievance email to chosen authorities; citizen approves before send. */
export async function requestAuthorityEmail(citizen: CitizenRow, ticketId: string, body: Record<string, unknown>, ip: string) {
  const t = await loadOwnTicket(citizen, ticketId)
  const comms = await listCommunicationsForTicket(t.organization_id, t.id)
  if (!canRequestAuthorityEmail(t, comms)) throw new HttpError(409, 'An authority email already exists for this case', 'ALREADY_DRAFTED')

  const contactIds = Array.isArray(body.contact_ids) ? body.contact_ids.filter((x): x is string => !!uuid(x)).slice(0, 3) : []
  if (!contactIds.length) throw new HttpError(400, 'Choose at least one authority', 'NO_RECIPIENT')
  const allowed = await dbQuery<{ id: string }>(
    `SELECT id FROM directory_contacts WHERE organization_id = $1 AND id = ANY($2::uuid[]) AND active = true
       AND archived_at IS NULL AND is_public_authority = true AND email IS NOT NULL`,
    [t.organization_id, contactIds],
  )
  if (allowed.rowCount !== contactIds.length) throw new HttpError(400, 'One or more selected offices cannot receive email')

  if (body.share_name === true || body.share_name === false) {
    await recordConsents({
      orgId: t.organization_id, citizenId: citizen.id, ticketId: t.id,
      consents: [{ type: 'share_with_authority', granted: body.share_name === true }], language: t.language, channel: 'web', ip,
    })
  }
  const language: Language = body.language === 'en' ? 'en' : body.language === 'te' ? 'te' : t.language === 'en' ? 'en' : 'te'
  const recipients = await resolveRecipients(t.organization_id, { contact_ids: contactIds })
  const draft = await createDraftCommunication({
    orgId: t.organization_id,
    ticketId: t.id,
    format: 'authority_email',
    recipients,
    language,
    approvalBy: 'citizen',
    createdByCitizenId: citizen.id,
    instructions: str(body.note, 500),
  })
  return citizenView(draft)
}

export async function getMyCommunication(citizen: CitizenRow, commId: string) {
  const res = await dbQuery<{ ticket_id: string }>(
    `SELECT c.ticket_id FROM communications c JOIN tickets t ON t.id = c.ticket_id
     WHERE c.id = $1 AND t.citizen_id = $2 AND c.organization_id = $3`,
    [commId, citizen.id, citizen.organization_id],
  )
  if (!res.rows[0]) throw new HttpError(404, 'Message not found')
}

/** Citizen replies to a team request (more info / documents). */
export async function respondToCase(citizen: CitizenRow, ticketId: string, body: Record<string, unknown>) {
  const t = await loadOwnTicket(citizen, ticketId)
  const text = str(body.text, 4000)
  if (!text) throw new HttpError(400, 'text is required')
  if (t.stage === 'closed') throw new HttpError(409, 'Case is closed. Reopen it instead.')

  await recordCaseEvent({
    orgId: t.organization_id, ticketId: t.id, type: 'citizen_responded', actorType: 'citizen', actorCitizenId: citizen.id,
    visibility: 'citizen', language: t.language ?? 'te', data: { text },
  })
  await dbQuery(
    `INSERT INTO ticket_notes (ticket_id, author_user_id, note_type, content, is_internal) VALUES ($1, NULL, 'system', $2, true)`,
    [t.id, `Citizen response: ${text}`],
  )
  if (t.sub_status === 'awaiting_citizen_response' || t.sub_status === 'awaiting_documents_evidence') {
    await updateTicketStage(t.id, 'in_progress', 'citizen_contacted', null, 'Citizen responded', true)
  }
  return { ok: true }
}

export async function submitFeedback(citizen: CitizenRow, ticketId: string, body: Record<string, unknown>) {
  const t = await loadOwnTicket(citizen, ticketId)
  if (t.stage !== 'closed') throw new HttpError(409, 'Feedback can be given once the case is closed')
  if (t.citizen_feedback_json) throw new HttpError(409, 'Feedback already submitted')
  const rating = Number(body.rating)
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new HttpError(400, 'rating must be 1-5')
  const resolved = body.resolved === true
  const feedback = { rating, resolved, comment: str(body.comment, 2000), at: new Date().toISOString() }
  await dbQuery(`UPDATE tickets SET citizen_feedback_json = $2 WHERE id = $1`, [t.id, JSON.stringify(feedback)])
  await recordCaseEvent({
    orgId: t.organization_id, ticketId: t.id, type: 'feedback_received', actorType: 'citizen', actorCitizenId: citizen.id,
    visibility: 'citizen', data: feedback,
  })
  if (!resolved && body.reopen === true && canReopen(t)) {
    return { ok: true, reopened: await reopenCase(citizen, ticketId, { reason: feedback.comment ?? 'Citizen says the issue is not resolved' }) }
  }
  if (!resolved || rating <= 2) {
    await createEscalation({
      orgId: t.organization_id, ticketId: t.id, target: 'gro', trigger: 'citizen_reopen',
      reason: `Citizen feedback after closure: rating ${rating}/5, resolved=${resolved}. ${feedback.comment ?? ''}`.trim(),
      createdByAgent: 'feedback', dedupeKey: `feedback:${t.id}`,
    })
  }
  return { ok: true, reopened: false }
}

export async function reopenCase(citizen: CitizenRow, ticketId: string, body: Record<string, unknown>) {
  const t = await loadOwnTicket(citizen, ticketId)
  if (!canReopen(t)) throw new HttpError(409, `Cases can be reopened within ${REOPEN_WINDOW_DAYS} days of closure`)
  const reason = str(body.reason, 2000)
  if (!reason) throw new HttpError(400, 'Tell us why the issue is not resolved')

  await dbQuery(
    `UPDATE tickets SET reopened_count = reopened_count + 1, needs_triage = true, closed_at = NULL, outcome = NULL WHERE id = $1`,
    [t.id],
  )
  await updateTicketStage(t.id, 'to_do', 'new_awaiting_triage', null, `Reopened by citizen: ${reason}`, true)
  await recordCaseEvent({
    orgId: t.organization_id, ticketId: t.id, type: 'case_reopened', actorType: 'citizen', actorCitizenId: citizen.id,
    visibility: 'citizen', reason, data: { reopened_count: t.reopened_count + 1 },
  })
  await createEscalation({
    orgId: t.organization_id, ticketId: t.id, target: 'gro', trigger: 'citizen_reopen',
    reason: `Citizen reopened ${t.ticket_number}: ${reason}`, createdByAgent: 'citizen_reopen',
    dedupeKey: `reopen:${t.id}:${t.reopened_count + 1}`,
  })
  return true
}

export async function updateCaseConsents(citizen: CitizenRow, ticketId: string, body: Record<string, unknown>, ip: string) {
  const t = await loadOwnTicket(citizen, ticketId)
  const consents = Array.isArray(body.consents) ? (body.consents as Array<Record<string, unknown>>) : []
  const allowed = new Set(['share_with_authority', 'public_status', 'whatsapp_updates', 'contact_by_phone', 'media_use'])
  const clean = consents.filter((c) => allowed.has(String(c.type))).map((c) => ({ type: String(c.type), granted: c.granted === true }))
  await recordConsents({ orgId: t.organization_id, citizenId: citizen.id, ticketId: t.id, consents: clean, language: t.language, channel: 'web', ip })
  const ps = clean.find((c) => c.type === 'public_status')
  if (ps) await dbQuery(`UPDATE tickets SET public_status_enabled = $2 WHERE id = $1`, [t.id, ps.granted])
  return { ok: true, share_with_authority: await latestConsent(citizen.id, 'share_with_authority', t.id) }
}

// ---------------------------------------------------------------------------
// Public (no login) — tracker link and status lookup
// ---------------------------------------------------------------------------

/** Tracker link from the confirmation screen: no login, no PII. */
export async function trackByToken(orgId: string, token: string, lang: Language) {
  if (!token || token.length < 16) throw new HttpError(404, 'Not found')
  const res = await dbQuery<CitizenTicketRow>(
    `SELECT ${TICKET_SELECT} ${TICKET_FROM} WHERE t.organization_id = $1 AND t.tracking_token_hash = $2`,
    [orgId, sha256(token)],
  )
  const t = res.rows[0]
  if (!t) throw new HttpError(404, 'Not found')
  const events = await listCaseEvents(t.id, ['citizen', 'public'])
  const facts = (t.structured_facts_json ?? {}) as { title?: Record<string, string> }
  return {
    ticket_number: t.ticket_number,
    title: facts.title?.[lang] ?? t.title,
    category: t.category_name,
    area: t.area_name,
    created_at: t.created_at,
    updated_at: t.updated_at,
    status: statusBlock(t, lang),
    timeline: citizenTimeline(events, lang).map(({ id, type, text, at }) => ({ id, type, text, at })),
  }
}

/**
 * Public status by reference number. Anyone can confirm a case exists and its
 * stage; details only if the citizen opted in to public status.
 */
export async function publicStatusByNumber(orgId: string, ticketNumber: string, lang: Language) {
  const num = ticketNumber.trim().toUpperCase()
  if (!/^[A-Z0-9-]{4,40}$/.test(num)) throw new HttpError(400, 'Invalid reference number')
  const res = await dbQuery<CitizenTicketRow>(
    `SELECT ${TICKET_SELECT} ${TICKET_FROM} WHERE t.organization_id = $1 AND upper(t.ticket_number) = $2 LIMIT 1`,
    [orgId, num],
  )
  const t = res.rows[0]
  if (!t) throw new HttpError(404, 'No case with this reference number')
  const s = statusBlock(t, lang)
  const base = { ticket_number: t.ticket_number, status: { code: s.code, label: s.label }, updated_at: t.updated_at, details_public: t.public_status_enabled }
  if (!t.public_status_enabled) return base
  const sentToAuthority = await dbQuery<{ c: number }>(
    `SELECT COUNT(*)::int AS c FROM communications WHERE ticket_id = $1 AND direction = 'outbound'
       AND purpose IN ('authority_complaint','follow_up','escalation') AND status IN ('sent','delivered')`,
    [t.id],
  )
  const replied = await dbQuery<{ c: number }>(`SELECT COUNT(*)::int AS c FROM communications WHERE ticket_id = $1 AND direction = 'inbound'`, [t.id])
  const facts = (t.structured_facts_json ?? {}) as { title?: Record<string, string> }
  return {
    ...base,
    title: facts.title?.[lang] ?? t.title,
    category: t.category_name,
    area: t.area_name,
    created_at: t.created_at,
    status: s,
    authority_contacted: sentToAuthority.rows[0].c > 0,
    authority_messages_sent: sentToAuthority.rows[0].c,
    authority_replied: replied.rows[0].c > 0,
  }
}

/** Aggregate public dashboard. No per-person data. */
export async function publicStats(orgId: string, lang: Language) {
  const [byStatus, byCategory, resolution, comms, recent, byArea] = await Promise.all([
    dbQuery<{ stage: string; sub_status: string; outcome: string | null; verification_status: string | null; c: number }>(
      `SELECT stage, sub_status, outcome, verification_status, COUNT(*)::int AS c FROM tickets
       WHERE organization_id = $1 GROUP BY 1,2,3,4`,
      [orgId],
    ),
    dbQuery<{ category: string | null; total: number; resolved: number }>(
      `SELECT c.name AS category, COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE t.stage = 'closed' AND t.outcome IN ('resolved_by_org','resolved_external','closed_with_advice'))::int AS resolved
       FROM tickets t LEFT JOIN issue_categories c ON c.id = t.category_id
       WHERE t.organization_id = $1 GROUP BY 1 ORDER BY 2 DESC LIMIT 15`,
      [orgId],
    ),
    dbQuery<{ median_days: number | null; resolved_30d: number; created_30d: number }>(
      `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM closed_at - created_at) / 86400)
                FILTER (WHERE stage = 'closed' AND closed_at IS NOT NULL) AS median_days,
              COUNT(*) FILTER (WHERE stage = 'closed' AND closed_at > now() - interval '30 days')::int AS resolved_30d,
              COUNT(*) FILTER (WHERE created_at > now() - interval '30 days')::int AS created_30d
       FROM tickets WHERE organization_id = $1`,
      [orgId],
    ),
    dbQuery<{ sent: number; replied_threads: number; threads: number }>(
      `SELECT COUNT(*) FILTER (WHERE direction = 'outbound' AND status IN ('sent','delivered'))::int AS sent,
              COUNT(DISTINCT thread_key) FILTER (WHERE direction = 'inbound')::int AS replied_threads,
              COUNT(DISTINCT thread_key) FILTER (WHERE direction = 'outbound' AND status IN ('sent','delivered'))::int AS threads
       FROM communications WHERE organization_id = $1 AND channel = 'email'
         AND purpose IN ('authority_complaint','follow_up','escalation','authority_reply')`,
      [orgId],
    ),
    dbQuery<{ d: string; created: number; resolved: number }>(
      `SELECT to_char(d, 'YYYY-MM-DD') AS d,
              (SELECT COUNT(*)::int FROM tickets WHERE organization_id = $1 AND created_at::date = d) AS created,
              (SELECT COUNT(*)::int FROM tickets WHERE organization_id = $1 AND stage = 'closed' AND closed_at::date = d) AS resolved
       FROM generate_series((now() - interval '29 days')::date, now()::date, interval '1 day') d`,
      [orgId],
    ),
    dbQuery<{ area: string | null; total: number; open: number }>(
      `SELECT tr.name AS area, COUNT(*)::int AS total, COUNT(*) FILTER (WHERE t.stage <> 'closed')::int AS open
       FROM tickets t JOIN territories tr ON tr.id = t.territory_id
       WHERE t.organization_id = $1 GROUP BY 1 ORDER BY 2 DESC LIMIT 15`,
      [orgId],
    ),
  ])

  const statusCounts: Record<CitizenStatus, number> = { created: 0, in_verification: 0, in_progress: 0, on_hold: 0, resolved: 0, cancelled: 0 }
  for (const r of byStatus.rows) statusCounts[projectCitizenStatus(r)] += r.c
  const total = Object.values(statusCounts).reduce((a, b) => a + b, 0)
  const c = comms.rows[0]
  return {
    total_cases: total,
    by_status: (Object.keys(statusCounts) as CitizenStatus[]).map((k) => ({ code: k, label: CITIZEN_STATUS_LABELS[k][lang], count: statusCounts[k] })),
    by_category: byCategory.rows,
    by_area: byArea.rows,
    median_resolution_days: resolution.rows[0].median_days != null ? Math.round(resolution.rows[0].median_days * 10) / 10 : null,
    created_last_30_days: resolution.rows[0].created_30d,
    resolved_last_30_days: resolution.rows[0].resolved_30d,
    authority_emails_sent: c.sent,
    authority_response_rate: c.threads ? Math.round((c.replied_threads / c.threads) * 100) / 100 : null,
    daily: recent.rows,
    generated_at: new Date().toISOString(),
  }
}
