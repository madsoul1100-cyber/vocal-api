import { Router } from 'express'
import { requireAuth } from '@/middleware/requireAuth.js'
import { getCurrentVocalUser } from '@/lib/auth.js'
import { createSupabaseServiceClient } from '@/lib/supabase.js'
import { queryTickets } from '@/services/ticketQueries.js'
import { acceptTicket, rejectTicket, updateTicketStatus } from '@/services/ticketActionsService.js'

const router = Router()

function sanitizeSearch(raw: string): string {
  return raw.replace(/[,()."'%_\\]/g, '').slice(0, 100)
}

router.get('/', requireAuth, async (req, res) => {
  const user = (req as typeof req & { vocalUser: Awaited<ReturnType<typeof getCurrentVocalUser>> })
    .vocalUser

  const supabase = createSupabaseServiceClient()
  const search = typeof req.query.search === 'string' ? sanitizeSearch(req.query.search) : undefined

  const { data, error, count } = await queryTickets(supabase, user.organization_id, {
    stage: req.query.stage as any,
    severity: req.query.severity as any,
    needsTriage: req.query.needs_triage === 'true',
    slaBreached: req.query.sla_breached === 'true',
    hasLocation: req.query.has_location === 'true',
    ownerId: typeof req.query.owner_id === 'string' ? req.query.owner_id : undefined,
    search,
    limit: req.query.limit ? Number(req.query.limit) : 50,
    offset: req.query.offset ? Number(req.query.offset) : 0,
  })

  if (error) {
    res.status(500).json({ error: error.message })
    return
  }

  res.json({ tickets: data ?? [], count: count ?? 0 })
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
    console.error('[GET /v1/tickets/:id]', error)
    res.status(error.code === 'PGRST116' ? 404 : 500).json({ error: error.message })
    return
  }

  res.json({ ticket: data })
})

export default router
