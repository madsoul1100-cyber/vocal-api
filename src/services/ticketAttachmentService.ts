import { createSupabaseServiceClient } from '@/lib/supabase.js'
import { isPostgresMode, dbQuery } from '@/lib/db.js'
import {
  createTicketAttachmentUploadUrl,
  isValidTicketAttachmentStoragePath,
  signedUrlFor,
  signedUrlsFor,
  type TicketAttachmentUploadUrlResult,
  uploadWorkerAttachment,
  verifyTicketAttachmentObject,
} from '@/services/attachmentService.js'

function attachmentTypeFromMime(mime: string): TicketAttachmentItem['attachment_type'] {
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime === 'application/pdf' || mime.startsWith('application/')) return 'document'
  return 'other'
}
import type { NoteType } from '@/types/database.js'

const PRIVILEGED_ROLES = ['super_admin', 'central_support']
const NOTE_UPLOAD_ROLES = [...PRIVILEGED_ROLES, 'ground_worker']

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100
const NOTE_TYPES = new Set<NoteType>(['general', 'worker_update', 'escalation', 'system', 'closure'])

export interface TicketNoteItem {
  id: string
  ticket_id: string
  author_user_id: string | null
  author_name: string | null
  note_type: NoteType
  content: string
  is_internal: boolean
  created_at: string
}

export interface TicketAttachmentItem {
  id: string
  ticket_id: string
  file_name: string
  mime_type: string | null
  file_size_bytes: number | null
  attachment_type: 'image' | 'video' | 'audio' | 'document' | 'other' | null
  created_at: string
  preview_url: string | null
  legacy_telegram: boolean
}

export interface ListPagination {
  limit: number
  offset: number
  total: number
  hasNextPage: boolean
  hasPreviousPage: boolean
}

export interface ListTicketNotesAttachmentsOpts {
  limit?: number
  offset?: number
}

export interface ListTicketNotesAttachmentsResult {
  notes: TicketNoteItem[]
  attachments: TicketAttachmentItem[]
  notes_pagination: ListPagination
  attachments_pagination: ListPagination
  can_preview_media: boolean
}

export function canPreviewAttachmentMedia(
  role: string | null | undefined,
  citizenIdentityRevealedAt: string | null | undefined,
): boolean {
  if (role && PRIVILEGED_ROLES.includes(role)) return true
  if (role === 'ground_worker' && citizenIdentityRevealedAt) return true
  return false
}

function buildPagination(offset: number, limit: number, total: number): ListPagination {
  return {
    limit,
    offset,
    total,
    hasNextPage: offset + limit < total,
    hasPreviousPage: offset > 0,
  }
}

export function parseAttachmentsListQuery(query: Record<string, unknown>): {
  limit: number
  offset: number
} {
  let limit = parseInt(String(query.limit ?? DEFAULT_LIMIT), 10) || DEFAULT_LIMIT
  limit = Math.min(MAX_LIMIT, Math.max(1, limit))
  const offset = Math.max(0, parseInt(String(query.offset ?? '0'), 10) || 0)
  return { limit, offset }
}

export async function ticketHasAttachments(ticketId: string): Promise<boolean> {
  const supabase = createSupabaseServiceClient()
  const { count, error } = await supabase
    .from('ticket_attachments')
    .select('id', { count: 'exact', head: true })
    .eq('ticket_id', ticketId)

  if (error) {
    console.error('[ticketHasAttachments]', error)
    return false
  }
  return (count ?? 0) > 0
}

export async function ticketHasNotes(ticketId: string): Promise<boolean> {
  const supabase = createSupabaseServiceClient()
  const { count, error } = await supabase
    .from('ticket_notes')
    .select('id', { count: 'exact', head: true })
    .eq('ticket_id', ticketId)
    .eq('soft_deleted', false)

  if (error) {
    console.error('[ticketHasNotes]', error)
    return false
  }
  return (count ?? 0) > 0
}

type TicketLookup =
  | { ok: true; ticket: { id: string; citizen_identity_revealed_at: string | null } }
  | { ok: false; error: string }

