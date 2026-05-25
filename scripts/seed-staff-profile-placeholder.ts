/**
 * Upload the default staff profile PNG to storage and backfill image_url for rows without one.
 *
 * Usage (from vocal-api):
 *   npm run seed:staff-profile-placeholder
 *
 * Optional:
 *   ORG_ID=<uuid>  — limit user backfill to one organization
 *
 * Requires: DATABASE_URL, assets/default-staff-profile.png
 */
import dotenv from 'dotenv'
import pg from 'pg'
import { DEFAULT_STAFF_PROFILE_STORAGE_PATH } from '../src/constants/staffProfileDefaults.js'
import { ensureDefaultStaffProfileAsset } from '../src/services/staffStorageService.js'

dotenv.config()
dotenv.config({ path: '.env.local', override: true })

const ORG_ID = process.env.ORG_ID?.trim()

async function main() {
  const url = process.env.DATABASE_URL?.trim()
  if (!url) {
    throw new Error('DATABASE_URL is required in .env.local')
  }

  const asset = await ensureDefaultStaffProfileAsset()
  if (!asset.ok) {
    throw new Error(asset.error)
  }
  console.log(`✓ Default profile asset at ${asset.storage_path}`)

  const pool = new pg.Pool({
    connectionString: url,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  })

  try {
    const usersParams: unknown[] = [DEFAULT_STAFF_PROFILE_STORAGE_PATH]
    let usersSql = `
      update users
      set image_url = $1, updated_at = now()
      where image_url is null or trim(image_url) = ''`
    if (ORG_ID) {
      usersParams.push(ORG_ID)
      usersSql += ` and organization_id = $2`
    }
    usersSql += ' returning id'

    const usersRes = await pool.query<{ id: string }>(usersSql, usersParams)
    console.log(`✓ Users backfilled: ${usersRes.rowCount ?? 0}`)

    const pendingParams: unknown[] = [DEFAULT_STAFF_PROFILE_STORAGE_PATH]
    let pendingSql = `
      update worker_activation_requests
      set image_url = $1
      where image_url is null or trim(image_url) = ''`
    if (ORG_ID) {
      pendingParams.push(ORG_ID)
      pendingSql += ` and organization_id = $2`
    }
    pendingSql += ' returning id'

    const pendingRes = await pool.query<{ id: string }>(pendingSql, pendingParams)
    console.log(`✓ Pending activations backfilled: ${pendingRes.rowCount ?? 0}`)
  } finally {
    await pool.end()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
