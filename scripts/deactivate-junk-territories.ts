/**
 * Deactivate junk territory rows (wrong spellings / demo states at root level).
 *
 * Usage:
 *   ORG_ID=<uuid> npm run cleanup:territories
 *   ORG_ID=<uuid> npm run cleanup:territories -- --dry-run
 */
import '../src/loadEnv.js'
import { createSupabaseServiceClient } from '../src/lib/supabase.js'
import { invalidateTerritoryTreeCache } from '../src/services/territoryService.js'

const ORG_ID = process.env.ORG_ID?.trim()
const dryRun = process.argv.includes('--dry-run')

const JUNK_NAMES = new Set([
  'demo state',
  'uttar pradesh',
  'hyderabad',
  'hydrabad',
  'hyerabad',
])

if (!ORG_ID) {
  console.error('ORG_ID is required')
  process.exit(1)
}

async function main() {
  const supabase = createSupabaseServiceClient()

  const { data: levels } = await supabase
    .from('territory_level_definitions')
    .select('id, level_order')
    .eq('organization_id', ORG_ID!)
    .eq('level_order', 1)

  const level1Ids = new Set((levels ?? []).map((l) => l.id as string))

  const { data: rows, error } = await supabase
    .from('territories')
    .select('id, name, parent_territory_id, level_definition_id, active')
    .eq('organization_id', ORG_ID!)
    .eq('active', true)

  if (error) {
    console.error(error.message)
    process.exit(1)
  }

  const junk = (rows ?? []).filter((t) => {
    const name = String(t.name).trim().toLowerCase()
    if (name === 'telangana') return false
    if (!level1Ids.has(t.level_definition_id as string)) return false
    return JUNK_NAMES.has(name) || (t.parent_territory_id == null && name !== 'telangana')
  })

  if (junk.length === 0) {
    console.log('No junk territories found.')
    return
  }

  console.log(dryRun ? 'Dry run — would deactivate:' : 'Deactivating:')
  for (const j of junk) {
    console.log(`  - ${j.name} (${j.id})`)
  }

  if (dryRun) return

  const ids = junk.map((j) => j.id as string)
  const { error: updErr } = await supabase
    .from('territories')
    .update({ active: false, updated_at: new Date().toISOString() })
    .in('id', ids)

  if (updErr) {
    console.error(updErr.message)
    process.exit(1)
  }

  invalidateTerritoryTreeCache(ORG_ID!)
  console.log(`\nDeactivated ${ids.length} row(s). Run: ORG_ID=${ORG_ID} npm run audit:territories`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
