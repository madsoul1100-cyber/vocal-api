import { Router } from 'express'
import { requireClerkAuth } from '@/middleware/clerkAuth.js'
import { getCurrentVocalUser } from '@/lib/auth.js'
import { createSupabaseServiceClient } from '@/lib/supabase.js'
import {
  listTicketsV2,
  parseTicketsV2ListQuery,
  ticketsV2FiltersEcho,
} from '@/services/ticketQueries.js'
import { acceptTicket, rejectTicket, updateTicketStatus } from '@/services/ticketActionsService.js'

const router = Router()

/** v2: paginated list with sort, filters (incl. SLA), and keyword search */
router.get('/', requireClerkAuth, async (req, res) => {
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

router.post('/accept', requireClerkAuth, async (req, res) => {
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

router.post('/reject', requireClerkAuth, async (req, res) => {
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

router.post('/status', requireClerkAuth, async (req, res) => {
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

router.get('/:id', requireClerkAuth, async (req, res) => {
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

  res.json({ ticket: data })
})

export default router
