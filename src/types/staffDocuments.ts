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
