import { createSupabaseServiceClient } from '@/lib/supabase.js'

const USER_SELECT = '*, roles(*), organizations(name)'

/** True only outside production when local dev bypass is enabled. */
export function isDevAuthBypassEnabled(): boolean {
  if (process.env.NODE_ENV === 'production') return false
  if (process.env.DEV_BYPASS_AUTH === 'false' || process.env.DEV_BYPASS_AUTH === '0') {
    return false
  }
  if (process.env.DEV_BYPASS_AUTH === 'true' || process.env.DEV_BYPASS_AUTH === '1') {
    return true
  }
  return process.env.NODE_ENV === 'development'
}

/**
 * Impersonate a staff user for local API calls (no JWT).
 * Prefer DEV_USER_ID; else first super_admin in ORG_ID; else any active user in org.
 */
export async function getDevBypassVocalUser() {
  const supabase = createSupabaseServiceClient()
  const devUserId = process.env.DEV_USER_ID?.trim()

  if (devUserId) {
    const { data } = await supabase
      .from('users')
      .select(USER_SELECT)
      .eq('id', devUserId)
      .eq('active', true)
      .maybeSingle()
    if (data) return data
  }

  const orgId = process.env.ORG_ID?.trim()
  let query = supabase.from('users').select(USER_SELECT).eq('active', true).limit(25)
  if (orgId) query = query.eq('organization_id', orgId)

  const { data: users } = await query
  if (!users?.length) return null

  const superAdmin = users.find(
    (u) => (u.roles as { name: string } | null)?.name === 'super_admin',
  )
  return superAdmin ?? users[0]
}
