import multer from 'multer'
import { STAFF_KYC_FILE_MAX_BYTES } from '@/types/staffDocuments.js'

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
  uploadFields: { image_url: string | null; kyc_documents: import('@/types/staffDocuments.js').StaffKycDocument[] },
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