async function assertTicketInOrg(ticketId: string, organizationId: string): Promise<TicketLookup> {
  const supabase = createSupabaseServiceClient()
  const { data, error } = await supabase
    .from('tickets')
    .select('id, citizen_identity_revealed_at')
    .eq('id', ticketId)
    .eq('organization_id', organizationId)
    .maybeSingle()

  if (error) return { ok: false, error: error.message }
  if (!data) return { ok: false, error: 'Ticket not found' }
  return { ok: true, ticket: data }
}

function mapNoteRow(r: {
  id: string
  ticket_id: string
  author_user_id: string | null
  note_type: string
  content: string
  is_internal: boolean
  created_at: string
  author_full_name?: string | null
  author?: { full_name?: string } | null
}): TicketNoteItem {
  const authorName =
    r.author_full_name ??
    (r.author && typeof r.author === 'object' ? r.author.full_name : null) ??
    null
  return {
    id: r.id,
    ticket_id: r.ticket_id,
    author_user_id: r.author_user_id,
    author_name: authorName ?? null,
    note_type: r.note_type as NoteType,
    content: r.content,
    is_internal: r.is_internal,
    created_at: r.created_at,
  }
}

function mapAttachmentRows(
  rows: Array<{
    id: string
    ticket_id: string
    file_name: string
    storage_path: string
    mime_type: string | null
    file_size_bytes: number | null
    attachment_type: string | null
    created_at: string
  }>,
  can_preview_media: boolean,
  signed: Record<string, string>,
): TicketAttachmentItem[] {
  return rows.map((r) => {
    const legacy = r.storage_path.startsWith('telegram:')
    return {
      id: r.id,
      ticket_id: r.ticket_id,
      file_name: r.file_name,
      mime_type: r.mime_type,
      file_size_bytes: r.file_size_bytes,
      attachment_type: (r.attachment_type as TicketAttachmentItem['attachment_type']) ?? null,
      created_at: r.created_at,
      preview_url: can_preview_media && !legacy ? (signed[r.storage_path] ?? null) : null,
      legacy_telegram: legacy,
    }
  })
}

async function listTicketNotesAndAttachmentsPg(
  ticketId: string,
  limit: number,
  offset: number,
  can_preview_media: boolean,
): Promise<
  | {
      notes: TicketNoteItem[]
      attachments: TicketAttachmentItem[]
      notesTotal: number
      attachmentsTotal: number
    }
  | { error: string }
> {
  try {
    const [notesCountRes, attachmentsCountRes, notesRes, attachmentsRes] = await Promise.all([
      dbQuery<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM ticket_notes
         WHERE ticket_id = $1 AND soft_deleted = false`,
        [ticketId],
      ),
      dbQuery<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM ticket_attachments WHERE ticket_id = $1`,
        [ticketId],
      ),
      dbQuery<{
        id: string
        ticket_id: string
        author_user_id: string | null
        note_type: string
        content: string
        is_internal: boolean
        created_at: string
        author_full_name: string | null
      }>(
        `SELECT tn.id, tn.ticket_id, tn.author_user_id, tn.note_type, tn.content, tn.is_internal,
                tn.created_at, u.full_name AS author_full_name
         FROM ticket_notes tn
         LEFT JOIN users u ON u.id = tn.author_user_id
         WHERE tn.ticket_id = $1 AND tn.soft_deleted = false
         ORDER BY tn.created_at DESC
         LIMIT $2 OFFSET $3`,
        [ticketId, limit, offset],
      ),
      dbQuery<{
        id: string
        ticket_id: string
        file_name: string
        storage_path: string
        mime_type: string | null
        file_size_bytes: number | null
        attachment_type: string | null
        created_at: string
      }>(
        `SELECT id, ticket_id, file_name, storage_path, mime_type, file_size_bytes,
                attachment_type, created_at
         FROM ticket_attachments
         WHERE ticket_id = $1
         ORDER BY created_at ASC
         LIMIT $2 OFFSET $3`,
        [ticketId, limit, offset],
      ),
    ])

    const notesTotal = Number(notesCountRes.rows[0]?.c ?? 0)
    const attachmentsTotal = Number(attachmentsCountRes.rows[0]?.c ?? 0)
    const paths = attachmentsRes.rows.map((r) => r.storage_path)
    const signed = can_preview_media ? await signedUrlsFor(paths) : {}

    return {
      notes: notesRes.rows.map(mapNoteRow),
      attachments: mapAttachmentRows(attachmentsRes.rows, can_preview_media, signed),
      notesTotal,
      attachmentsTotal,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Notes/attachments query failed'
    return { error: message }
  }
}

