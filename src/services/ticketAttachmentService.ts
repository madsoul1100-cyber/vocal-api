import { createSupabaseServiceClient } from '@/lib/supabase.js'
import { signedUrlFor, signedUrlsFor, uploadWorkerAttachment } from '@/services/attachmentService.js'
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

  const can_preview_media = canPreviewAttachmentMedia(
    viewerRole,
    ticket.citizen_identity_revealed_at as string | null,
  )

  const paths = (attachmentsRes.data ?? []).map((r) => r.storage_path as string)
  const signed = can_preview_media ? await signedUrlsFor(paths) : {}

  const notes: TicketNoteItem[] = (notesRes.data ?? []).map((r) => {
    const author = r.author as { full_name?: string } | null
    return {
      id: r.id as string,
      ticket_id: r.ticket_id as string,
      author_user_id: r.author_user_id as string | null,
      author_name: author?.full_name ?? null,
      note_type: r.note_type as NoteType,
      content: r.content as string,
      is_internal: r.is_internal as boolean,
      created_at: r.created_at as string,
    }
  })

  const attachments: TicketAttachmentItem[] = (attachmentsRes.data ?? []).map((r) => {
    const storagePath = r.storage_path as string
    const legacy = storagePath.startsWith('telegram:')
    return {
      id: r.id as string,
      ticket_id: r.ticket_id as string,
      file_name: r.file_name as string,
      mime_type: (r.mime_type as string | null) ?? null,
      file_size_bytes: (r.file_size_bytes as number | null) ?? null,
      attachment_type: (r.attachment_type as TicketAttachmentItem['attachment_type']) ?? null,
      created_at: r.created_at as string,
      preview_url: can_preview_media && !legacy ? (signed[storagePath] ?? null) : null,
      legacy_telegram: legacy,
    }
  })

  return {
    notes,
    attachments,
    notes_pagination: buildPagination(offset, limit, notesRes.count ?? 0),
    attachments_pagination: buildPagination(offset, limit, attachmentsRes.count ?? 0),
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

    const author = row.author as { full_name?: string } | null
    note = {
      id: row.id as string,
      ticket_id: row.ticket_id as string,
      author_user_id: row.author_user_id as string | null,
      author_name: author?.full_name ?? null,
      note_type: row.note_type as NoteType,
      content: row.content as string,
      is_internal: row.is_internal as boolean,
      created_at: row.created_at as string,
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

// Back-compat aliases
export const listTicketAttachments = listTicketNotesAndAttachments
export const canUploadTicketAttachments = canUploadTicketNotesOrAttachments
