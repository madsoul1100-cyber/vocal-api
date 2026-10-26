import { dbQuery } from '@/lib/db.js'
import type { GuideLang } from './playbooks.js'

export interface GuideContactInfo {
  name?: string
  phone?: string
  email?: string
  place?: string
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

function asContact(value: unknown): GuideContactInfo {
  if (!value || typeof value !== 'object') return {}
  const row = value as Record<string, unknown>
  const pick = (key: string) => (typeof row[key] === 'string' ? row[key] : undefined)
  return { name: pick('name'), phone: pick('phone'), email: pick('email'), place: pick('place') }
}

function asDraft(value: unknown): GuideDraft | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  if (typeof row.to !== 'string' || typeof row.subject !== 'string' || typeof row.body !== 'string') return null
  return { to: row.to, subject: row.subject, body: row.body }
}

export async function createGuideSession(orgId: string, language: GuideLang): Promise<GuideSession> {
  const res = await dbQuery<{ id: string }>(
    `INSERT INTO guide_sessions (organization_id, language) VALUES ($1, $2) RETURNING id`,
    [orgId, language],
  )
  return {
    id: res.rows[0].id,
    organization_id: orgId,
    language,
    status: 'open',
    problem_id: null,
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
    contact_json: unknown
    draft_json: unknown
  }>(
    `SELECT id, organization_id, language, status, problem_id, contact_json, draft_json
     FROM guide_sessions WHERE id = $1 AND organization_id = $2`,
    [id, orgId],
  )
  const row = res.rows[0]
  if (!row) return null
  return {
    id: row.id,
    organization_id: row.organization_id,
    language: asLang(row.language),
    status: row.status,
    problem_id: row.problem_id,
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
     SET language = $2, status = $3, problem_id = $4, contact_json = $5::jsonb, draft_json = $6::jsonb, updated_at = now()
     WHERE id = $1`,
    [
      session.id,
      session.language,
      session.status,
      session.problem_id,
      JSON.stringify(session.contact),
      session.draft ? JSON.stringify(session.draft) : null,
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