async function listTicketNotesAndAttachmentsSupabase(
  ticketId: string,
  limit: number,
  offset: number,
  can_preview_media: boolean,
): Promise<
  | {
      notes: TicketNoteItem[]
      attachments: TicketAttachmentItem[]
      notesTotal: number
      attachmentsTotal: number
    }
  | { error: string }
> {
  const supabase = createSupabaseServiceClient()

  const notesQuery = supabase
    .from('ticket_notes')
    .select(
      `
      id, ticket_id, author_user_id, note_type, content, is_internal, created_at,
      author:users!ticket_notes_author_user_id_fkey(full_name)
    `,
      { count: 'exact' },
    )
    .eq('ticket_id', ticketId)
    .eq('soft_deleted', false)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)

  const attachmentsQuery = supabase
    .from('ticket_attachments')
    .select(
      'id, ticket_id, file_name, storage_path, mime_type, file_size_bytes, attachment_type, created_at',
      { count: 'exact' },
    )
    .eq('ticket_id', ticketId)
    .order('created_at', { ascending: true })
    .range(offset, offset + limit - 1)

  const [notesRes, attachmentsRes] = await Promise.all([notesQuery, attachmentsQuery])

  if (notesRes.error) return { error: notesRes.error.message }
  if (attachmentsRes.error) return { error: attachmentsRes.error.message }

  const paths = (attachmentsRes.data ?? []).map((r) => r.storage_path as string)
  const signed = can_preview_media ? await signedUrlsFor(paths) : {}

  const notes = (notesRes.data ?? []).map((r) =>
    mapNoteRow({
      id: r.id as string,
      ticket_id: r.ticket_id as string,
      author_user_id: r.author_user_id as string | null,
      note_type: r.note_type as string,
      content: r.content as string,
      is_internal: r.is_internal as boolean,
      created_at: r.created_at as string,
      author: r.author as { full_name?: string } | null,
    }),
  )

  const attachments = mapAttachmentRows(
    (attachmentsRes.data ?? []).map((r) => ({
      id: r.id as string,
      ticket_id: r.ticket_id as string,
      file_name: r.file_name as string,
      storage_path: r.storage_path as string,
      mime_type: (r.mime_type as string | null) ?? null,
      file_size_bytes: (r.file_size_bytes as number | null) ?? null,
      attachment_type: (r.attachment_type as string | null) ?? null,
      created_at: r.created_at as string,
    })),
    can_preview_media,
    signed,
  )

  return {
    notes,
    attachments,
    notesTotal: notesRes.count ?? 0,
    attachmentsTotal: attachmentsRes.count ?? 0,
  }
}

/** Notes + attachments for one ticket (monolith page.tsx parity). */
export async function listTicketNotesAndAttachments(
  ticketId: string,
  organizationId: string,
  opts: ListTicketNotesAttachmentsOpts = {},
  viewerRole?: string | null,
): Promise<ListTicketNotesAttachmentsResult | { error: string }> {
  const ticketRes = await assertTicketInOrg(ticketId, organizationId)
  if (!ticketRes.ok) return { error: ticketRes.error }
  const ticket = ticketRes.ticket

  let limit = opts.limit ?? DEFAULT_LIMIT
  limit = Math.min(MAX_LIMIT, Math.max(1, limit))
  const offset = Math.max(0, opts.offset ?? 0)

  const can_preview_media = canPreviewAttachmentMedia(
    viewerRole,
    ticket.citizen_identity_revealed_at as string | null,
  )

  const listRes = isPostgresMode()
    ? await listTicketNotesAndAttachmentsPg(ticketId, limit, offset, can_preview_media)
    : await listTicketNotesAndAttachmentsSupabase(ticketId, limit, offset, can_preview_media)

  if ('error' in listRes) return { error: listRes.error }

  return {
    notes: listRes.notes,
    attachments: listRes.attachments,
    notes_pagination: buildPagination(offset, limit, listRes.notesTotal),
    attachments_pagination: buildPagination(offset, limit, listRes.attachmentsTotal),
    can_preview_media,
  }
}

