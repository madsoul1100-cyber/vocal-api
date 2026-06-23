import { Router } from 'express'
import multer from 'multer'
import { requireAuth } from '@/middleware/requireAuth.js'
import { getCurrentVocalUser } from '@/lib/auth.js'
import { getCurrentWorkerOffer, getWorkerAssignments } from '@/services/workerQueueService.js'
import {
  fileTicketAsWorker,
  parseWorkerFileTicketBody,
} from '@/services/workerTicketIntakeService.js'
import {
  getWorkerAssignmentsSummary,
  listWorkerAssignmentsV2,
  parseWorkerAssignmentsBucketQuery,
  parseWorkerAssignmentsListQuery,
} from '@/services/workerAssignmentsListService.js'
import { TICKET_UPLOAD_MULTER_MAX_BYTES } from '@/services/attachmentService.js'

const router = Router()
const intakeUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: TICKET_UPLOAD_MULTER_MAX_BYTES, files: 5 },
})

function requireGroundWorker(
  req: Parameters<typeof requireAuth>[0],
  res: import('express').Response,
): { id: string; roles?: { name: string } } | null {
  const user = (req as typeof req & { vocalUser: { id: string; roles?: { name: string } } }).vocalUser
  if (user.roles?.name !== 'ground_worker') {
    res.status(403).json({ error: 'Ground workers only' })
    return null
  }
  return user
}

/** Tab badge counts (unfiltered totals). */
router.get('/assignments/summary', requireAuth, async (req, res) => {
  const user = requireGroundWorker(req, res)
  if (!user) return

  try {
    const summary = await getWorkerAssignmentsSummary(user.id)
    res.json(summary)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Summary failed'
    res.status(500).json({ error: message })
  }
})

/**
 * Without `bucket`: legacy payload (offered + activeTickets + telegramLinked).
 * With `bucket=offered|active|closed|raised`: paginated list for that tab.
 */
router.get('/assignments', requireAuth, async (req, res) => {
  const user = requireGroundWorker(req, res)
  if (!user) return

  const bucket = parseWorkerAssignmentsBucketQuery(req.query as Record<string, unknown>)
  if (!bucket) {
    const payload = await getWorkerAssignments(user.id)
    res.json(payload)
    return
  }

  const opts = parseWorkerAssignmentsListQuery(req.query as Record<string, unknown>, bucket)
  try {
    const result = await listWorkerAssignmentsV2(user.id, bucket, opts)
    res.json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'List failed'
    res.status(500).json({ error: message })
  }
})

/**
 * File a ticket on behalf of a citizen (ground worker).
 * Required: citizen_name, citizen_phone, address, description.
 * Optional: latitude, longitude, media (multipart field "files", max 5).
 */
router.post(
  '/tickets',
  requireAuth,
  intakeUpload.array('files', 5),
  async (req, res) => {
    const user = requireGroundWorker(req, res)
    if (!user) return

    const vocalUser = (
      req as typeof req & { vocalUser: Awaited<ReturnType<typeof getCurrentVocalUser>> }
    ).vocalUser

    const parsed = parseWorkerFileTicketBody((req.body ?? {}) as Record<string, unknown>)
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error })
      return
    }

    const files = (req.files as Express.Multer.File[] | undefined)?.map((f) => ({
      buffer: f.buffer,
      originalname: f.originalname,
      mimetype: f.mimetype,
    }))

    const result = await fileTicketAsWorker({
      organizationId: vocalUser.organization_id,
      workerUserId: vocalUser.id,
      ...parsed.fields,
      files,
    })

    if (!result.ok) {
      res.status(result.status).json({ error: result.error })
      return
    }

    res.status(201).json({
      ok: true,
      ticket_id: result.ticket_id,
      ticket_number: result.ticket_number,
      stage: result.stage,
      sub_status: result.sub_status,
      needs_triage: result.needs_triage,
      citizen: {
        id: result.citizen_id,
        verified: result.citizen_verified,
        is_new: result.citizen_is_new,
      },
      attachment_count: result.attachment_count,
    })
  },
)

router.get('/current-offer', requireAuth, async (req, res) => {
  const user = (req as typeof req & { vocalUser: { id: string; roles?: { name: string } } }).vocalUser
  if (user.roles?.name !== 'ground_worker') {
    res.json({ offer: null })
    return
  }
  const offer = await getCurrentWorkerOffer(user.id)
  res.json({ offer })
})

export default router
