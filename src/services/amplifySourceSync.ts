import type { SupabaseClient } from '@supabase/supabase-js'
import { createSupabaseServiceClient } from '@/lib/supabase.js'
import { isPostgresMode, dbQuery } from '@/lib/db.js'

export interface AmplifySourceAttachmentMeta {
  ticket_attachment_id: string
  file_name: string
  mime_type: string | null
  attachment_type: string | null
  file_size_bytes: number | null
  created_at: string
  origin: 'citizen' | 'staff'
  uploader_name: string | null
}

export interface AmplifySourceFieldNoteMeta {
  note_id: string
  note_type: string
  author_name: string | null
  created_at: string
  is_internal: boolean
}

export interface AmplifySourceItem {
  id: string
  source_type: string
  source_content: string | null
  included: boolean
  source_ref_id: string | null
  attachment: AmplifySourceAttachmentMeta | null
  field_note: AmplifySourceFieldNoteMeta | null
}

type TicketAttachmentRow = {
  id: string
  file_name: string
  mime_type: string | null
  attachment_type: string | null
  file_size_bytes: number | null
  created_at: string
  uploaded_by: string | null
  uploader_name?: string | null
}

type TicketNoteRow = {
  id: string
  note_type: string
  content: string
  is_internal: boolean
  created_at: string
  author_name: string | null
}

type TicketCaseContext = {
  ticket_number: string
  title: string | null
  source_channel: string | null
  location_text: string | null
  address_text: string | null
  map_link: string | null
  latitude: number | null
  longitude: number | null
  severity: string | null
  department: string | null
  stage: string | null
  sub_status: string | null
  outcome: string | null
  category_name: string | null
  subcategory_name: string | null
  territory_name: string | null
  critical_flag: boolean
  public_use_consent_status: string | null
}

type TranscriptRow = {
  id: string
  transcript: string
}

export function formatAttachmentSourceContent(meta: AmplifySourceAttachmentMeta): string {
  const originLabel =
    meta.origin === 'citizen'
      ? 'citizen intake (e.g. WhatsApp/Telegram)'
      : `staff upload${meta.uploader_name ? ` by ${meta.uploader_name}` : ''}`
  return (
    `[Attachment: ${meta.file_name}] ` +
    `type=${meta.attachment_type ?? 'other'}, ` +
    `mime=${meta.mime_type ?? 'unknown'}, ` +
    `size=${meta.file_size_bytes ?? 'unknown'} bytes, ` +
    `from ${originLabel}. ` +
    `File is on the ticket; visual/audio content is not auto-analyzed in Amplify v1 — ` +
    `reference filename and type only unless you add a description in extra context.`
  )
}

export function formatFieldNoteSourceContent(meta: TicketNoteRow): string {
  const visibility = meta.is_internal ? 'internal' : 'citizen-visible'
  const author = meta.author_name ? ` by ${meta.author_name}` : ''
  return (
    `[Field note: ${meta.note_type}] (${visibility})${author} ${meta.created_at}\n` +
    meta.content.trim()
  )
}

export function formatCaseMetadataSourceContent(ctx: TicketCaseContext): string {
  const lines: string[] = [
    `ticket: ${ctx.ticket_number}${ctx.title ? ` — ${ctx.title}` : ''}`,
  ]
  if (ctx.source_channel) lines.push(`source_channel: ${ctx.source_channel}`)
  if (ctx.category_name) lines.push(`category: ${ctx.category_name}`)
  if (ctx.subcategory_name) lines.push(`subcategory: ${ctx.subcategory_name}`)
  if (ctx.severity) lines.push(`severity: ${ctx.severity}`)
  if (ctx.department) lines.push(`department: ${ctx.department}`)
  if (ctx.territory_name) lines.push(`territory: ${ctx.territory_name}`)
  if (ctx.stage) lines.push(`stage: ${ctx.stage}`)
  if (ctx.sub_status) lines.push(`sub_status: ${ctx.sub_status}`)
  if (ctx.outcome) lines.push(`outcome: ${ctx.outcome}`)
  if (ctx.critical_flag) lines.push('critical_flag: true')
  if (ctx.public_use_consent_status) {
    lines.push(`public_use_consent: ${ctx.public_use_consent_status}`)
  }

  const locParts: string[] = []
  if (ctx.location_text) locParts.push(`location_text: ${ctx.location_text}`)
  if (ctx.address_text) locParts.push(`address: ${ctx.address_text}`)
  if (ctx.latitude != null && ctx.longitude != null) {
    locParts.push(`coordinates: ${ctx.latitude}, ${ctx.longitude}`)
  }
  if (ctx.map_link) locParts.push(`map_link: ${ctx.map_link}`)
  if (locParts.length) {
    lines.push('--- location ---')
    lines.push(...locParts)
  }

  return lines.join('\n')
}