export function canUploadTicketNotesOrAttachments(role: string | null | undefined): boolean {
  return !!role && NOTE_UPLOAD_ROLES.includes(role)
}

function parseNoteType(raw: unknown): NoteType {
  const t = typeof raw === 'string' ? raw.trim() : ''
  return NOTE_TYPES.has(t as NoteType) ? (t as NoteType) : 'general'
}

/** Create note and/or file in one request (monolith notes/upload). */
export async function createTicketNotesAndAttachments(
  ticketId: string,
  organizationId: string,
  userId: string,
  input: {
    content?: string
    note_type?: string
    is_internal?: boolean
    file?: { buffer: Buffer; originalname: string; mimetype: string }
  },
): Promise<
  | { note: TicketNoteItem | null; attachment: TicketAttachmentItem | null }
  | { error: string; status: number }
> {
  const content = input.content?.trim()
  const hasFile = !!input.file
  if (!content && !hasFile) {
    return { error: 'content or file required', status: 400 }
  }

  const ticketRes = await assertTicketInOrg(ticketId, organizationId)
  if (!ticketRes.ok) {
    return { error: ticketRes.error, status: ticketRes.error === 'Ticket not found' ? 404 : 500 }
  }

  const supabase = createSupabaseServiceClient()
  let note: TicketNoteItem | null = null
  let attachment: TicketAttachmentItem | null = null

  if (content) {
    const noteType = parseNoteType(input.note_type)
    const isInternal = input.is_internal !== false

    if (isPostgresMode()) {
      const ins = await dbQuery<{
        id: string
        ticket_id: string
        author_user_id: string | null
        note_type: string
        content: string
        is_internal: boolean
        created_at: string
        author_full_name: string | null
      }>(
        `INSERT INTO ticket_notes (ticket_id, author_user_id, note_type, content, is_internal)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, ticket_id, author_user_id, note_type, content, is_internal, created_at,
           (SELECT full_name FROM users WHERE id = $2) AS author_full_name`,
        [ticketId, userId, noteType, content, isInternal],
      )
      const row = ins.rows[0]
      if (!row) {
        return { error: 'Note insert failed', status: 500 }
      }
      note = mapNoteRow(row)
    } else {
      const { data: row, error: noteErr } = await supabase
        .from('ticket_notes')
        .insert({
          ticket_id: ticketId,
          author_user_id: userId,
          note_type: noteType,
          content,
          is_internal: isInternal,
        })
        .select(
          `
          id, ticket_id, author_user_id, note_type, content, is_internal, created_at,
          author:users!ticket_notes_author_user_id_fkey(full_name)
        `,
        )
        .single()

      if (noteErr || !row) {
        return { error: noteErr?.message ?? 'Note insert failed', status: 500 }
      }

      note = mapNoteRow({
        id: row.id as string,
        ticket_id: row.ticket_id as string,
        author_user_id: row.author_user_id as string | null,
        note_type: row.note_type as string,
        content: row.content as string,
        is_internal: row.is_internal as boolean,
        created_at: row.created_at as string,
        author: row.author as { full_name?: string } | null,
      })
    }

    await supabase.from('audit_logs').insert({
      organization_id: organizationId,
      event_type: 'ticket_note_added',
      entity_type: 'ticket',
      entity_id: ticketId,
      actor_type: 'user',
      actor_user_id: userId,
      new_value_json: { note_id: note.id, note_type: noteType, is_internal: isInternal },
    })
  }

  if (hasFile && input.file) {
    const mime = input.file.mimetype?.trim() || 'application/octet-stream'
    const stored = await uploadWorkerAttachment({
      bytes: input.file.buffer,
      filename: input.file.originalname,
      mime,
      org_id: organizationId,
      ticket_id: ticketId,
    })

    if (!stored) {
      return { error: 'Upload to storage failed', status: 500 }
    }

    const { data: row, error: insErr } = await supabase
      .from('ticket_attachments')
      .insert({
        ticket_id: ticketId,
        file_name: input.file.originalname,
        storage_path: stored.storage_path,
        mime_type: stored.mime_type,
        file_size_bytes: stored.size_bytes,
        attachment_type: stored.attachment_type,
        uploaded_by: userId,
      })
      .select('id, ticket_id, file_name, mime_type, file_size_bytes, attachment_type, created_at')
      .single()

    if (insErr || !row) {
      return { error: insErr?.message ?? 'Attachment insert failed', status: 500 }
    }

    const preview_url = await signedUrlFor(stored.storage_path)
    attachment = {
      id: row.id as string,
      ticket_id: row.ticket_id as string,
      file_name: row.file_name as string,
      mime_type: (row.mime_type as string | null) ?? null,
      file_size_bytes: (row.file_size_bytes as number | null) ?? null,
      attachment_type: (row.attachment_type as TicketAttachmentItem['attachment_type']) ?? null,
      created_at: row.created_at as string,
      preview_url,
      legacy_telegram: false,
    }
  }

  return { note, attachment }
}

