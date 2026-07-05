/**
 * Backfill district centroid_lat / centroid_lng from TELANGANA_DISTRICT_CENTROIDS_BY_CODE.
 *
 * Usage:
 *   ORG_ID=<uuid> npm run backfill:district-centroids
 */
import '../src/loadEnv.js'
import { createSupabaseServiceClient } from '../src/lib/supabase.js'
import { isPostgresMode, dbQuery } from '../src/lib/db.js'
import { TELANGANA_DISTRICT_CENTROIDS_BY_CODE } from '../src/data/telanganaDistrictCentroids.js'
import { invalidateTerritoryTreeCache } from '../src/services/territoryService.js'

const ORG_ID = process.env.ORG_ID?.trim()
if (!ORG_ID) {
  console.error('ORG_ID is required in .env.local')
  process.exit(1)
}

async function main() {
  let updated = 0

  if (isPostgresMode()) {
    for (const [code, coords] of Object.entries(TELANGANA_DISTRICT_CENTROIDS_BY_CODE)) {
      const res = await dbQuery(
        `UPDATE territories t
         SET centroid_lat = $3, centroid_lng = $4, updated_at = now()
         FROM territory_level_definitions tld
         WHERE t.level_definition_id = tld.id
           AND t.organization_id = $1
           AND t.active = true
           AND tld.level_order = 2
           AND t.code = $2
           AND (t.centroid_lat IS NULL OR t.centroid_lng IS NULL)`,
        [ORG_ID, code, coords.lat, coords.lng],
      )
      updated += res.rowCount ?? 0
    }
  } else {
    const supabase = createSupabaseServiceClient()
    const { data: levels } = await supabase
      .from('territory_level_definitions')
      .select('id')
      .eq('organization_id', ORG_ID)
      .eq('level_order', 2)
      .maybeSingle()
    if (!levels?.id) {
      console.error('District level not found for org')
      process.exit(1)
    }

    for (const [code, coords] of Object.entries(TELANGANA_DISTRICT_CENTROIDS_BY_CODE)) {
      const { data: rows } = await supabase
        .from('territories')
        .select('id, centroid_lat, centroid_lng')
        .eq('organization_id', ORG_ID)
        .eq('level_definition_id', levels.id)
        .eq('code', code)
        .eq('active', true)

      for (const row of rows ?? []) {
        if (row.centroid_lat != null && row.centroid_lng != null) continue
        const { error } = await supabase
          .from('territories')
          .update({
            centroid_lat: coords.lat,
            centroid_lng: coords.lng,
            updated_at: new Date().toISOString(),
          })
          .eq('id', row.id)
        if (error) {
          console.error(`Failed ${code}:`, error.message)
          process.exit(1)
        }
        updated++
      }
    }
  }

  invalidateTerritoryTreeCache(ORG_ID)
  console.log(`Backfilled district centroids: ${updated} row(s) updated`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
