import type { Request } from 'express'
import { createSupabaseServiceClient } from '@/lib/supabase.js'
import { verifyAccessToken } from '@/services/authService.js'

const USER_SELECT = '*, roles(*), organizations(name)'

export function getBearerToken(req: Request): string | null {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) return null
  const token = header.slice(7).trim()
  return token || null
}

/**
 * Resolve JWT Bearer token → internal Vocal users row (active only).
 */
export async function getCurrentVocalUser(req: Request) {
  const token = getBearerToken(req)
  if (!token) return null

  const payload = verifyAccessToken(token)
  if (!payload?.sub) return null

  const supabase = createSupabaseServiceClient()
  const { data, error } = await supabase
    .from('users')
    .select(USER_SELECT)
    .eq('id', payload.sub)
    .eq('active', true)
    .single()

  if (error || !data) return null

  void supabase
    .from('users')
    .update({ last_login_at: new Date().toISOString() })
    .eq('id', data.id)

  return data
}
