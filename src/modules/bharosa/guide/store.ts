import { dbQuery } from '@/lib/db.js'
import type { IntakePhase } from '@/lib/citizenIntakeLadder.js'
import type { GuideLang } from './playbooks.js'

export interface GuideContactInfo {
  name?: string
  phone?: string
  email?: string
  place?: string
  /** Free-text problem the citizen described before playbook match. */
  problem_summary?: string
  /** From Dify / heuristics: local spot required before advice. */
  needs_area?: boolean
  /** Dual-path close already shown once for the current problem. */
  close_offered?: boolean
  /** Citizen chose skip/later for phone or email. */
  skipped_phone?: boolean
  skipped_email?: boolean
  /** Last shown case-list offset for “see more”. */
  case_list_offset?: number
  /** Last offered case choice keys for number replies (JSON-serializable). */
  case_choice_snapshot?: Array<{
    key: string
    kind: string
    id: string
    title: string
    status: string
  }>
  /** Focused ticket / guide / memory item the citizen picked. */
  active_case_kind?: string
  active_case_id?: string
  active_case_title?: string
}

export interface GuideDraft {
  to: string
  subject: string
  body: string
}

export interface GuideSession {
  id: string
  organization_id: string
  language: GuideLang
  status: 'open' | 'satisfied' | 'raised'
  problem_id: string | null
  /** Logged-in citizen (optional) — enables persistent memory. */
  citizen_id: string | null
  /** Intake ladder position — persisted inside contact_json as `_intake_phase`. */
  phase: IntakePhase
  contact: GuideContactInfo
  draft: GuideDraft | null
}

export interface GuideMessage {
  id: string
  role: 'user' | 'assistant'
  body: string
  created_at: string
}

function asLang(value: string): GuideLang {
  return value === 'en' || value === 'hi' ? value : 'te'
}

function asPhase(value: unknown): IntakePhase {
  if (value === 'ask_name' || value === 'ask_problem' || value === 'ask_area' || value === 'help') {
    return value
  }
  // Old sessions that stored ask_phone / ask_email — treat as ready to help.
  if (value === 'ask_phone' || value === 'ask_email') return 'help'
  return 'ask_name'
}

function asContact(value: unknown): GuideContactInfo {
  if (!value || typeof value !== 'object') return {}
  const row = value as Record<string, unknown>
  const pick = (key: string) => (typeof row[key] === 'string' ? row[key] : undefined)
  return {
    name: pick('name'),
    phone: pick('phone'),
    email: pick('email'),
    place: pick('place'),
    problem_summary: pick('problem_summary'),
    needs_area: typeof row.needs_area === 'boolean' ? row.needs_area : undefined,
    close_offered: row.close_offered === true,
    skipped_phone: row.skipped_phone === true,
    skipped_email: row.skipped_email === true,
    case_list_offset: typeof row.case_list_offset === 'number' ? row.case_list_offset : undefined,
    case_choice_snapshot: Array.isArray(row.case_choice_snapshot)
      ? (row.case_choice_snapshot as GuideContactInfo['case_choice_snapshot'])
      : undefined,
    active_case_kind: pick('active_case_kind'),
    active_case_id: pick('active_case_id'),
    active_case_title: pick('active_case_title'),
  }
}

function contactPayload(session: GuideSession): Record<string, unknown> {
  return {
    ...session.contact,
    _intake_phase: session.phase,
  }
}

function asDraft(value: unknown): GuideDraft | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  if (typeof row.to !== 'string' || typeof row.subject !== 'string' || typeof row.body !== 'string') return null
  return { to: row.to, subject: row.subject, body: row.body }
}

export async function createGuideSession(
  orgId: string,
  language: GuideLang,
  citizenId?: string | null,
): Promise<GuideSession> {
  const res = await dbQuery<{ id: string }>(
    `INSERT INTO guide_sessions (organization_id, language, citizen_id)
     VALUES ($1, $2, $3) RETURNING id`,
    [orgId, language, citizenId ?? null],
  )
  return {
    id: res.rows[0].id,
    organization_id: orgId,
    language,
    status: 'open',
    problem_id: null,
    citizen_id: citizenId ?? null,
    phase: 'ask_name',
    contact: {},
    draft: null,
  }
}

export async function loadGuideSession(orgId: string, id: string): Promise<GuideSession | null> {
  const res = await dbQuery<{
    id: string
    organization_id: string
    language: string
    status: GuideSession['status']
    problem_id: string | null
    citizen_id: string | null
    contact_json: unknown
    draft_json: unknown
  }>(
    `SELECT id, organization_id, language, status, problem_id, citizen_id, contact_json, draft_json
     FROM guide_sessions WHERE id = $1 AND organization_id = $2`,
    [id, orgId],
  )
  const row = res.rows[0]
  if (!row) return null
  const raw = row.contact_json && typeof row.contact_json === 'object'
    ? (row.contact_json as Record<string, unknown>)
    : {}
  return {
    id: row.id,
    organization_id: row.organization_id,
    language: asLang(row.language),
    status: row.status,
    problem_id: row.problem_id,
    citizen_id: row.citizen_id ?? null,
    phase: asPhase(raw._intake_phase),
    contact: asContact(row.contact_json),
    draft: asDraft(row.draft_json),
  }
}

