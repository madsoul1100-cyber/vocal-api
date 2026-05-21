import { Router } from 'express'
import { requireClerkAuth } from '@/middleware/clerkAuth.js'
import {
  archiveDirectoryContact,
  canWriteDirectory,
  createDirectoryContact,
  listDirectoryContacts,
  updateDirectoryContact,
} from '@/services/directoryService.js'

const router = Router()

type VocalUser = {
  id: string
  organization_id: string
  roles?: { name: string } | null
}

router.get('/', requireClerkAuth, async (req, res) => {
  const user = (req as typeof req & { vocalUser: VocalUser }).vocalUser
  const search = typeof req.query.search === 'string' ? req.query.search : undefined
  const status = typeof req.query.status === 'string' ? req.query.status : undefined

  const { contacts, count } = await listDirectoryContacts(user.organization_id, { search, status })
  res.json({
    contacts,
    count,
    canWrite: canWriteDirectory(user.roles?.name),
  })
})

router.post('/', requireClerkAuth, async (req, res) => {
  const user = (req as typeof req & { vocalUser: VocalUser }).vocalUser
  const result = await createDirectoryContact(user, req.body ?? {})
  if (!result.ok) {
    res.status(result.status).json({ error: result.error })
    return
  }
  res.json({ ok: true, id: result.id })
})

router.patch('/:id', requireClerkAuth, async (req, res) => {
  const user = (req as typeof req & { vocalUser: VocalUser }).vocalUser
  const id = String(req.params.id)
  const result = await updateDirectoryContact(user, id, req.body ?? {})
  if (!result.ok) {
    res.status(result.status).json({ error: result.error })
    return
  }
  res.json({ ok: true })
})

router.delete('/:id', requireClerkAuth, async (req, res) => {
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
