import { createSupabaseServiceClient } from '@/lib/supabase.js'
import { isPostgresMode, dbQuery } from '@/lib/db.js'
import {
  generateAmplifyContent,
  PLATFORMS,
  TONES,
  VALID_TONE_KEYS,
  type AmplifyPlatform,
  type AmplifyTone,
} from '@/services/amplifyService.js'

export const AMPLIFY_ALLOWED_ROLES = ['super_admin', 'central_support']

export function canAccessAmplify(role: string | null | undefined): boolean {
  return !!role && AMPLIFY_ALLOWED_ROLES.includes(role)
}

export interface AmplifySessionListItem {
  id: string
  status: string
  created_at: string
  updated_at: string
  tickets: { id: string; ticket_number: string; title: string | null } | null
  users: { full_name: string } | null
}

export interface AmplifySessionDetail {
  id: string
  status: string
  created_at: string
  ticket_id: string
  organization_id: string
  tickets: {
    id: string
    ticket_number: string
    title: string | null
    original_issue_text: string | null
    normalized_summary: string | null
    location_text: string | null
    latitude: number | null
    longitude: number | null
    severity: string | null
  } | null
  sources: Array<{
    id: string
    source_type: string
    source_content: string | null
    included: boolean
  }>
  outputs: Array<{
    id: string
    output_format: string
    tone: string | null
    content: string
    model_used: string | null
    generated_at: string
    metadata_json: Record<string, unknown> | null
  }>
  platforms: typeof PLATFORMS
  tones: typeof TONES
}

export async function listAmplifySessions(
  orgId: string,
): Promise<{ sessions: AmplifySessionListItem[]; count: number }> {
  if (isPostgresMode()) {
    return listAmplifySessionsPg(orgId)
  }
  return listAmplifySessionsSupabase(orgId)
}

