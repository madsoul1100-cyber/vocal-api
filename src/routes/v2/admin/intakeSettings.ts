import { Router } from 'express'
import { requireClerkAuth } from '@/middleware/clerkAuth.js'
import { createSupabaseServiceClient } from '@/lib/supabase.js'
import {
  getIntakeVersion,
  setIntakeVersion,
  type IntakeVersion,
} from '@/services/intakeSettingsService.js'

const router = Router()

type VocalUser = {
  id: string
  organization_id: string
  roles?: { name: string } | null
}

function requireSuperAdmin(
  req: Parameters<typeof requireClerkAuth>[0],
  res: import('express').Response,
): VocalUser | null {
  const user = (req as typeof req & { vocalUser: VocalUser }).vocalUser
  if (user.roles?.name !== 'super_admin') {
    res.status(403).json({ error: 'Forbidden — super_admin only' })
    return null
  }
  return user
}

router.get('/', requireClerkAuth, async (req, res) => {
  const user = requireSuperAdmin(req, res)
  if (!user) return

  const version = await getIntakeVersion(user.organization_id)
  res.json({ version })
})

router.post('/', requireClerkAuth, async (req, res) => {
  const user = requireSuperAdmin(req, res)
  if (!user) return

  const newVersion = req.body?.version as IntakeVersion
  if (newVersion !== 'v1' && newVersion !== 'v2') {
    res.status(400).json({ error: "version must be 'v1' or 'v2'" })
    return
  }

  const prevVersion = await getIntakeVersion(user.organization_id)
  const result = await setIntakeVersion(user.organization_id, newVersion)
  if (!result.ok) {
    res.status(500).json({ error: result.error ?? 'Update failed' })
    return
  }

  const supabase = createSupabaseServiceClient()
  await supabase.from('audit_logs').insert({
    organization_id: user.organization_id,
    event_type: 'intake_version_changed',
    entity_type: 'organization_settings',
    actor_type: 'user',
    actor_user_id: user.id,
    old_value_json: { intake_conversation_version: prevVersion },
    new_value_json: { intake_conversation_version: newVersion },
  })

  res.json({ ok: true, version: newVersion, previous: prevVersion })
})

export default router
