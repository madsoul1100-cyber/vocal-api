/**
 * Presigned direct-to-storage uploads for staff profile photo and KYC documents.
 * Separate from ticket attachments; mirrors upload-url → PUT → complete.
 */

import {
  STAFF_KYC_MAX_FILES,
  sanitizeKycDocumentsForDb,
  type StaffKycDocument,
} from '@/types/staffDocuments.js'
import {
  createStaffPresignedUploadUrl,
  isValidStaffStoragePathForOrg,
  signedUrlForStaffStorage,
  verifyStaffStorageObject,
  type StaffPresignedUploadResult,
  type StaffUploadKind,
} from '@/services/staffStorageService.js'
import {
  canAccessWorkersPage,
  getOrgUserById,
  updateOrgUser,
} from '@/services/workersManagementService.js'

type VocalUser = {
  id: string
  organization_id: string
  roles?: { name: string } | null
}

function assertWorkersAccess(user: VocalUser): { ok: true } | { ok: false; error: string; status: number } {
  if (!canAccessWorkersPage(user.roles?.name)) {
    return { ok: false, error: 'Insufficient role', status: 403 }
  }
  return { ok: true }
}

export async function issueStaffUploadUrl(
  user: VocalUser,
  kind: StaffUploadKind,
  input: { file_name: string; mime_type: string; file_size_bytes: number },
): Promise<StaffPresignedUploadResult | { error: string; status: number }> {
  const access = assertWorkersAccess(user)
  if (!access.ok) return { error: access.error, status: access.status }

  const issued = await createStaffPresignedUploadUrl({
    orgId: user.organization_id,
    kind,
    file_name: input.file_name,
    mime_type: input.mime_type,
    file_size_bytes: input.file_size_bytes,
  })
  if ('error' in issued) {
    const status = issued.error.includes('DATABASE_URL') ? 503 : 400
    return { error: issued.error, status }
  }
  return issued
}

export interface CompleteStaffProfileInput {
  storage_path: string
  file_name: string
  mime_type: string
  file_size_bytes: number
  /** When set, updates the worker row immediately (edit flow). */
  apply_to_worker_id?: string
}

export interface CompleteStaffProfileResult {
  kind: 'profile'
  storage_path: string
  image_url: string
  profile_image_url: string | null
  worker_updated: boolean
}

export async function completeStaffProfileUpload(
  user: VocalUser,
  input: CompleteStaffProfileInput,
): Promise<CompleteStaffProfileResult | { error: string; status: number }> {
  const access = assertWorkersAccess(user)
  if (!access.ok) return { error: access.error, status: access.status }

  const storage_path = input.storage_path?.trim()
  if (!storage_path) return { error: 'storage_path required', status: 400 }
  if (!isValidStaffStoragePathForOrg(storage_path, user.organization_id, 'profile')) {
    return { error: 'Invalid storage_path for profile upload', status: 400 }
  }
  if (!(await verifyStaffStorageObject(storage_path))) {
    return { error: 'File not found in storage — upload may have failed', status: 400 }
  }

  const image_url = storage_path
  const profile_image_url = await signedUrlForStaffStorage(storage_path)

  let worker_updated = false
  const workerId = input.apply_to_worker_id?.trim()
  if (workerId) {
    const existing = await getOrgUserById(user, workerId)
    if (!existing.ok) {
      return { error: existing.error, status: existing.status }
    }
    const upd = await updateOrgUser(user, workerId, { image_url })
    if (!upd.ok) return { error: upd.error, status: upd.status }
    worker_updated = true
  }

  return {
    kind: 'profile',
    storage_path,
    image_url,
    profile_image_url,
    worker_updated,
  }
}

export interface CompleteStaffKycInput {
  storage_path: string
  file_name: string
  mime_type: string
  file_size_bytes: number
  apply_to_worker_id?: string
}

export interface CompleteStaffKycResult {
  kind: 'kyc'
  document: StaffKycDocument
  download_url: string | null
  worker_updated: boolean
}

export async function completeStaffKycUpload(
  user: VocalUser,
  input: CompleteStaffKycInput,
): Promise<CompleteStaffKycResult | { error: string; status: number }> {
  const access = assertWorkersAccess(user)
  if (!access.ok) return { error: access.error, status: access.status }

  const storage_path = input.storage_path?.trim()
  const file_name = input.file_name?.trim()
  if (!storage_path || !file_name) {
    return { error: 'storage_path and file_name required', status: 400 }
  }
  if (!isValidStaffStoragePathForOrg(storage_path, user.organization_id, 'kyc')) {
    return { error: 'Invalid storage_path for KYC upload', status: 400 }
  }
  if (!(await verifyStaffStorageObject(storage_path))) {
    return { error: 'File not found in storage — upload may have failed', status: 400 }
  }

  const document: StaffKycDocument = {
    storage_path,
    file_name,
    mime_type: input.mime_type?.trim() || null,
    size_bytes: Number.isFinite(input.file_size_bytes) ? input.file_size_bytes : null,
    uploaded_at: new Date().toISOString(),
  }

  const download_url = await signedUrlForStaffStorage(storage_path)

  let worker_updated = false
  const workerId = input.apply_to_worker_id?.trim()
  if (workerId) {
    const existing = await getOrgUserById(user, workerId)
    if (!existing.ok) {
      return { error: existing.error, status: existing.status }
    }
    const current = sanitizeKycDocumentsForDb(existing.worker.kyc_documents)
    if (current.length >= STAFF_KYC_MAX_FILES) {
      return { error: `At most ${STAFF_KYC_MAX_FILES} KYC documents allowed`, status: 400 }
    }
    const kyc_documents = sanitizeKycDocumentsForDb([...current, document])
    const upd = await updateOrgUser(user, workerId, { kyc_documents })
    if (!upd.ok) return { error: upd.error, status: upd.status }
    worker_updated = true
  }

  return {
    kind: 'kyc',
    document,
    download_url,
    worker_updated,
  }
}
