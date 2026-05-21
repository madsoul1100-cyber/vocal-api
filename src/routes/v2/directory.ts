import { Router } from 'express'
import { requireAuth } from '@/middleware/requireAuth.js'
import {
  archiveDirectoryContact,
  canWriteDirectory,
  createDirectoryContact,
  listDirectoryContactsV2,
  parseDirectoryV2ListQuery,
  updateDirectoryContact,
} from '@/services/directoryService.js'

const router = Router()

type VocalUser = {
  id: string
  organization_id: string
  roles?: { name: string } | null
}

/** v2: paginated list with keyword, category, and status filters */
router.get('/', requireAuth, async (req, res) => {
  const user = (req as typeof req & { vocalUser: VocalUser }).vocalUser
  const listOpts = parseDirectoryV2ListQuery(req.query as Record<string, unknown>)

  try {
    const { contacts, pagination } = await listDirectoryContactsV2(
      user.organization_id,
      listOpts,
    )
    res.json({
      contacts,
      pagination,
      canWrite: canWriteDirectory(user.roles?.name),
      filters: {
        keyword: listOpts.keyword ?? null,
        category: listOpts.category ?? null,
        status: listOpts.status ?? null,
        limit: listOpts.limit,
        offset: listOpts.offset,
      },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Directory list failed'
    res.status(500).json({ error: message })
  }
})

router.post('/', requireAuth, async (req, res) => {
  const user = (req as typeof req & { vocalUser: VocalUser }).vocalUser
  const result = await createDirectoryContact(user, req.body ?? {})
  if (!result.ok) {
    res.status(result.status).json({ error: result.error })
    return
  }
  res.json({ ok: true, id: result.id })
})

router.patch('/:id', requireAuth, async (req, res) => {
  const user = (req as typeof req & { vocalUser: VocalUser }).vocalUser
  const id = String(req.params.id)
  const result = await updateDirectoryContact(user, id, req.body ?? {})
  if (!result.ok) {
    res.status(result.status).json({ error: result.error })
    return
  }
  res.json({ ok: true })
})

router.delete('/:id', requireAuth, async (req, res) => {
  const user = (req as typeof req & { vocalUser: VocalUser }).vocalUser
  const id = String(req.params.id)
  const result = await archiveDirectoryContact(user, id)
  if (!result.ok) {
    res.status(result.status).json({ error: result.error })
    return
  }
  res.json({ ok: true })
})

export default router
