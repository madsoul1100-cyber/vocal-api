import {
  STAFF_KYC_MAX_FILES,
  type StaffKycDocument,
} from '@/types/staffDocuments.js'
import { uploadStaffKycDocument, uploadStaffProfileImage } from '@/services/staffStorageService.js'

export interface MulterFileLike {
  buffer: Buffer
  originalname: string
  mimetype: string
  size: number
}

export async function processStaffCreateUploads(
  orgId: string,
  files: {
    profile_image?: MulterFileLike[]
    kyc_documents?: MulterFileLike[]
  },
): Promise<
  | { image_url: string | null; kyc_documents: StaffKycDocument[] }
  | { error: string; status: number }
> {
  let image_url: string | null = null
  const kyc_documents: StaffKycDocument[] = []

  const profile = files.profile_image?.[0]
  if (profile) {
    const mime = profile.mimetype?.trim() || 'image/jpeg'
    const res = await uploadStaffProfileImage({
      orgId,
      buffer: profile.buffer,
      mime,
      originalName: profile.originalname || 'profile.jpg',
    })
    if ('error' in res) return { error: res.error, status: 400 }
    image_url = res.storage_path
  }

  const kycFiles = files.kyc_documents ?? []
  if (kycFiles.length > STAFF_KYC_MAX_FILES) {
    return { error: `At most ${STAFF_KYC_MAX_FILES} KYC documents allowed`, status: 400 }
  }

  for (const file of kycFiles) {
    const mime = file.mimetype?.trim() || 'application/pdf'
    const res = await uploadStaffKycDocument({
      orgId,
      buffer: file.buffer,
      mime,
      originalName: file.originalname || 'document',
    })
    if ('error' in res) return { error: res.error, status: 400 }
    kyc_documents.push(res)
  }

  return { image_url, kyc_documents }
}
