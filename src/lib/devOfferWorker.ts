/**
 * Dev-only: pin all ticket offers to one ground worker (default "Sanjay Gupta").
 * Disabled in production. Set DEV_OFFER_WORKER_PIN=false to turn off in development.
 */

import { createSupabaseServiceClient } from '@/lib/supabase.js'

const GROUND_WORKER_ROLE_ID = '00000000-0000-0000-0000-000000000005'

const cachedWorkerIdByOrg = new Map<string, string | null>()

/** True outside production unless explicitly disabled. On by default in NODE_ENV=development. */
export function isDevOfferWorkerPinEnabled(): boolean {
  if (process.env.NODE_ENV === 'production') return false
  if (process.env.DEV_OFFER_WORKER_PIN === 'false' || process.env.DEV_OFFER_WORKER_PIN === '0') {
    return false
  }
  if (process.env.DEV_OFFER_WORKER_PIN === 'true' || process.env.DEV_OFFER_WORKER_PIN === '1') {
    return true
  }
  if (process.env.DEV_OFFER_WORKER_ID?.trim() || process.env.DEV_OFFER_WORKER_NAME?.trim()) {
    return true
  }
  return process.env.NODE_ENV === 'development'
}

export function devOfferWorkerDisplayName(): string {
  return process.env.DEV_OFFER_WORKER_NAME?.trim() || 'Sanjay Gupta'
}

/**
 * Resolve pinned worker UUID for this org. Returns null if pin off or user not found.
 */
export async function resolveDevPinnedWorkerId(organizationId: string): Promise<string | null> {
  if (!isDevOfferWorkerPinEnabled()) return null

  const fromEnv = process.env.DEV_OFFER_WORKER_ID?.trim()
  if (fromEnv) {
    const ok = await verifyGroundWorkerInOrg(fromEnv, organizationId)
    if (!ok) {
      console.warn(
        `[devOfferWorker] DEV_OFFER_WORKER_ID=${fromEnv} is not an active ground_worker in org ${organizationId}`,
      )
      return null
    }
    return fromEnv
  }

  if (cachedWorkerIdByOrg.has(organizationId)) {
    return cachedWorkerIdByOrg.get(organizationId) ?? null
  }

  const supabase = createSupabaseServiceClient()
  const name = devOfferWorkerDisplayName()
  const { data: rows } = await supabase
    .from('users')
    .select('id, full_name')
    .eq('organization_id', organizationId)
    .eq('role_id', GROUND_WORKER_ROLE_ID)
    .eq('active', true)
    .ilike('full_name', `%${name}%`)
    .limit(5)

  const match =
    rows?.find((r) => r.full_name?.toLowerCase().includes(name.toLowerCase())) ?? rows?.[0]

  if (!match) {
    console.warn(
      `[devOfferWorker] No active ground_worker matching "${name}" in org ${organizationId}. Offers will use normal routing.`,
    )
    cachedWorkerIdByOrg.set(organizationId, null)
    return null
  }

  if ((rows?.length ?? 0) > 1) {
    console.warn(
      `[devOfferWorker] Multiple workers match "${name}"; using ${match.full_name} (${match.id})`,
    )
  }

  console.warn(`[devOfferWorker] Pinning offers to ${match.full_name} (${match.id})`)
  cachedWorkerIdByOrg.set(organizationId, match.id)
  return match.id
}

/** Override target worker on offer (dev pin). */
export async function applyDevOfferWorkerPin(args: {
  ticketId: string
  workerId: string
  organizationId: string
}): Promise<string> {
  const pinId = await resolveDevPinnedWorkerId(args.organizationId)
  if (!pinId || pinId === args.workerId) return args.workerId
  console.warn(
    `[devOfferWorker] Redirecting offer for ticket ${args.ticketId} from worker ${args.workerId} → ${pinId}`,
  )
  return pinId
}

async function verifyGroundWorkerInOrg(
  userId: string,
  organizationId: string,
): Promise<boolean> {
  const supabase = createSupabaseServiceClient()
  const { data } = await supabase
    .from('users')
    .select('id')
    .eq('id', userId)
    .eq('organization_id', organizationId)
    .eq('role_id', GROUND_WORKER_ROLE_ID)
    .eq('active', true)
    .maybeSingle()
  return !!data
}
