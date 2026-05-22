import { Router } from 'express'
import multer from 'multer'
import { requireAuth } from '@/middleware/requireAuth.js'
import { getCurrentVocalUser } from '@/lib/auth.js'
import { createSupabaseServiceClient } from '@/lib/supabase.js'
import {
  listTicketsV2,
  parseTicketsV2ListQuery,
  ticketsV2FiltersEcho,
  stripTicketAiMirrorFields,
  nestTicketClassification,
  nestTicketSla,
  stripTicketDetailDuplicates,
} from '@/services/ticketQueries.js'
import {
  acceptTicket,
  getTicketStatusOptions,
  rejectTicket,
  updateTicketStatus,
} from '@/services/ticketActionsService.js'
import {
  assignTicketToWorker,
  autoAssignTicket,
  canAssignTickets,
  countAssignableWorkers,
  getCurrentAssignment,
  listAssignableWorkersForTicket,
  workerCanRespondToOffer,
} from '@/services/ticketAssignmentService.js'
import {
  canAccessAiSuggestions,
  confirmAiSuggestion,
  getPendingAiSuggestion,
  shouldFetchAiSuggestion,
} from '@/services/aiSuggestionService.js'
import { loadCitizenIdentityForTicket } from '@/services/ticketCitizenIdentity.js'
import {
  canPreviewAttachmentMedia,
  canUploadTicketNotesOrAttachments,
  createTicketNotesAndAttachments,
  listTicketNotesAndAttachments,
  parseAttachmentsListQuery,
  ticketHasAttachments,
  ticketHasNotes,
} from '@/services/ticketAttachmentService.js'
import { listTicketStageHistory } from '@/services/ticketStageHistoryService.js'

const router = Router()
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
})

