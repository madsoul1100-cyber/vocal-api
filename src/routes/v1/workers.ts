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
  getWorkersPageData,
  processActivationRequest,
  streamWorkerStaffMedia,
  updateOrgUser,
} from '@/services/workersManagementService.js'

const router = Router()

type VocalUser = {
  id: string
  organization_id: string
  roles?: { name: string } | null
}

router.get('/', requireAuth, async (req, res) => {
  const user = (req as typeof req & { vocalUser: VocalUser }).vocalUser
  if (!canAccessWorkersPage(user.roles?.name)) {
    res.status(403).json({ error: 'Insufficient role' })
    return
  }

  const page = await getWorkersPageData(user.organization_id, {
    roleName: user.roles?.name,
    userId: user.id,
  })

  res.json({
    workers: page.workers,
    active_workers: page.active_workers,
    inactive_workers: page.inactive_workers,
    awaiting_approval_workers: page.awaiting_approval_workers,
    pending: page.pending,
    categories: page.categories,
    territories: page.territories,
    roles: page.roles,
    can_approve_staff: page.can_approve_staff,
    activeCount: page.categories.active,
    inactiveCount: page.categories.inactive,
    pendingCount: page.categories.pending,
  })
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