export interface IssueTicketAttachmentUploadUrlInput {
  file_name: string
  mime_type: string
  file_size_bytes: number
}

/** Step 1: presigned PUT URL for direct browser upload (v2). */
export async function issueTicketAttachmentUploadUrl(
  ticketId: string,
  organizationId: string,
  input: IssueTicketAttachmentUploadUrlInput,
): Promise<TicketAttachmentUploadUrlResult | { error: string; status: number }> {
  const file_name = input.file_name?.trim()
  const mime_type = input.mime_type?.trim()
  if (!file_name || !mime_type) {
    return { error: 'file_name and mime_type required', status: 400 }
  }
  const file_size_bytes = Number(input.file_size_bytes)
  if (!Number.isFinite(file_size_bytes)) {
    return { error: 'file_size_bytes required', status: 400 }
  }

  const ticketRes = await assertTicketInOrg(ticketId, organizationId)
  if (!ticketRes.ok) {
    return {
      error: ticketRes.error,
      status: ticketRes.error === 'Ticket not found' ? 404 : 500,
    }
  }

  const issued = await createTicketAttachmentUploadUrl({
    org_id: organizationId,
    ticket_id: ticketId,
    file_name,
    mime_type,
    file_size_bytes,
  })
  if ('error' in issued) {
    const status = issued.error.includes('DATABASE_URL') ? 503 : 400
    return { error: issued.error, status }
  }
  return issued
}

export interface CompleteTicketAttachmentUploadInput {
  storage_path: string
  file_name: string
  mime_type: string
  file_size_bytes: number
  content?: string
  note_type?: string
  is_internal?: boolean
}

/** Step 2: register DB row after client PUT to presigned URL. */
export async function completeTicketAttachmentUpload(
  ticketId: string,
  organizationId: string,
  userId: string,
  input: CompleteTicketAttachmentUploadInput,
): Promise<
  | { note: TicketNoteItem | null; attachment: TicketAttachmentItem | null }
  | { error: string; status: number }
> {
  const storage_path = input.storage_path?.trim()
  const file_name = input.file_name?.trim()
  const mime_type = input.mime_type?.trim().toLowerCase()
  if (!storage_path || !file_name || !mime_type) {
    return { error: 'storage_path, file_name, and mime_type required', status: 400 }
  }
  const file_size_bytes = Number(input.file_size_bytes)
  if (!Number.isFinite(file_size_bytes) || file_size_bytes < 1) {
    return { error: 'file_size_bytes required', status: 400 }
  }

  const ticketRes = await assertTicketInOrg(ticketId, organizationId)
  if (!ticketRes.ok) {
    return {
      error: ticketRes.error,
      status: ticketRes.error === 'Ticket not found' ? 404 : 500,
    }
  }

  if (!isValidTicketAttachmentStoragePath(storage_path, organizationId, ticketId)) {
    return { error: 'Invalid storage_path for this ticket', status: 400 }
  }

  const exists = await verifyTicketAttachmentObject(storage_path)
  if (!exists) {
    return { error: 'File not found in storage — upload may have failed or expired', status: 400 }
  }

  const supabase = createSupabaseServiceClient()
  let note: TicketNoteItem | null = null
  let attachment: TicketAttachmentItem | null = null

  const content = input.content?.trim()
  if (content) {
    const noteResult = await insertTicketNote({
      ticketId,
      organizationId,
      userId,
      content,
      note_type: input.note_type,
      is_internal: input.is_internal,
    })
    if ('error' in noteResult) return noteResult
    note = noteResult.note
  }

  const attType = attachmentTypeFromMime(mime_type)
  const { data: row, error: insErr } = await supabase
    .from('ticket_attachments')
    .insert({
      ticket_id: ticketId,
      file_name,
      storage_path,
      mime_type,
      file_size_bytes,
      attachment_type: attType,
      uploaded_by: userId,
    })
    .select('id, ticket_id, file_name, mime_type, file_size_bytes, attachment_type, created_at')
    .single()

  if (insErr || !row) {
    return { error: insErr?.message ?? 'Attachment insert failed', status: 500 }
  }

  const preview_url = await signedUrlFor(storage_path)
  attachment = {
    id: row.id as string,
    ticket_id: row.ticket_id as string,
    file_name: row.file_name as string,
    mime_type: (row.mime_type as string | null) ?? null,
    file_size_bytes: (row.file_size_bytes as number | null) ?? null,
    attachment_type: (row.attachment_type as TicketAttachmentItem['attachment_type']) ?? null,
    created_at: row.created_at as string,
    preview_url,
    legacy_telegram: false,
  }

  return { note, attachment }
}