export async function listGuideMessages(sessionId: string): Promise<GuideMessage[]> {
  const res = await dbQuery<GuideMessage>(
    `SELECT id, role, body, created_at FROM guide_messages WHERE session_id = $1 ORDER BY created_at ASC`,
    [sessionId],
  )
  return res.rows
}

export async function appendGuideMessage(sessionId: string, role: 'user' | 'assistant', body: string): Promise<void> {
  await dbQuery(
    `INSERT INTO guide_messages (session_id, role, body) VALUES ($1, $2, $3)`,
    [sessionId, role, body],
  )
}

export async function saveGuideSession(session: GuideSession): Promise<void> {
  await dbQuery(
    `UPDATE guide_sessions
     SET language = $2, status = $3, problem_id = $4, contact_json = $5::jsonb, draft_json = $6::jsonb,
         citizen_id = COALESCE($7, citizen_id), updated_at = now()
     WHERE id = $1`,
    [
      session.id,
      session.language,
      session.status,
      session.problem_id,
      JSON.stringify(contactPayload(session)),
      session.draft ? JSON.stringify(session.draft) : null,
      session.citizen_id,
    ],
  )
}

export async function previousGuideTopic(orgId: string, phone: string, exceptId: string): Promise<string | null> {
  const res = await dbQuery<{ problem_id: string | null; status: string; updated_at: string }>(
    `SELECT problem_id, status, updated_at::text AS updated_at
     FROM guide_sessions
     WHERE organization_id = $1 AND contact_json->>'phone' = $2 AND id <> $3 AND problem_id IS NOT NULL
     ORDER BY updated_at DESC LIMIT 1`,
    [orgId, phone, exceptId],
  )
  const row = res.rows[0]
  if (!row?.problem_id) return null
  return `${row.problem_id} (${row.status}, ${row.updated_at.slice(0, 10)})`
}

export interface PriorGuideCase {
  id: string
  problem_id: string | null
  status: string
  summary: string
  updated_at: string
}

/** Recent guide chats for this phone — for “which complaint / start new?”. */
export async function listPriorGuideCases(
  orgId: string,
  phone: string,
  exceptId: string,
  limit = 5,
): Promise<PriorGuideCase[]> {
  const res = await dbQuery<{
    id: string
    problem_id: string | null
    status: string
    contact_json: unknown
    updated_at: string
  }>(
    `SELECT id, problem_id, status, contact_json, updated_at::text AS updated_at
     FROM guide_sessions
     WHERE organization_id = $1
       AND contact_json->>'phone' = $2
       AND id <> $3
       AND (
         problem_id IS NOT NULL
         OR coalesce(contact_json->>'problem_summary', '') <> ''
       )
     ORDER BY updated_at DESC
     LIMIT $4`,
    [orgId, phone, exceptId, limit],
  )
  return res.rows.map((row) => {
    const contact = asContact(row.contact_json)
    const summary =
      contact.problem_summary?.slice(0, 60) ||
      row.problem_id ||
      'earlier chat'
    return {
      id: row.id,
      problem_id: row.problem_id,
      status: row.status,
      summary,
      updated_at: row.updated_at.slice(0, 10),
    }
  })
}

/** Incomplete open session for this phone (mid ladder or mid help). */
export async function findIncompleteGuideSession(
  orgId: string,
  phone: string,
  exceptId: string,
): Promise<PriorGuideCase | null> {
  const res = await dbQuery<{
    id: string
    problem_id: string | null
    status: string
    contact_json: unknown
    updated_at: string
  }>(
    `SELECT id, problem_id, status, contact_json, updated_at::text AS updated_at
     FROM guide_sessions
     WHERE organization_id = $1
       AND contact_json->>'phone' = $2
       AND id <> $3
       AND status = 'open'
       AND (
         coalesce(contact_json->>'name', '') <> ''
         OR coalesce(contact_json->>'problem_summary', '') <> ''
         OR problem_id IS NOT NULL
       )
     ORDER BY updated_at DESC
     LIMIT 1`,
    [orgId, phone, exceptId],
  )
  const row = res.rows[0]
  if (!row) return null
  const contact = asContact(row.contact_json)
  return {
    id: row.id,
    problem_id: row.problem_id,
    status: row.status,
    summary: contact.problem_summary?.slice(0, 60) || row.problem_id || 'unfinished chat',
    updated_at: row.updated_at.slice(0, 10),
  }
}