function toAttachmentMeta(row: TicketAttachmentRow): AmplifySourceAttachmentMeta {
  return {
    ticket_attachment_id: row.id,
    file_name: row.file_name,
    mime_type: row.mime_type,
    attachment_type: row.attachment_type,
    file_size_bytes: row.file_size_bytes,
    created_at: row.created_at,
    origin: row.uploaded_by ? 'staff' : 'citizen',
    uploader_name: row.uploader_name ?? null,
  }
}

function toFieldNoteMeta(row: TicketNoteRow): AmplifySourceFieldNoteMeta {
  return {
    note_id: row.id,
    note_type: row.note_type,
    author_name: row.author_name,
    created_at: row.created_at,
    is_internal: row.is_internal,
  }
}

async function listTicketAttachmentsForAmplify(
  ticketId: string,
): Promise<TicketAttachmentRow[]> {
  if (isPostgresMode()) {
    const res = await dbQuery<TicketAttachmentRow>(
      `SELECT ta.id, ta.file_name, ta.mime_type, ta.attachment_type, ta.file_size_bytes,
              ta.created_at, ta.uploaded_by, u.full_name AS uploader_name
       FROM ticket_attachments ta
       LEFT JOIN users u ON u.id = ta.uploaded_by
       WHERE ta.ticket_id = $1
       ORDER BY ta.created_at ASC`,
      [ticketId],
    )
    return res.rows
  }

  const supabase = createSupabaseServiceClient()
  const { data } = await supabase
    .from('ticket_attachments')
    .select(
      `
      id, file_name, mime_type, attachment_type, file_size_bytes, created_at, uploaded_by,
      uploader:users!ticket_attachments_uploaded_by_fkey(full_name)
    `,
    )
    .eq('ticket_id', ticketId)
    .order('created_at', { ascending: true })

  return (data ?? []).map((row) => {
    const uploader = row.uploader as { full_name?: string } | null
    return {
      id: row.id as string,
      file_name: row.file_name as string,
      mime_type: (row.mime_type as string | null) ?? null,
      attachment_type: (row.attachment_type as string | null) ?? null,
      file_size_bytes: (row.file_size_bytes as number | null) ?? null,
      created_at: row.created_at as string,
      uploaded_by: (row.uploaded_by as string | null) ?? null,
      uploader_name: uploader?.full_name ?? null,
    }
  })
}

async function listTicketNotesForAmplify(ticketId: string): Promise<TicketNoteRow[]> {
  if (isPostgresMode()) {
    const res = await dbQuery<TicketNoteRow>(
      `SELECT tn.id, tn.note_type, tn.content, tn.is_internal, tn.created_at,
              u.full_name AS author_name
       FROM ticket_notes tn
       LEFT JOIN users u ON u.id = tn.author_user_id
       WHERE tn.ticket_id = $1 AND tn.soft_deleted = false
       ORDER BY tn.created_at ASC`,
      [ticketId],
    )
    return res.rows
  }

  const supabase = createSupabaseServiceClient()
  const { data } = await supabase
    .from('ticket_notes')
    .select(
      `
      id, note_type, content, is_internal, created_at,
      author:users!ticket_notes_author_user_id_fkey(full_name)
    `,
    )
    .eq('ticket_id', ticketId)
    .eq('soft_deleted', false)
    .order('created_at', { ascending: true })

  return (data ?? []).map((row) => {
    const author = row.author as { full_name?: string } | null
    return {
      id: row.id as string,
      note_type: row.note_type as string,
      content: row.content as string,
      is_internal: row.is_internal === true,
      created_at: row.created_at as string,
      author_name: author?.full_name ?? null,
    }
  })
}

