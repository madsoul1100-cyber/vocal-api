import { Router } from 'express'
import { requireAuth } from '@/middleware/requireAuth.js'
import type { AmplifyPlatform, AmplifyTone } from '@/services/amplifyService.js'
import {
  canAccessAmplify,
  createAmplifySession,
  generateAmplifyDraft,
  getAmplifySession,
  listAmplifySessions,
} from '@/services/amplifyManagementService.js'

const router = Router()

type VocalUser = {
  id: string
  organization_id: string
  roles?: { name: string } | null
}

function requireAmplifyRole(req: Parameters<typeof requireAuth>[0], res: import('express').Response): VocalUser | null {
  const user = (req as typeof req & { vocalUser: VocalUser }).vocalUser
  if (!canAccessAmplify(user.roles?.name)) {
    res.status(403).json({ error: 'Insufficient role' })
    return null
  }
  return user
}

router.get('/', requireAuth, async (req, res) => {
  const user = requireAmplifyRole(req, res)
  if (!user) return

  const { sessions, count } = await listAmplifySessions(user.organization_id)
  res.json({ sessions, count })
})

router.post('/sessions', requireAuth, async (req, res) => {
  const user = requireAmplifyRole(req, res)
  if (!user) return

  const ticketId = typeof req.body?.ticket_id === 'string' ? req.body.ticket_id : ''
  if (!ticketId) {
    res.status(400).json({ error: 'ticket_id is required' })
    return
  }

  const result = await createAmplifySession(user, ticketId)
  if (!result.ok) {
    res.status(result.status).json({ error: result.error })
    return
  }
  res.json({ ok: true, id: result.id, reused: result.reused })
})

router.get('/sessions/:id', requireAuth, async (req, res) => {
  const user = requireAmplifyRole(req, res)
  if (!user) return

  const sessionId = String(req.params.id)
  const session = await getAmplifySession(user.organization_id, sessionId)
  if (!session) {
    res.status(404).json({ error: 'Session not found' })
    return
  }
  res.json(session)
})

router.post('/sessions/:id/generate', requireAuth, async (req, res) => {
  const user = requireAmplifyRole(req, res)
  if (!user) return

  const sessionId = String(req.params.id)
  const result = await generateAmplifyDraft(user, sessionId, {
    platform: req.body?.platform as AmplifyPlatform,
    tone: req.body?.tone as AmplifyTone | undefined,
    source_ids: req.body?.source_ids,
    extra_context: req.body?.extra_context,
  })

  if (!result.ok) {
    res.status(result.status).json({ error: result.error })
    return
  }
  res.json({ ok: true, output: result.output })
})

export default router
