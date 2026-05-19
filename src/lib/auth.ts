import type { Request } from 'express'
import { getAuth } from '@clerk/express'
import { createSupabaseServiceClient } from '@/lib/supabase.js'

/**
 * Resolve Clerk session → internal Vocal users row (active only).
 * Same lookup as the Next.js monolith getCurrentVocalUser().
 */
export async function getCurrentVocalUser(req: Request) {
  const { userId } = getAuth(req)
  if (!userId) return null

  const supabase = createSupabaseServiceClient()
  const { data, error } = await supabase
    .from('users')
    .select('*, roles(*), organizations(name)')
    .eq('clerk_user_id', userId)
    .eq('active', true)
    .single()

  if (error || !data) return null

  void supabase
    .from('users')
    .update({ last_login_at: new Date().toISOString() })
    .eq('id', data.id)

  return data
}