async function loadTicketCaseContext(ticketId: string): Promise<TicketCaseContext | null> {
  if (isPostgresMode()) {
    const res = await dbQuery<TicketCaseContext>(
      `SELECT
         t.ticket_number, t.title, t.source_channel,
         t.location_text, t.address_text, t.map_link, t.latitude, t.longitude,
         t.severity, t.department, t.stage, t.sub_status, t.outcome,
         t.critical_flag, t.public_use_consent_status,
         cat.name AS category_name,
         subcat.name AS subcategory_name,
         terr.name AS territory_name
       FROM tickets t
       LEFT JOIN issue_categories cat ON cat.id = t.category_id
       LEFT JOIN issue_categories subcat ON subcat.id = t.subcategory_id
       LEFT JOIN territories terr ON terr.id = t.territory_id
       WHERE t.id = $1`,
      [ticketId],
    )
    return res.rows[0] ?? null
  }

  const supabase = createSupabaseServiceClient()
  const { data } = await supabase
    .from('tickets')
    .select(
      `
      ticket_number, title, source_channel,
      location_text, address_text, map_link, latitude, longitude,
      severity, department, stage, sub_status, outcome,
      critical_flag, public_use_consent_status,
      category:issue_categories!tickets_category_id_fkey(name),
      subcategory:issue_categories!tickets_subcategory_id_fkey(name),
      territory:territories(name)
    `,
    )
    .eq('id', ticketId)
    .maybeSingle()

  if (!data) return null

  const category = data.category as { name?: string } | null
  const subcategory = data.subcategory as { name?: string } | null
  const territory = data.territory as { name?: string } | null

  return {
    ticket_number: data.ticket_number as string,
    title: (data.title as string | null) ?? null,
    source_channel: (data.source_channel as string | null) ?? null,
    location_text: (data.location_text as string | null) ?? null,
    address_text: (data.address_text as string | null) ?? null,
    map_link: (data.map_link as string | null) ?? null,
    latitude: (data.latitude as number | null) ?? null,
    longitude: (data.longitude as number | null) ?? null,
    severity: (data.severity as string | null) ?? null,
    department: (data.department as string | null) ?? null,
    stage: (data.stage as string | null) ?? null,
    sub_status: (data.sub_status as string | null) ?? null,
    outcome: (data.outcome as string | null) ?? null,
    category_name: category?.name ?? null,
    subcategory_name: subcategory?.name ?? null,
    territory_name: territory?.name ?? null,
    critical_flag: data.critical_flag === true,
    public_use_consent_status: (data.public_use_consent_status as string | null) ?? null,
  }
}

async function loadLatestTranscript(ticketId: string): Promise<TranscriptRow | null> {
  if (isPostgresMode()) {
    const res = await dbQuery<TranscriptRow>(
      `SELECT id, transcript
       FROM ai_ticket_suggestions
       WHERE ticket_id = $1
         AND transcript IS NOT NULL
         AND trim(transcript) <> ''
         AND status = 'completed'
       ORDER BY created_at DESC
       LIMIT 1`,
      [ticketId],
    )
    return res.rows[0] ?? null
  }

  const supabase = createSupabaseServiceClient()
  const { data } = await supabase
    .from('ai_ticket_suggestions')
    .select('id, transcript')
    .eq('ticket_id', ticketId)
    .eq('status', 'completed')
    .not('transcript', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!data?.transcript || !String(data.transcript).trim()) return null
  return { id: data.id as string, transcript: String(data.transcript).trim() }
}

async function existingRefIds(
  db: SupabaseClient,
  sessionId: string,
  sourceType: string,
): Promise<Set<string>> {
  const { data } = await db
    .from('amplify_source_selections')
    .select('source_ref_id')
    .eq('session_id', sessionId)
    .eq('source_type', sourceType)

  return new Set(
    (data ?? [])
      .map((r) => r.source_ref_id as string | null)
      .filter((id): id is string => !!id),
  )
}

