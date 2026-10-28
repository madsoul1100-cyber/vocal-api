/**
 * OpenClaw companion HTTP tools (Phase 2).
 * Auth: Authorization: Bearer <BHAROSA_MCP_TOKEN>
 * Header: X-Org-Id: <uuid>
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { z } from 'zod'
import {
  companionConfigured,
  companionTokenOk,
  COMPANION_TOOLS,
} from '@/modules/bharosa/companion/tools.js'
import {
  getCase,
  getOpenDraftSummary,
  listOpenCases,
  proposeCitizenNudge,
} from '@/modules/bharosa/companion/service.js'
import { getCitizenMemoryForCompanion } from '@/modules/bharosa/companion/citizenMemory.js'

const router = Router()

function requireCompanion(req: Request, res: Response, next: NextFunction): void {
  if (!companionConfigured()) {
    res.status(503).json({ error: 'Companion disabled', code: 'COMPANION_OFF' })
    return
  }
  const header = req.headers.authorization ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : header.trim()
  if (!companionTokenOk(token)) {
    res.status(401).json({ error: 'Invalid companion token', code: 'UNAUTHORIZED' })
    return
  }
  next()
}

function orgIdFrom(req: Request): string | null {
  const fromHeader = typeof req.headers['x-org-id'] === 'string' ? req.headers['x-org-id'] : null
  const fromQuery = typeof req.query.orgId === 'string' ? req.query.orgId : null
  const fromBody = req.body && typeof req.body.orgId === 'string' ? req.body.orgId : null
  const id = fromHeader || fromQuery || fromBody
  if (!id || !z.string().uuid().safeParse(id).success) return null
  return id
}

router.use(requireCompanion)

router.get('/tools', (_req, res) => {
  res.json({ companion: process.env.BHAROSA_COMPANION ?? 'openclaw', tools: COMPANION_TOOLS })
})

router.get('/cases', async (req, res) => {
  const orgId = orgIdFrom(req)
  if (!orgId) {
    res.status(400).json({ error: 'X-Org-Id (uuid) required', code: 'ORG_REQUIRED' })
    return
  }
  const limit = Math.min(Number(req.query.limit) || 10, 25)
  const cases = await listOpenCases(orgId, limit)
  res.json({ cases })
})

router.get('/cases/:ticketNumber', async (req, res) => {
  const orgId = orgIdFrom(req)
  if (!orgId) {
    res.status(400).json({ error: 'X-Org-Id (uuid) required', code: 'ORG_REQUIRED' })
    return
  }
  const row = await getCase(orgId, req.params.ticketNumber)
  if (!row) {
    res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' })
    return
  }
  res.json({ case: row })
})

router.get('/drafts', async (req, res) => {
  const orgId = orgIdFrom(req)
  if (!orgId) {
    res.status(400).json({ error: 'X-Org-Id (uuid) required', code: 'ORG_REQUIRED' })
    return
  }
  const phone = typeof req.query.phone === 'string' ? req.query.phone : null
  const summary = await getOpenDraftSummary(orgId, phone)
  res.json(summary)
})

router.post('/nudge/propose', async (req, res) => {
  const orgId = orgIdFrom(req)
  if (!orgId) {
    res.status(400).json({ error: 'X-Org-Id (uuid) required', code: 'ORG_REQUIRED' })
    return
  }
  const body = z
    .object({
      language: z.string().default('en'),
      name: z.string().nullable().optional(),
      problemPreview: z.string().nullable().optional(),
    })
    .safeParse(req.body ?? {})
  if (!body.success) {
    res.status(400).json({ error: 'Invalid body', code: 'VALIDATION', details: body.error.flatten() })
    return
  }
  const proposed = proposeCitizenNudge(body.data)
  res.json({ orgId, ...proposed })
})

router.get('/memory/:citizenId', async (req, res) => {
  const orgId = orgIdFrom(req)
  if (!orgId) {
    res.status(400).json({ error: 'X-Org-Id (uuid) required', code: 'ORG_REQUIRED' })
    return
  }
  const citizenId = req.params.citizenId
  if (!z.string().uuid().safeParse(citizenId).success) {
    res.status(400).json({ error: 'citizenId must be a uuid', code: 'VALIDATION' })
    return
  }
  const memory = await getCitizenMemoryForCompanion(orgId, citizenId)
  if (!memory) {
    res.status(404).json({ error: 'No memory yet for this citizen', code: 'NOT_FOUND' })
    return
  }
  res.json(memory)
})

export default router
