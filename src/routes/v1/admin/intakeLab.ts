import { Router } from 'express'
import { requireClerkAuth } from '@/middleware/clerkAuth.js'
import {
  processInbound,
  type IntakeRequest,
} from '@/services/intakeConversationManager.js'

const router = Router()

export const INTAKE_LAB_ALLOWED_ROLES = ['super_admin', 'central_support']

type VocalUser = {
  roles?: { name: string } | null
}

function requireIntakeLabRole(
  req: Parameters<typeof requireClerkAuth>[0],
  res: import('express').Response,
): boolean {
  const user = (req as typeof req & { vocalUser: VocalUser }).vocalUser
  const role = user.roles?.name
  if (!role || !INTAKE_LAB_ALLOWED_ROLES.includes(role)) {
    res.status(403).json({ error: 'Insufficient role' })
    return false
  }
  return true
}

router.post('/test', requireClerkAuth, async (req, res) => {
  if (!requireIntakeLabRole(req, res)) return

  const body = req.body as IntakeRequest
  if (!body || typeof body !== 'object') {
    res.status(400).json({ error: 'Body must be an IntakeRequest' })
    return
  }
  if (!body.newMessage) {
    res.status(400).json({ error: 'newMessage is required' })
    return
  }
  if (!Array.isArray(body.history)) {
    body.history = []
  }

  const result = await processInbound(body)
  res.json(result)
})

export default router