/** Sync attachments, notes, transcript, and case metadata from the ticket. */
export async function syncAllAmplifySourcesFromTicket(
  sessionId: string,
  ticketId: string,
  supabase?: SupabaseClient,
): Promise<void> {
  const db = supabase ?? createSupabaseServiceClient()
  await Promise.all([
    syncTicketAttachmentsToAmplifySources(sessionId, ticketId, db),
    syncFieldNotesToAmplifySources(sessionId, ticketId, db),
    syncTranscriptToAmplifySources(sessionId, ticketId, db),
    syncCaseMetadataToAmplifySources(sessionId, ticketId, db),
  ])
}

export async function seedAmplifySourcesForSession(
  sessionId: string,
  ticket: { original_issue_text: string | null; normalized_summary: string | null },
  ticketId: string,
  supabase?: SupabaseClient,
): Promise<void> {
  const db = supabase ?? createSupabaseServiceClient()

  const textSeeds: Array<{
    source_type: string
    source_content: string
    included: boolean
  }> = []
  if (ticket.original_issue_text?.trim()) {
    textSeeds.push({
      source_type: 'complaint_text',
      source_content: ticket.original_issue_text.trim(),
      included: true,
    })
  }
  if (ticket.normalized_summary?.trim()) {
    textSeeds.push({
      source_type: 'normalized_summary',
      source_content: ticket.normalized_summary.trim(),
      included: true,
    })
  }

  if (textSeeds.length) {
    await db.from('amplify_source_selections').insert(
      textSeeds.map((s) => ({
        session_id: sessionId,
        source_type: s.source_type,
        source_content: s.source_content,
        included: s.included,
      })),
    )
  }

  await syncAllAmplifySourcesFromTicket(sessionId, ticketId, db)
}

export async function syncTicketAttachmentsToAmplifySources(
  sessionId: string,
  ticketId: string,
  supabase?: SupabaseClient,
): Promise<void> {
  const db = supabase ?? createSupabaseServiceClient()
  const attachments = await listTicketAttachmentsForAmplify(ticketId)
  if (!attachments.length) return

  const existingIds = await existingRefIds(db, sessionId, 'attachment')

  const toInsert = attachments
    .filter((a) => !existingIds.has(a.id))
    .map((a) => {
      const meta = toAttachmentMeta(a)
      return {
        session_id: sessionId,
        source_type: 'attachment' as const,
        source_ref_id: a.id,
        source_content: formatAttachmentSourceContent(meta),
        included: false,
        pii_warning: true,
      }
    })

  if (toInsert.length) {
    await db.from('amplify_source_selections').insert(toInsert)
  }
}

export async function syncFieldNotesToAmplifySources(
  sessionId: string,
  ticketId: string,
  supabase?: SupabaseClient,
): Promise<void> {
  const db = supabase ?? createSupabaseServiceClient()
  const notes = await listTicketNotesForAmplify(ticketId)
  if (!notes.length) return

  const existingIds = await existingRefIds(db, sessionId, 'field_note')

  const toInsert = notes
    .filter((n) => !existingIds.has(n.id))
    .map((n) => ({
      session_id: sessionId,
      source_type: 'field_note' as const,
      source_ref_id: n.id,
      source_content: formatFieldNoteSourceContent(n),
      included: false,
      pii_warning: n.is_internal,
    }))

  if (toInsert.length) {
    await db.from('amplify_source_selections').insert(toInsert)
  }
}

export async function syncTranscriptToAmplifySources(
  sessionId: string,
  ticketId: string,
  supabase?: SupabaseClient,
): Promise<void> {
  const db = supabase ?? createSupabaseServiceClient()
  const latest = await loadLatestTranscript(ticketId)

  const { data: existing } = await db
    .from('amplify_source_selections')
    .select('id, source_ref_id')
    .eq('session_id', sessionId)
    .eq('source_type', 'transcript')
    .maybeSingle()

  if (!latest) {
    if (existing?.id) {
      await db.from('amplify_source_selections').delete().eq('id', existing.id)
    }
    return
  }

  const payload = {
    source_ref_id: latest.id,
    source_content: latest.transcript,
  }

  if (existing?.id) {
    await db.from('amplify_source_selections').update(payload).eq('id', existing.id)
    return
  }

  await db.from('amplify_source_selections').insert({
    session_id: sessionId,
    source_type: 'transcript',
    included: true,
    ...payload,
  })
}