async function listAmplifySessionsPg(
  orgId: string,
): Promise<{ sessions: AmplifySessionListItem[]; count: number }> {
  const countRes = await dbQuery<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM amplify_sessions WHERE organization_id = $1`,
    [orgId],
  )
  const count = Number(countRes.rows[0]?.c ?? 0)

  const res = await dbQuery<{
    id: string
    status: string
    created_at: string
    updated_at: string
    tickets: AmplifySessionListItem['tickets']
    users: AmplifySessionListItem['users']
  }>(
    `SELECT
       s.id, s.status, s.created_at, s.updated_at,
       CASE WHEN t.id IS NOT NULL THEN
         jsonb_build_object('id', t.id, 'ticket_number', t.ticket_number, 'title', t.title)
       END AS tickets,
       CASE WHEN u.id IS NOT NULL THEN jsonb_build_object('full_name', u.full_name) END AS users
     FROM amplify_sessions s
     LEFT JOIN tickets t ON t.id = s.ticket_id
     LEFT JOIN users u ON u.id = s.created_by
     WHERE s.organization_id = $1
     ORDER BY s.created_at DESC
     LIMIT 50`,
    [orgId],
  )

  return { sessions: res.rows, count }
}

async function listAmplifySessionsSupabase(
  orgId: string,
): Promise<{ sessions: AmplifySessionListItem[]; count: number }> {
  const supabase = createSupabaseServiceClient()
  const { data, count } = await supabase
    .from('amplify_sessions')
    .select(
      `
      id, status, created_at, updated_at,
      tickets(id, ticket_number, title),
      users!amplify_sessions_created_by_fkey(full_name)
    `,
      { count: 'exact' },
    )
    .eq('organization_id', orgId)
    .order('created_at', { ascending: false })
    .limit(50)

  return {
    sessions: (data ?? []) as unknown as AmplifySessionListItem[],
    count: count ?? 0,
  }
}

export async function getAmplifySession(
  orgId: string,
  sessionId: string,
): Promise<AmplifySessionDetail | null> {
  if (isPostgresMode()) {
    return getAmplifySessionPg(orgId, sessionId)
  }
  return getAmplifySessionSupabase(orgId, sessionId)
}

async function getAmplifySessionPg(
  orgId: string,
  sessionId: string,
): Promise<AmplifySessionDetail | null> {
  const sessionRes = await dbQuery<{
    id: string
    status: string
    created_at: string
    ticket_id: string
    organization_id: string
    tickets: AmplifySessionDetail['tickets']
  }>(
    `SELECT
       s.id, s.status, s.created_at, s.ticket_id, s.organization_id,
       jsonb_build_object(
         'id', t.id,
         'ticket_number', t.ticket_number,
         'title', t.title,
         'original_issue_text', t.original_issue_text,
         'normalized_summary', t.normalized_summary,
         'location_text', t.location_text,
         'latitude', t.latitude,
         'longitude', t.longitude,
         'severity', t.severity
       ) AS tickets
     FROM amplify_sessions s
     INNER JOIN tickets t ON t.id = s.ticket_id
     WHERE s.id = $1 AND s.organization_id = $2`,
    [sessionId, orgId],
  )

  const session = sessionRes.rows[0]
  if (!session) return null

  const [sourcesRes, outputsRes] = await Promise.all([
    dbQuery<AmplifySessionDetail['sources'][0]>(
      `SELECT id, source_type, source_content, included
       FROM amplify_source_selections
       WHERE session_id = $1`,
      [sessionId],
    ),
    dbQuery<AmplifySessionDetail['outputs'][0]>(
      `SELECT id, output_format, tone, content, model_used, generated_at, metadata_json
       FROM amplify_generated_outputs
       WHERE session_id = $1
       ORDER BY generated_at DESC`,
      [sessionId],
    ),
  ])

  return {
    id: session.id,
    status: session.status,
    created_at: session.created_at,
    ticket_id: session.ticket_id,
    organization_id: session.organization_id,
    tickets: session.tickets,
    sources: sourcesRes.rows,
    outputs: outputsRes.rows.map((o: AmplifySessionDetail['outputs'][0]) => ({
      ...o,
      metadata_json: (o.metadata_json as Record<string, unknown> | null) ?? null,
    })),
    platforms: PLATFORMS,
    tones: TONES,
  }
}

async function getAmplifySessionSupabase(
  orgId: string,
  sessionId: string,
): Promise<AmplifySessionDetail | null> {
  const supabase = createSupabaseServiceClient()

  const { data: session } = await supabase
    .from('amplify_sessions')
    .select(
      `
      id, status, created_at, ticket_id, organization_id,
      tickets(
        id, ticket_number, title,
        original_issue_text, normalized_summary,
        location_text, latitude, longitude, severity
      )
    `,
    )
    .eq('id', sessionId)
    .maybeSingle()

  if (!session || session.organization_id !== orgId) return null

  const [{ data: sources }, { data: outputs }] = await Promise.all([
    supabase
      .from('amplify_source_selections')
      .select('id, source_type, source_content, included')
      .eq('session_id', sessionId),
    supabase
      .from('amplify_generated_outputs')
      .select('id, output_format, tone, content, model_used, generated_at, metadata_json')
      .eq('session_id', sessionId)
      .order('generated_at', { ascending: false }),
  ])

  const ticket = Array.isArray(session.tickets) ? session.tickets[0] : session.tickets

  return {
    id: session.id,
    status: session.status,
    created_at: session.created_at,
    ticket_id: session.ticket_id,
    organization_id: session.organization_id,
    tickets: ticket ?? null,
    sources: sources ?? [],
    outputs: (outputs ?? []) as AmplifySessionDetail['outputs'],
    platforms: PLATFORMS,
    tones: TONES,
  }
}

export async function createAmplifySession(
  user: { id: string; organization_id: string },
  ticketId: string,
): Promise<{ ok: true; id: string; reused: boolean } | { ok: false; status: number; error: string }> {
  const supabase = createSupabaseServiceClient()

  const { data: ticket } = await supabase
    .from('tickets')
    .select('id, organization_id, original_issue_text, normalized_summary, stage')
    .eq('id', ticketId)
    .single()

  if (!ticket || ticket.organization_id !== user.organization_id) {
    return { ok: false, status: 404, error: 'Ticket not found' }
  }

  const { data: existing } = await supabase
    .from('amplify_sessions')
    .select('id')
    .eq('ticket_id', ticketId)
    .eq('status', 'draft')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (existing) {
    return { ok: true, id: existing.id as string, reused: true }
  }

  const { data: session, error } = await supabase
    .from('amplify_sessions')
    .insert({
      ticket_id: ticketId,
      organization_id: user.organization_id,
      created_by: user.id,
      status: 'draft',
    })
    .select('id')
    .single()

  if (error || !session) {
    return { ok: false, status: 500, error: error?.message ?? 'Insert failed' }
  }

  const seeds: Array<{ source_type: string; source_content: string | null }> = []
  if (ticket.original_issue_text) {
    seeds.push({ source_type: 'complaint_text', source_content: ticket.original_issue_text })
  }
  if (ticket.normalized_summary) {
    seeds.push({ source_type: 'normalized_summary', source_content: ticket.normalized_summary })
  }

  if (seeds.length) {
    await supabase.from('amplify_source_selections').insert(
      seeds.map((s) => ({
        session_id: session.id,
        source_type: s.source_type,
        source_content: s.source_content,
        included: true,
      })),
    )
  }

  await supabase.from('audit_logs').insert({
    organization_id: user.organization_id,
    event_type: 'amplify_session_created',
    entity_type: 'amplify_session',
    entity_id: session.id,
    actor_type: 'user',
    actor_user_id: user.id,
    new_value_json: { ticket_id: ticketId },
  })

  return { ok: true, id: session.id as string, reused: false }
}

export async function generateAmplifyDraft(
  user: { id: string; organization_id: string },
  sessionId: string,
  body: {
    platform: AmplifyPlatform
    tone?: AmplifyTone
    source_ids?: string[]
    extra_context?: string
  },
): Promise<
  | { ok: true; output: AmplifySessionDetail['outputs'][0] }
  | { ok: false; status: number; error: string }
> {
  const platformKeys = new Set(PLATFORMS.map((p) => p.key))
  const tone = body.tone ?? 'informative'

  if (!platformKeys.has(body.platform)) {
    return { ok: false, status: 400, error: 'Invalid platform' }
  }
  if (!VALID_TONE_KEYS.has(tone)) {
    return { ok: false, status: 400, error: 'Invalid tone' }
  }

  const supabase = createSupabaseServiceClient()

  const { data: session } = await supabase
    .from('amplify_sessions')
    .select('id, organization_id, ticket_id')
    .eq('id', sessionId)
    .single()

  if (!session || session.organization_id !== user.organization_id) {
    return { ok: false, status: 404, error: 'Session not found' }
  }

  let sourcesQuery = supabase
    .from('amplify_source_selections')
    .select('id, source_type, source_content, included')
    .eq('session_id', sessionId)
    .eq('included', true)

  if (Array.isArray(body.source_ids) && body.source_ids.length > 0) {
    sourcesQuery = sourcesQuery.in('id', body.source_ids)
  }

  const { data: sources } = await sourcesQuery

  const { data: ticket } = await supabase
    .from('tickets')
    .select(
      'ticket_number, title, original_issue_text, normalized_summary, location_text, latitude, longitude, severity',
    )
    .eq('id', session.ticket_id)
    .single()

  const labeledSources = (sources ?? []).map((s) => ({
    label: s.source_type,
    content: s.source_content ?? '',
  }))

  if (ticket) {
    labeledSources.push({
      label: 'ticket_meta',
      content: [
        `ticket: ${ticket.ticket_number}${ticket.title ? ` (${ticket.title})` : ''}`,
        ticket.location_text ? `location: ${ticket.location_text}` : null,
        ticket.severity ? `severity: ${ticket.severity}` : null,
      ]
        .filter(Boolean)
        .join('\n'),
    })
  }

  const result = await generateAmplifyContent({
    platform: body.platform,
    tone,
    sources: labeledSources,
    extraContext: body.extra_context,
  })

  const { data: output, error } = await supabase
    .from('amplify_generated_outputs')
    .insert({
      session_id: sessionId,
      output_format: body.platform,
      content: result.content,
      tone,
      model_used: result.model,
      generated_by: user.id,
      metadata_json: {
        fallback: result.fallback,
        error: result.error ?? null,
        source_count: labeledSources.length,
      },
    })
    .select('id, output_format, tone, content, model_used, generated_at, metadata_json')
    .single()

  if (error || !output) {
    return { ok: false, status: 500, error: error?.message ?? 'Insert failed' }
  }

  await supabase.from('audit_logs').insert({
    organization_id: user.organization_id,
    event_type: 'amplify_content_generated',
    entity_type: 'amplify_session',
    entity_id: sessionId,
    actor_type: 'user',
    actor_user_id: user.id,
    metadata_json: { platform: body.platform, tone, fallback: result.fallback },
  })

  return {
    ok: true,
    output: output as AmplifySessionDetail['outputs'][0],
  }
}
