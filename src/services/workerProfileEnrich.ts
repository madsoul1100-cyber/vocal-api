import {
  ensureDefaultStaffProfileAsset,
  resolveStaffProfileStoragePath,
  signedUrlForStaffStorage,
} from '@/services/staffStorageService.js'
import { isDefaultStaffProfilePath } from '@/constants/staffProfileDefaults.js'
import { createSupabaseServiceClient } from '@/lib/supabase.js'
import { isPostgresMode, dbQuery } from '@/lib/db.js'

/** Worker chip for ticket UI (assign, timeline, owner). */
export interface WorkerProfileRef {
  id: string
  full_name: string
  image_url: string | null
  profile_image_url: string | null
}

export async function profileImageUrlForStoragePath(
  imageUrl: string | null | undefined,
): Promise<string | null> {
  const path = resolveStaffProfileStoragePath(imageUrl)
  if (isDefaultStaffProfilePath(path)) {
    await ensureDefaultStaffProfileAsset()
  }
  return signedUrlForStaffStorage(path)
}

export async function enrichWorkerProfile(worker: {
  id: string
  full_name: string
  image_url?: string | null
}): Promise<WorkerProfileRef> {
  const image_url = worker.image_url ?? (await loadUserImageUrl(worker.id))
  const profile_image_url = await profileImageUrlForStoragePath(image_url)
  return {
    id: worker.id,
    full_name: worker.full_name,
    image_url,
    profile_image_url,
  }
}

export async function enrichWorkerProfiles<T extends { id: string; full_name: string; image_url?: string | null }>(
  workers: T[],
): Promise<(T & { image_url: string | null; profile_image_url: string | null })[]> {
  const missingIds = workers.filter((w) => w.image_url === undefined).map((w) => w.id)
  const imageById = missingIds.length ? await loadUserImageUrls(missingIds) : new Map<string, string | null>()

  return Promise.all(
    workers.map(async (w) => {
      const image_url = w.image_url !== undefined ? w.image_url : (imageById.get(w.id) ?? null)
      const profile_image_url = await profileImageUrlForStoragePath(image_url)
      return { ...w, image_url, profile_image_url }
    }),
  )
}

export type AssignableWorkerRow = {
  id: string
  full_name: string
  image_url: string | null
  territory_ids: string[]
}

export type EnrichedAssignableWorker = AssignableWorkerRow & {
  profile_image_url: string | null
}

/** Assign dropdown rows — preserves territory_ids for typing. */
export async function enrichAssignableWorkers(
  workers: AssignableWorkerRow[],
): Promise<EnrichedAssignableWorker[]> {
  return enrichWorkerProfiles(workers) as Promise<EnrichedAssignableWorker[]>
}

async function loadUserImageUrl(userId: string): Promise<string | null> {
  const map = await loadUserImageUrls([userId])
  return map.get(userId) ?? null
}

async function loadUserImageUrls(userIds: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>()
  if (!userIds.length) return out

  if (isPostgresMode()) {
    const res = await dbQuery<{ id: string; image_url: string | null }>(
      `SELECT id, image_url FROM users WHERE id = ANY($1::uuid[])`,
      [userIds],
    )
    for (const row of res.rows) out.set(row.id, row.image_url)
    return out
  }

  const supabase = createSupabaseServiceClient()
  const { data } = await supabase.from('users').select('id, image_url').in('id', userIds)
  for (const row of data ?? []) {
    out.set(row.id as string, (row.image_url as string | null) ?? null)
  }
  return out
}