export async function syncCaseMetadataToAmplifySources(
  sessionId: string,
  ticketId: string,
  supabase?: SupabaseClient,
): Promise<void> {
  const db = supabase ?? createSupabaseServiceClient()
  const ctx = await loadTicketCaseContext(ticketId)
  if (!ctx) return

  const content = formatCaseMetadataSourceContent(ctx)

  const { data: existing } = await db
    .from('amplify_source_selections')
    .select('id')
    .eq('session_id', sessionId)
    .eq('source_type', 'case_metadata')
    .maybeSingle()

  if (existing?.id) {
    await db
      .from('amplify_source_selections')
      .update({ source_content: content, source_ref_id: ticketId })
      .eq('id', existing.id)
    return
  }

  await db.from('amplify_source_selections').insert({
    session_id: sessionId,
    source_type: 'case_metadata',
    source_ref_id: ticketId,
    source_content: content,
    included: true,
  })
}

type RawSourceRow = {
  id: string
  source_type: string
  source_content: string | null
  included: boolean
  source_ref_id: string | null
}

const SOURCE_SORT_ORDER: Record<string, number> = {
  complaint_text: 1,
  normalized_summary: 2,
  transcript: 3,
  case_metadata: 4,
  field_note: 5,
  attachment: 6,
}

export function sortAmplifySources<T extends { source_type: string; id: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const oa = SOURCE_SORT_ORDER[a.source_type] ?? 99
    const ob = SOURCE_SORT_ORDER[b.source_type] ?? 99
    if (oa !== ob) return oa - ob
    return a.id.localeCompare(b.id)
  })
}

export async function enrichAmplifySources(
  sources: RawSourceRow[],
  ticketId: string,
): Promise<AmplifySourceItem[]> {
  const attachmentRefIds = sources
    .filter((s) => s.source_type === 'attachment' && s.source_ref_id)
    .map((s) => s.source_ref_id as string)

  const noteRefIds = sources
    .filter((s) => s.source_type === 'field_note' && s.source_ref_id)
    .map((s) => s.source_ref_id as string)

  const attachmentById = new Map<string, TicketAttachmentRow>()
  if (attachmentRefIds.length) {
    const all = await listTicketAttachmentsForAmplify(ticketId)
    for (const row of all) {
      if (attachmentRefIds.includes(row.id)) attachmentById.set(row.id, row)
    }
  }

  const noteById = new Map<string, TicketNoteRow>()
  if (noteRefIds.length) {
    const all = await listTicketNotesForAmplify(ticketId)
    for (const row of all) {
      if (noteRefIds.includes(row.id)) noteById.set(row.id, row)
    }
  }

  return sortAmplifySources(sources).map((s) => {
    const base = { ...s, attachment: null as AmplifySourceAttachmentMeta | null, field_note: null as AmplifySourceFieldNoteMeta | null }

    if (s.source_type === 'attachment' && s.source_ref_id) {
      const row = attachmentById.get(s.source_ref_id)
      if (row) base.attachment = toAttachmentMeta(row)
    }

    if (s.source_type === 'field_note' && s.source_ref_id) {
      const row = noteById.get(s.source_ref_id)
      if (row) base.field_note = toFieldNoteMeta(row)
    }

    return base
  })
}

export async function updateAmplifySourceSelections(
  orgId: string,
  sessionId: string,
  updates: Array<{ id: string; included: boolean }>,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  if (!updates.length) {
    return { ok: false, status: 400, error: 'sources array is required' }
  }

  const supabase = createSupabaseServiceClient()
  const { data: session } = await supabase
    .from('amplify_sessions')
    .select('id, organization_id')
    .eq('id', sessionId)
    .single()

  if (!session || session.organization_id !== orgId) {
    return { ok: false, status: 404, error: 'Session not found' }
  }

  for (const row of updates) {
    if (!row.id || typeof row.included !== 'boolean') {
      return { ok: false, status: 400, error: 'Each source needs id and included' }
    }
    const { data: updated, error } = await supabase
      .from('amplify_source_selections')
      .update({ included: row.included })
      .eq('id', row.id)
      .eq('session_id', sessionId)
      .select('id')
      .maybeSingle()

    if (error) {
      return { ok: false, status: 500, error: error.message }
    }
    if (!updated) {
      return { ok: false, status: 404, error: `Source not found: ${row.id}` }
    }
  }

  return { ok: true }
}
