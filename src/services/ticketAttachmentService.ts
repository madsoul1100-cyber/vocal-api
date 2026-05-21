import { createSupabaseServiceClient } from '@/lib/supabase.js'
import { signedUrlsFor } from '@/services/attachmentService.js'

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

export async function listTicketAttachments(
  ticketId: string,
  organizationId: string,
): Promise<TicketAttachmentItem[] | { error: string }> {
  const supabase = createSupabaseServiceClient()

  const { data: ticket, error: ticketErr } = await supabase
    .from('tickets')
    .select('id')
    .eq('id', ticketId)
    .eq('organization_id', organizationId)
    .maybeSingle()

  if (ticketErr) {
    return { error: ticketErr.message }
  }
  if (!ticket) {
    return { error: 'Ticket not found' }
  }

  const { data: rows, error } = await supabase
    .from('ticket_attachments')
    .select('id, ticket_id, file_name, storage_path, mime_type, file_size_bytes, attachment_type, created_at')
    .eq('ticket_id', ticketId)
    .order('created_at', { ascending: true })

  if (error) {
    return { error: error.message }
  }

  const paths = (rows ?? []).map((r) => r.storage_path as string)
  const signed = await signedUrlsFor(paths)

  return (rows ?? []).map((r) => {
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
      preview_url: legacy ? null : (signed[storagePath] ?? null),
      legacy_telegram: legacy,
    }
  })
}