/** v2: paginated list with sort, filters (incl. SLA), and keyword search */
router.get('/', requireAuth, async (req, res) => {
  const user = (req as typeof req & { vocalUser: Awaited<ReturnType<typeof getCurrentVocalUser>> })
    .vocalUser

  const listOpts = parseTicketsV2ListQuery(req.query as Record<string, unknown>)

  try {
    const { tickets, pagination } = await listTicketsV2(user.organization_id, listOpts)
    res.json({
      tickets,
      pagination,
      filters: ticketsV2FiltersEcho(listOpts),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ticket list failed'
    res.status(500).json({ error: message })
  }
})

/** Status picker catalog for current user role (codes + labels; no DB). */
router.get('/status-options', requireAuth, async (req, res) => {
  const user = (req as typeof req & { vocalUser: Awaited<ReturnType<typeof getCurrentVocalUser>> })
    .vocalUser
  res.json(getTicketStatusOptions(user.roles?.name))
})

router.post('/accept', requireAuth, async (req, res) => {
  const user = (req as typeof req & { vocalUser: Awaited<ReturnType<typeof getCurrentVocalUser>> }).vocalUser
  const ticketId = req.body?.ticket_id as string | undefined
  if (!ticketId) {
    res.status(400).json({ error: 'ticket_id required' })
    return
  }
  const result = await acceptTicket(user as any, ticketId)
  if (!result.ok) {
    res.status(result.status).json({ error: result.error })
    return
  }
  res.json({ ok: true })
})

router.post('/reject', requireAuth, async (req, res) => {
  const user = (req as typeof req & { vocalUser: Awaited<ReturnType<typeof getCurrentVocalUser>> }).vocalUser
  const ticketId = req.body?.ticket_id as string | undefined
  const reason = req.body?.reason as string | undefined
  if (!ticketId || !reason) {
    res.status(400).json({ error: 'ticket_id and reason required' })
    return
  }
  const result = await rejectTicket(user as any, ticketId, reason)
  if (!result.ok) {
    res.status(result.status).json({ error: result.error })
    return
  }
  res.json({ ok: true, reoffered: result.reoffered ?? null })
})

/** Apply pending AI suggestion to empty ticket fields; central_support / super_admin only */
router.post('/confirm-ai', requireAuth, async (req, res) => {
  const user = (req as typeof req & { vocalUser: Awaited<ReturnType<typeof getCurrentVocalUser>> }).vocalUser
  const ticketId = req.body?.ticket_id as string | undefined
  const suggestionId = req.body?.suggestion_id as string | undefined
  if (!ticketId || !suggestionId) {
    res.status(400).json({ error: 'ticket_id and suggestion_id required' })
    return
  }
  const result = await confirmAiSuggestion(user as any, ticketId, suggestionId)
  if (!result.ok) {
    res.status(result.status).json({ error: result.error })
    return
  }
  res.json({ ok: true, ticket: result.ticket })
})

router.post('/assign', requireAuth, async (req, res) => {
  const user = (req as typeof req & { vocalUser: Awaited<ReturnType<typeof getCurrentVocalUser>> }).vocalUser
  const ticketId = req.body?.ticket_id as string | undefined
  const workerId = req.body?.worker_id as string | undefined
  if (!ticketId || !workerId) {
    res.status(400).json({ error: 'ticket_id and worker_id required' })
    return
  }
  const result = await assignTicketToWorker(user as any, ticketId, workerId)
  if (!result.ok) {
    res.status(result.status).json({ error: result.error })
    return
  }
  res.json({
    ok: true,
    assignment_id: result.assignment_id,
    expires_at: result.expires_at,
  })
})

router.post('/auto-assign', requireAuth, async (req, res) => {
  const user = (req as typeof req & { vocalUser: Awaited<ReturnType<typeof getCurrentVocalUser>> }).vocalUser
  const ticketId = req.body?.ticket_id as string | undefined
  if (!ticketId) {
    res.status(400).json({ error: 'ticket_id required' })
    return
  }
  const result = await autoAssignTicket(user as any, ticketId)
  if (!result.ok) {
    res.status(result.status).json({ error: result.error })
    return
  }
  res.json({
    ok: true,
    assignment_id: result.assignment_id,
    expires_at: result.expires_at,
    worker: result.worker,
  })
})

router.post('/status', requireAuth, async (req, res) => {
  const user = (req as typeof req & { vocalUser: Awaited<ReturnType<typeof getCurrentVocalUser>> }).vocalUser
  const ticketId = req.body?.ticket_id as string | undefined
  const subStatus = req.body?.sub_status as string | undefined
  if (!ticketId || !subStatus) {
    res.status(400).json({ error: 'ticket_id and sub_status required' })
    return
  }
  const result = await updateTicketStatus(user as any, ticketId, subStatus)
  if (!result.ok) {
    res.status(result.status).json({ error: result.error })
    return
  }
  res.json({ ok: true })
})

/** Notes + attachments: list (GET) or create note and/or file (POST multipart). */
router.post(
  '/:id/attachments',
  requireAuth,
  upload.fields([{ name: 'file', maxCount: 1 }]),
  async (req, res) => {
    const user = (req as typeof req & { vocalUser: Awaited<ReturnType<typeof getCurrentVocalUser>> })
      .vocalUser

    if (!canUploadTicketNotesOrAttachments(user.roles?.name)) {
      res.status(403).json({ error: 'Forbidden' })
      return
    }

    const files = req.files as { file?: Express.Multer.File[] } | undefined
    const file = files?.file?.[0]
    const content =
      typeof req.body?.content === 'string' ? req.body.content : undefined

    const ticketId = String(req.params.id)
    const result = await createTicketNotesAndAttachments(
      ticketId,
      user.organization_id,
      user.id,
      {
        content,
        note_type: req.body?.note_type,
        is_internal: req.body?.is_internal !== 'false' && req.body?.is_internal !== false,
        file: file
          ? { buffer: file.buffer, originalname: file.originalname, mimetype: file.mimetype }
          : undefined,
      },
    )

    if ('error' in result) {
      res.status(result.status).json({ error: result.error })
      return
    }

    res.status(201).json({ note: result.note, attachment: result.attachment })
  },
)

router.get('/:id/attachments', requireAuth, async (req, res) => {
  const user = (req as typeof req & { vocalUser: Awaited<ReturnType<typeof getCurrentVocalUser>> })
    .vocalUser
  const ticketId = String(req.params.id)

  const listOpts = parseAttachmentsListQuery(req.query as Record<string, unknown>)
  const result = await listTicketNotesAndAttachments(
    ticketId,
    user.organization_id,
    listOpts,
    user.roles?.name,
  )
  if ('error' in result) {
    const status = result.error === 'Ticket not found' ? 404 : 500
    res.status(status).json({ error: result.error })
    return
  }

  res.json({
    notes: result.notes,
    attachments: result.attachments,
    notes_pagination: result.notes_pagination,
    attachments_pagination: result.attachments_pagination,
    can_preview_media: result.can_preview_media,
    filters: { limit: listOpts.limit, offset: listOpts.offset },
  })
})

/** Paginated ground workers for assign dropdown; central_support / super_admin only */
router.get('/:id/assignable-workers', requireAuth, async (req, res) => {
  const user = (req as typeof req & { vocalUser: Awaited<ReturnType<typeof getCurrentVocalUser>> })
    .vocalUser
  const ticketId = String(req.params.id)

  try {
    const result = await listAssignableWorkersForTicket(
      user as any,
      ticketId,
      req.query as Record<string, unknown>,
    )
    if (!result.ok) {
      res.status(result.status).json({ error: result.error })
      return
    }
    res.json({
      workers: result.result.workers,
      pagination: result.result.pagination,
      filters: result.filters,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Assignable workers list failed'
    res.status(500).json({ error: message })
  }
})

/** Pending AI triage suggestion; central_support / super_admin only */
router.get('/:id/ai-suggestion', requireAuth, async (req, res) => {
  const user = (req as typeof req & { vocalUser: Awaited<ReturnType<typeof getCurrentVocalUser>> })
    .vocalUser

  if (!canAccessAiSuggestions(user.roles?.name)) {
    res.status(403).json({ error: 'Forbidden — central support or super admin only' })
    return
  }

  const ticketId = String(req.params.id)
  const supabase = createSupabaseServiceClient()
  const { data: ticket, error: ticketErr } = await supabase
    .from('tickets')
    .select('id')
    .eq('id', ticketId)
    .eq('organization_id', user.organization_id)
    .maybeSingle()

  if (ticketErr) {
    console.error('[GET /v2/tickets/:id/ai-suggestion] ticket lookup', ticketErr)
    res.status(500).json({ error: ticketErr.message })
    return
  }
  if (!ticket) {
    res.status(404).json({ error: 'Ticket not found' })
    return
  }

  const aiSuggestion = await getPendingAiSuggestion(ticketId)
  res.json({ aiSuggestion })
})

router.get('/:id', requireAuth, async (req, res) => {
  const user = (req as typeof req & { vocalUser: Awaited<ReturnType<typeof getCurrentVocalUser>> })
    .vocalUser

  const supabase = createSupabaseServiceClient()
  const { data, error } = await supabase
    .from('tickets')
    .select(`
      *,
      category:issue_categories!tickets_category_id_fkey(id, name),
      subcategory:issue_categories!tickets_subcategory_id_fkey(id, name),
      owner:users!tickets_owner_user_id_fkey(id, full_name),
      territories(id, name)
    `)
    .eq('id', req.params.id)
    .eq('organization_id', user.organization_id)
    .single()

  if (error) {
    console.error('[GET /v2/tickets/:id]', error)
    res.status(error.code === 'PGRST116' ? 404 : 500).json({ error: error.message })
    return
  }

  const row = data as Record<string, unknown>
  const ticket = nestTicketSla(
    nestTicketClassification(stripTicketAiMirrorFields(row), row),
    row,
  )
  const citizen_identity = await loadCitizenIdentityForTicket(
    {
      citizen_id: row.citizen_id as string | null,
      anonymous_flag: row.anonymous_flag === true,
      source_channel: String(row.source_channel ?? ''),
      citizen_identity_revealed_at: row.citizen_identity_revealed_at as string | null,
      citizen_identity_revealed_by: row.citizen_identity_revealed_by as string | null,
    },
    user.roles?.name,
  )
  const ticketId = String(req.params.id)
  const roleName = user.roles?.name
  const privilegedAssign = canAssignTickets(roleName)
  const [has_pending_ai_suggestion, has_attachments, has_notes, statusHistoryRes, current_assignment, assignable_worker_count] =
    await Promise.all([
      Promise.resolve(shouldFetchAiSuggestion(roleName, row.needs_triage === true)),
      ticketHasAttachments(ticketId),
      ticketHasNotes(ticketId),
      listTicketStageHistory(ticketId, user.organization_id),
      getCurrentAssignment(ticketId, user.organization_id),
      privilegedAssign ? countAssignableWorkers(user.organization_id) : Promise.resolve(0),
    ])
  const can_preview_attachments = canPreviewAttachmentMedia(
    user.roles?.name,
    row.citizen_identity_revealed_at as string | null,
  )

  if ('error' in statusHistoryRes) {
    console.error('[GET /v2/tickets/:id] status_history', statusHistoryRes.error)
    res.status(500).json({ error: statusHistoryRes.error })
    return
  }

  const can_respond_to_offer = workerCanRespondToOffer(roleName, user.id, current_assignment)

  res.json({
    ticket: stripTicketDetailDuplicates({
      ...ticket,
      citizen_identity,
      status_history: statusHistoryRes,
      has_pending_ai_suggestion,
      has_notes_or_attachments: has_attachments || has_notes,
      can_preview_attachments,
    }),
    current_assignment,
    assignable_worker_count: privilegedAssign ? assignable_worker_count : null,
    can_assign: privilegedAssign && assignable_worker_count > 0,
    can_respond_to_offer,
  })
})

export default router
