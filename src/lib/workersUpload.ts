import multer from 'multer'
import {
  STAFF_KYC_FILE_MAX_BYTES,
  STAFF_KYC_MAX_FILES,
  sanitizeKycDocumentsForDb,
  type StaffKycDocument,
} from '@/types/staffDocuments.js'

export const workersCreateUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: STAFF_KYC_FILE_MAX_BYTES,
    files: 11,
  },
}).fields([
  { name: 'profile_image', maxCount: 1 },
  { name: 'kyc_documents', maxCount: 10 },
])

export function mergeWorkerCreateBody(
  body: Record<string, unknown>,
  uploadFields: { image_url: string | null; kyc_documents: StaffKycDocument[] },
): Record<string, unknown> {
  return {
    ...body,
    active: body.active === 'true' || body.active === true || body.active === 'on',
    image_url: uploadFields.image_url ?? body.image_url,
    kyc_documents: uploadFields.kyc_documents.length
      ? uploadFields.kyc_documents
      : body.kyc_documents,
  }
}

export function mergeWorkerUpdateBody(
  body: Record<string, unknown>,
  uploadFields: { image_url: string | null; kyc_documents: StaffKycDocument[] },
  existing: { image_url: string | null; kyc_documents: StaffKycDocument[] },
): Record<string, unknown> {
  const merged: Record<string, unknown> = {
    ...body,
    active: body.active === 'true' || body.active === true || body.active === 'on',
  }

  if (body.remove_profile_image === 'true' || body.remove_profile_image === true) {
    merged.image_url = null
  } else if (uploadFields.image_url) {
    merged.image_url = uploadFields.image_url
  }

  if (uploadFields.kyc_documents.length > 0) {
    merged.kyc_documents = sanitizeKycDocumentsForDb([
      ...sanitizeKycDocumentsForDb(existing.kyc_documents),
      ...uploadFields.kyc_documents,
    ]).slice(0, STAFF_KYC_MAX_FILES)
  }

  return merged
}
