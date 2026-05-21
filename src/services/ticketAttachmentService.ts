import { createSupabaseServiceClient } from '@/lib/supabase.js'
import { signedUrlFor, signedUrlsFor, uploadWorkerAttachment } from '@/services/attachmentService.js'

const PRIVILEGED_ROLES = ['super_admin', 'central_support']

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100

export interface TicketAttachmentItem {
  id: string
  ticket_id: string
  file_name: string
  mime_type: string | null
  file_size_bytes: number | null
  attachment_type: 'image' | 'video' | 'audio' | 'document' | 'other' | null
  created_at: string
  /** Short-lived URL for preview/download; null if legacy telegram pointer or signing failed. */
  preview_url: string | null
  /** True when file was not uploaded to bucket (telegram:file_id fallback). */
  legacy_telegram: boolean
}

export interface TicketAttachmentsPagination {
  limit: number
  offset: number
  total: number
  hasNextPage: boolean
  hasPreviousPage: boolean
}

export interface ListTicketAttachmentsOpts {
  limit?: number
  offset?: number
}

export interface ListTicketAttachmentsResult {
  attachments: TicketAttachmentItem[]
  pagination: TicketAttachmentsPagination
  /** Same as monolith page.tsx canSeeAttachmentMedia — signed URLs only when true. */
  can_preview_media: boolean
}

/** Matches Next.js ticket page: privileged, or worker after citizen identity revealed. */
export function canPreviewAttachmentMedia(
  role: string | null | undefined,
  citizenIdentityRevealedAt: string | null | undefined,
): boolean {
  if (role && PRIVILEGED_ROLES.includes(role)) return true
  if (role === 'ground_worker' && citizenIdentityRevealedAt) return true
  return false
}

function buildPagination(offset: number, limit: number, total: number): TicketAttachmentsPagination {
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

/** Whether the client should call GET /v2/tickets/:id/attachments. */
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

export async function listTicketAttachments(
  ticketId: string,
  organizationId: string,
  opts: ListTicketAttachmentsOpts = {},
  viewerRole?: string | null,
): Promise<ListTicketAttachmentsResult | { error: string }> {
  const supabase = createSupabaseServiceClient()

  let limit = opts.limit ?? DEFAULT_LIMIT
  limit = Math.min(MAX_LIMIT, Math.max(1, limit))
  const offset = Math.max(0, opts.offset ?? 0)

  const { data: ticket, error: ticketErr } = await supabase
    .from('tickets')
    .select('id, citizen_identity_revealed_at')
    .eq('id', ticketId)
    .eq('organization_id', organizationId)
    .maybeSingle()

  if (ticketErr) {
    return { error: ticketErr.message }
  }
  if (!ticket) {
    return { error: 'Ticket not found' }
  }

  const { data: rows, error, count } = await supabase
    .from('ticket_attachments')
    .select(
      'id, ticket_id, file_name, storage_path, mime_type, file_size_bytes, attachment_type, created_at',
      { count: 'exact' },
    )
    .eq('ticket_id', ticketId)
    .order('created_at', { ascending: true })
    .range(offset, offset + limit - 1)

  if (error) {
    return { error: error.message }
  }

  const total = count ?? 0
  const can_preview_media = canPreviewAttachmentMedia(
    viewerRole,
    ticket.citizen_identity_revealed_at as string | null,
  )

  const paths = (rows ?? []).map((r) => r.storage_path as string)
  const signed = can_preview_media ? await signedUrlsFor(paths) : {}

  const attachments = (rows ?? []).map((r) => {
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
      preview_url:
        can_preview_media && !legacy ? (signed[storagePath] ?? null) : null,
      legacy_telegram: legacy,
    }
  })

  return {
    attachments,
    pagination: buildPagination(offset, limit, total),
    can_preview_media,
  }
}

const UPLOAD_ALLOWED_ROLES = [...PRIVILEGED_ROLES]

export function canUploadTicketAttachments(role: string | null | undefined): boolean {
  return !!role && UPLOAD_ALLOWED_ROLES.includes(role)
}

/** Staff upload after ticket creation (replaces monolith notes/upload → ticket_attachments). */
export async function createTicketAttachment(
  ticketId: string,
  organizationId: string,
  userId: string,
  file: { buffer: Buffer; originalname: string; mimetype: string },
): Promise<{ attachment: TicketAttachmentItem } | { error: string; status: number }> {
  const supabase = createSupabaseServiceClient()

  const { data: ticket, error: ticketErr } = await supabase
    .from('tickets')
    .select('id')
    .eq('id', ticketId)
    .eq('organization_id', organizationId)
    .maybeSingle()

  if (ticketErr) {
    return { error: ticketErr.message, status: 500 }
  }
  if (!ticket) {
    return { error: 'Ticket not found', status: 404 }
  }

  const mime = file.mimetype?.trim() || 'application/octet-stream'
  const stored = await uploadWorkerAttachment({
    bytes: file.buffer,
    filename: file.originalname,
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
      file_name: file.originalname,
      storage_path: stored.storage_path,
      mime_type: stored.mime_type,
      file_size_bytes: stored.size_bytes,
      attachment_type: stored.attachment_type,
      uploaded_by: userId,
    })
    .select('id, ticket_id, file_name, mime_type, file_size_bytes, attachment_type, created_at')
    .single()

  if (insErr || !row) {
    return { error: insErr?.message ?? 'Insert failed', status: 500 }
  }

  const preview_url = await signedUrlFor(stored.storage_path)

  return {
    attachment: {
      id: row.id as string,
      ticket_id: row.ticket_id as string,
      file_name: row.file_name as string,
      mime_type: (row.mime_type as string | null) ?? null,
      file_size_bytes: (row.file_size_bytes as number | null) ?? null,
      attachment_type: (row.attachment_type as TicketAttachmentItem['attachment_type']) ?? null,
      created_at: row.created_at as string,
      preview_url,
      legacy_telegram: false,
    },
  }
}
