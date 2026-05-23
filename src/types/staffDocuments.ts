export interface StaffKycDocument {
  storage_path: string
  file_name: string
  mime_type: string | null
  size_bytes: number | null
  uploaded_at: string
}

export const STAFF_KYC_MAX_FILES = 10
export const STAFF_PROFILE_IMAGE_MAX_BYTES = 5 * 1024 * 1024
export const STAFF_KYC_FILE_MAX_BYTES = 10 * 1024 * 1024

/** Strip API-only fields (e.g. download_url) before persisting to jsonb. */
export function sanitizeKycDocumentsForDb(docs: unknown): StaffKycDocument[] {
  if (!Array.isArray(docs)) return []
  return docs
    .filter(
      (d): d is StaffKycDocument & { download_url?: string | null } =>
        typeof d === 'object' && d !== null && typeof (d as StaffKycDocument).storage_path === 'string',
    )
    .map((d) => ({
      storage_path: d.storage_path,
      file_name: d.file_name,
      mime_type: d.mime_type ?? null,
      size_bytes: d.size_bytes ?? null,
      uploaded_at: d.uploaded_at,
    }))
}
