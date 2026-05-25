import { Router } from 'express'
import { requireAuth } from '@/middleware/requireAuth.js'
import {
  mergeWorkerCreateBody,
  mergeWorkerUpdateBody,
  workersCreateUpload,
} from '@/lib/workersUpload.js'
import { processStaffCreateUploads } from '@/services/staffUploadService.js'
import {
  canAccessWorkersPage,
  createOrgUser,
  deactivateOrgUser,
  getOrgUserById,
  streamWorkerStaffMedia,
  listWorkersV2,
  parseWorkersV2ListQuery,
  processActivationRequest,
  updateOrgUser,
  workersV2FiltersEcho,
} from '@/services/workersManagementService.js'
import { createOrgTerritory } from '@/services/territoryService.js'
import {
  completeStaffKycUpload,
  completeStaffProfileUpload,
  issueStaffUploadUrl,
} from '@/services/staffPresignService.js'

const router = Router()

function parseUploadMeta(body: Record<string, unknown>) {
  return {
    file_name: String(body.file_name ?? ''),
    mime_type: String(body.mime_type ?? ''),
    file_size_bytes: Number(body.file_size_bytes),
  }
}

type VocalUser = {
  id: string
  organization_id: string
  roles?: { name: string } | null
}

/** v2: paginated staff list + pending activations; filters, sort, org summary counts */
router.get('/', requireAuth, async (req, res) => {
  const user = (req as typeof req & { vocalUser: VocalUser }).vocalUser
  if (!canAccessWorkersPage(user.roles?.name)) {
    res.status(403).json({ error: 'Insufficient role' })
    return
  }

  const listOpts = parseWorkersV2ListQuery(req.query as Record<string, unknown>)

  try {
    const result = await listWorkersV2(user.organization_id, listOpts, user.roles?.name)
    res.json({
      workers: result.workers,
      pagination: result.pagination,
      pending: result.pending,
      pending_pagination: result.pending_pagination,
      summary: result.summary,
      territories: result.territories,
      roles: result.roles,
      filters: workersV2FiltersEcho(listOpts),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Workers list failed'
    res.status(500).json({ error: message })
  }
})

router.post('/territories', requireAuth, async (req, res) => {
  const user = (req as typeof req & { vocalUser: VocalUser }).vocalUser
  const name = typeof req.body?.name === 'string' ? req.body.name : ''
  const result = await createOrgTerritory(user, name)
  if (!result.ok) {
    res.status(result.status).json({ error: result.error })
    return
  }
  res.status(201).json({ ok: true, territory: result.territory })
})

/** Presigned profile upload (create worker — no worker id yet). */
router.post('/uploads/profile/upload-url', requireAuth, async (req, res) => {
  const user = (req as typeof req & { vocalUser: VocalUser }).vocalUser
  const result = await issueStaffUploadUrl(user, 'profile', parseUploadMeta(req.body ?? {}))
  if ('error' in result) {
    res.status(result.status).json({ error: result.error })
    return
  }
  res.json(result)
})

router.post('/uploads/profile/complete', requireAuth, async (req, res) => {
  const user = (req as typeof req & { vocalUser: VocalUser }).vocalUser
  const body = req.body ?? {}
  const result = await completeStaffProfileUpload(user, {
    storage_path: String(body.storage_path ?? ''),
    file_name: String(body.file_name ?? ''),
    mime_type: String(body.mime_type ?? ''),
    file_size_bytes: Number(body.file_size_bytes),
    apply_to_worker_id:
      typeof body.apply_to_worker_id === 'string' ? body.apply_to_worker_id : undefined,
  })
  if ('error' in result) {
    res.status(result.status).json({ error: result.error })
    return
  }
  res.status(201).json(result)
})

/** Presigned KYC upload (create or batch before POST /workers). */
router.post('/uploads/kyc/upload-url', requireAuth, async (req, res) => {
  const user = (req as typeof req & { vocalUser: VocalUser }).vocalUser
  const result = await issueStaffUploadUrl(user, 'kyc', parseUploadMeta(req.body ?? {}))
  if ('error' in result) {
    res.status(result.status).json({ error: result.error })
    return
  }
  res.json(result)
})

router.post('/uploads/kyc/complete', requireAuth, async (req, res) => {
  const user = (req as typeof req & { vocalUser: VocalUser }).vocalUser
  const body = req.body ?? {}
  const result = await completeStaffKycUpload(user, {
    storage_path: String(body.storage_path ?? ''),
    file_name: String(body.file_name ?? ''),
    mime_type: String(body.mime_type ?? ''),
    file_size_bytes: Number(body.file_size_bytes),
    apply_to_worker_id:
      typeof body.apply_to_worker_id === 'string' ? body.apply_to_worker_id : undefined,
  })
  if ('error' in result) {
    res.status(result.status).json({ error: result.error })
    return
  }
  res.status(201).json(result)
})

/** Presigned profile upload for existing worker (auto-applies on complete). */
router.post('/:id/uploads/profile/upload-url', requireAuth, async (req, res) => {
  const user = (req as typeof req & { vocalUser: VocalUser }).vocalUser
  const result = await issueStaffUploadUrl(user, 'profile', parseUploadMeta(req.body ?? {}))
  if ('error' in result) {
    res.status(result.status).json({ error: result.error })
    return
  }
  res.json(result)
})

router.post('/:id/uploads/profile/complete', requireAuth, async (req, res) => {
  const user = (req as typeof req & { vocalUser: VocalUser }).vocalUser
  const body = req.body ?? {}
  const result = await completeStaffProfileUpload(user, {
    storage_path: String(body.storage_path ?? ''),
    file_name: String(body.file_name ?? ''),
    mime_type: String(body.mime_type ?? ''),
    file_size_bytes: Number(body.file_size_bytes),
    apply_to_worker_id: String(req.params.id),
  })
  if ('error' in result) {
    res.status(result.status).json({ error: result.error })
    return
  }
  res.status(201).json(result)
})

router.post('/:id/uploads/kyc/upload-url', requireAuth, async (req, res) => {
  const user = (req as typeof req & { vocalUser: VocalUser }).vocalUser
  const result = await issueStaffUploadUrl(user, 'kyc', parseUploadMeta(req.body ?? {}))
  if ('error' in result) {
    res.status(result.status).json({ error: result.error })
    return
  }
  res.json(result)
})

router.post('/:id/uploads/kyc/complete', requireAuth, async (req, res) => {
  const user = (req as typeof req & { vocalUser: VocalUser }).vocalUser
  const body = req.body ?? {}
  const result = await completeStaffKycUpload(user, {
    storage_path: String(body.storage_path ?? ''),
    file_name: String(body.file_name ?? ''),
    mime_type: String(body.mime_type ?? ''),
    file_size_bytes: Number(body.file_size_bytes),
    apply_to_worker_id: String(req.params.id),
  })
  if ('error' in result) {
    res.status(result.status).json({ error: result.error })
    return
  }
  res.status(201).json(result)
})

router.post('/', requireAuth, workersCreateUpload, async (req, res) => {
  const user = (req as typeof req & { vocalUser: VocalUser }).vocalUser
  const files = req.files as {
    profile_image?: Express.Multer.File[]
    kyc_documents?: Express.Multer.File[]
  } | undefined

  const uploadResult = await processStaffCreateUploads(user.organization_id, {
    profile_image: files?.profile_image,
    kyc_documents: files?.kyc_documents,
  })
  if ('error' in uploadResult) {
    res.status(uploadResult.status).json({ error: uploadResult.error })
    return
  }

  const body = mergeWorkerCreateBody((req.body ?? {}) as Record<string, unknown>, uploadResult)
  const result = await createOrgUser(user, body)
  if (!result.ok) {
    res.status(result.status).json({ error: result.error })
    return
  }
  res.json({
    ok: true,
    id: result.id,
    pending_approval: result.pending_approval ?? false,
    request_id: result.request_id,
  })
})

router.post('/activation/:id', requireAuth, async (req, res) => {
  const user = (req as typeof req & { vocalUser: VocalUser }).vocalUser
  const result = await processActivationRequest(user, String(req.params.id), req.body ?? {})
  if (!result.ok) {
    res.status(result.status).json({ error: result.error })
    return
  }
  res.json({ ok: true })
})

router.get('/:id/media/profile', requireAuth, async (req, res) => {
  const user = (req as typeof req & { vocalUser: VocalUser }).vocalUser
  const result = await streamWorkerStaffMedia(user, String(req.params.id), 'profile')
  if (!result.ok) {
    res.status(result.status).json({ error: result.error })
    return
  }
  res.setHeader('Content-Type', result.contentType)
  res.setHeader('Cache-Control', 'private, max-age=300')
  res.send(result.data)
})

router.get('/:id/media/kyc/:docIndex', requireAuth, async (req, res) => {
  const user = (req as typeof req & { vocalUser: VocalUser }).vocalUser
  const docIndex = parseInt(String(req.params.docIndex), 10)
  if (!Number.isFinite(docIndex) || docIndex < 0) {
    res.status(400).json({ error: 'Invalid document index' })
    return
  }
  const result = await streamWorkerStaffMedia(user, String(req.params.id), 'kyc', docIndex)
  if (!result.ok) {
    res.status(result.status).json({ error: result.error })
    return
  }
  const safeName = (result.fileName ?? 'document').replace(/[^\w.-]/g, '_')
  res.setHeader('Content-Type', result.contentType)
  res.setHeader('Content-Disposition', `inline; filename="${safeName}"`)
  res.setHeader('Cache-Control', 'private, max-age=300')
  res.send(result.data)
})

router.get('/:id', requireAuth, async (req, res) => {
  const user = (req as typeof req & { vocalUser: VocalUser }).vocalUser
  const result = await getOrgUserById(user, String(req.params.id))
  if (!result.ok) {
    res.status(result.status).json({ error: result.error })
    return
  }
  res.json({ worker: result.worker })
})

router.patch('/:id', requireAuth, workersCreateUpload, async (req, res) => {
  const user = (req as typeof req & { vocalUser: VocalUser }).vocalUser
  const userId = String(req.params.id)

  const existing = await getOrgUserById(user, userId)
  if (!existing.ok) {
    res.status(existing.status).json({ error: existing.error })
    return
  }

  const files = req.files as {
    profile_image?: Express.Multer.File[]
    kyc_documents?: Express.Multer.File[]
  } | undefined

  let body: Record<string, unknown> = (req.body ?? {}) as Record<string, unknown>

  const hasUploads = !!(files?.profile_image?.length || files?.kyc_documents?.length)
  const removePhoto =
    body.remove_profile_image === 'true' || body.remove_profile_image === true

  if (hasUploads) {
    const uploadResult = await processStaffCreateUploads(user.organization_id, {
      profile_image: files?.profile_image,
      kyc_documents: files?.kyc_documents,
    })
    if ('error' in uploadResult) {
      res.status(uploadResult.status).json({ error: uploadResult.error })
      return
    }
    body = mergeWorkerUpdateBody(body, uploadResult, {
      image_url: existing.worker.image_url,
      kyc_documents: existing.worker.kyc_documents,
    })
  } else if (removePhoto) {
    body = mergeWorkerUpdateBody(
      body,
      { image_url: null, kyc_documents: [] },
      {
        image_url: existing.worker.image_url,
        kyc_documents: existing.worker.kyc_documents,
      },
    )
  }

  const result = await updateOrgUser(user, userId, body)
  if (!result.ok) {
    res.status(result.status).json({ error: result.error })
    return
  }
  res.json({ ok: true, worker: result.worker })
})

/** Soft-deactivate (active=false). Does not delete the users row. */
router.delete('/:id', requireAuth, async (req, res) => {
  const user = (req as typeof req & { vocalUser: VocalUser }).vocalUser
  const result = await deactivateOrgUser(user, String(req.params.id))
  if (!result.ok) {
    res.status(result.status).json({ error: result.error })
    return
  }
  res.json({ ok: true, already_inactive: result.already_inactive ?? false })
})

export default router