async function insertTicketNote(args: {
  ticketId: string
  organizationId: string
  userId: string
  content: string
  note_type?: string
  is_internal?: boolean
}): Promise<{ note: TicketNoteItem } | { error: string; status: number }> {
  const noteType = parseNoteType(args.note_type)
  const isInternal = args.is_internal !== false
  const supabase = createSupabaseServiceClient()

  if (isPostgresMode()) {
    const ins = await dbQuery<{
      id: string
      ticket_id: string
      author_user_id: string | null
      note_type: string
      content: string
      is_internal: boolean
      created_at: string
      author_full_name: string | null
    }>(
      `INSERT INTO ticket_notes (ticket_id, author_user_id, note_type, content, is_internal)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, ticket_id, author_user_id, note_type, content, is_internal, created_at,
         (SELECT full_name FROM users WHERE id = $2) AS author_full_name`,
      [args.ticketId, args.userId, noteType, args.content, isInternal],
    )
    const row = ins.rows[0]
    if (!row) return { error: 'Note insert failed', status: 500 }
    const note = mapNoteRow(row)
    await supabase.from('audit_logs').insert({
      organization_id: args.organizationId,
      event_type: 'ticket_note_added',
      entity_type: 'ticket',
      entity_id: args.ticketId,
      actor_type: 'user',
      actor_user_id: args.userId,
      new_value_json: { note_id: note.id, note_type: noteType, is_internal: isInternal },
    })
    return { note }
  }

  const { data: row, error: noteErr } = await supabase
    .from('ticket_notes')
    .insert({
      ticket_id: args.ticketId,
      author_user_id: args.userId,
      note_type: noteType,
      content: args.content,
      is_internal: isInternal,
    })
    .select(
      `
      id, ticket_id, author_user_id, note_type, content, is_internal, created_at,
      author:users!ticket_notes_author_user_id_fkey(full_name)
    `,
    )
    .single()

  if (noteErr || !row) {
    return { error: noteErr?.message ?? 'Note insert failed', status: 500 }
  }

  const note = mapNoteRow({
    id: row.id as string,
    ticket_id: row.ticket_id as string,
    author_user_id: row.author_user_id as string | null,
    note_type: row.note_type as string,
    content: row.content as string,
    is_internal: row.is_internal as boolean,
    created_at: row.created_at as string,
    author: row.author as { full_name?: string } | null,
  })

  await supabase.from('audit_logs').insert({
    organization_id: args.organizationId,
    event_type: 'ticket_note_added',
    entity_type: 'ticket',
    entity_id: args.ticketId,
    actor_type: 'user',
    actor_user_id: args.userId,
    new_value_json: { note_id: note.id, note_type: noteType, is_internal: isInternal },
  })

  return { note }
}

// Back-compat aliases
export const listTicketAttachments = listTicketNotesAndAttachments
export const canUploadTicketAttachments = canUploadTicketNotesOrAttachments
