import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import ws from 'ws'
import { isPostgresMode } from '@/lib/db.js'
import { createPostgresServiceClient } from '@/lib/postgresCompat/builder.js'

/**
 * Server-side DB client.
 * - Prefer DATABASE_URL (direct PostgreSQL / RDS)
 * - Fallback: Supabase REST API (legacy)
 *
 * When DATABASE_URL is set, a Postgres-backed adapter implements the subset
 * of Supabase query methods used in vocal-api.
 */
export function createSupabaseServiceClient(): SupabaseClient {
  if (isPostgresMode()) {
    return createPostgresServiceClient() as unknown as SupabaseClient
  }

  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !key) {
    throw new Error(
      'Set DATABASE_URL for PostgreSQL, or SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY for Supabase',
    )
  }

  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) {
    throw new Error(
      'SUPABASE_URL is a Postgres connection string. Use DATABASE_URL instead (Supabase JS needs the HTTPS API URL).',
    )
  }

  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    // Node < 22 has no native WebSocket; required for Supabase client init
    realtime: { transport: ws as any },
  })
}
