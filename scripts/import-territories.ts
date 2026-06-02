/**
 * Import a hierarchical territory list (e.g. the Telangana sample extracted
 * from "vocal territory database.xlsx") into the app's territory model.
 *
 * It populates:
 *   - territory_level_definitions  (one row per level: State, District, ...)
 *   - territories                  (one row per node, wired via parent_territory_id)
 *
 * The seed file maps the LGD hierarchy onto our generic, org-scoped model so
 * that workers can be assigned to any node (a district, a mandal, a ward...)
 * and tickets in that node — or any descendant of it — auto-route to them.
 *
 * Idempotent: each node is tagged with metadata_json.source_key, so re-running
 * updates existing rows instead of duplicating them.
 *
 * Usage:
 *   ORG_ID=<org-uuid> npm run seed:territories
 *   ORG_ID=<org-uuid> npm run seed:territories -- data/territories/telangana.json
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (or DATABASE_URL) in .env.local
 */
import '../src/loadEnv.js'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSupabaseServiceClient } from '../src/lib/supabase.js'
import {
  invalidateTerritoryTreeCache,
  repairTelanganaDistrictParents,
} from '../src/services/territoryService.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

interface SeedLevel {
  order: number
  label: string
}

interface SeedTerritory {
  key: string
  level: number
  name: string
  code: string | null
  parent: string | null
  meta?: Record<string, unknown>
}

interface SeedDoc {
  source?: string
  state?: string
  levels: SeedLevel[]
  territories: SeedTerritory[]
}

const ORG_ID = process.env.ORG_ID?.trim()
if (!ORG_ID) {
  console.error('ORG_ID is required in .env.local (the organization to load territories into)')
  process.exit(1)
}

const seedArg = process.argv[2]?.trim()
const seedPath = seedArg
  ? path.resolve(process.cwd(), seedArg)
  : path.resolve(__dirname, '../data/territories/telangana.json')

if (!fs.existsSync(seedPath)) {
  console.error(`Seed file not found: ${seedPath}`)
  process.exit(1)
}

const doc = JSON.parse(fs.readFileSync(seedPath, 'utf8')) as SeedDoc
if (!Array.isArray(doc.territories) || !Array.isArray(doc.levels)) {
  console.error('Seed file is malformed: expected { levels: [], territories: [] }')
  process.exit(1)
}

async function main() {
  const supabase = createSupabaseServiceClient()

  // 1. Verify the org exists.
  const { data: org, error: orgErr } = await supabase
    .from('organizations')
    .select('id, name')
    .eq('id', ORG_ID)
    .maybeSingle()
  if (orgErr || !org) {
    console.error(`Organization ${ORG_ID} not found: ${orgErr?.message ?? 'no row'}`)
    process.exit(1)
  }
  console.log(`Importing "${doc.state ?? 'territories'}" into org "${org.name}" (${ORG_ID})`)
  console.log(`  source: ${doc.source ?? seedPath}`)

  // 2. Ensure a territory_level_definition exists for every level in the seed.
  const { data: existingLevels } = await supabase
    .from('territory_level_definitions')
    .select('id, level_order, label')
    .eq('organization_id', ORG_ID)

  const levelIdByOrder = new Map<number, string>()
  for (const lvl of existingLevels ?? []) {
    levelIdByOrder.set(Number(lvl.level_order), lvl.id as string)
  }

  for (const lvl of doc.levels.sort((a, b) => a.order - b.order)) {
    if (levelIdByOrder.has(lvl.order)) continue
    const { data: created, error } = await supabase
      .from('territory_level_definitions')
      .insert({ organization_id: ORG_ID, level_order: lvl.order, label: lvl.label })
      .select('id')
      .single()
    if (error || !created) {
      console.error(`Failed to create level ${lvl.order} (${lvl.label}): ${error?.message}`)
      process.exit(1)
    }
    levelIdByOrder.set(lvl.order, created.id as string)
    console.log(`  + level ${lvl.order}: ${lvl.label}`)
  }

  // 3. Load existing territories for this org, indexed by source_key, so the
  //    import is idempotent and we can resolve parent UUIDs.
  const { data: existingTerritories } = await supabase
    .from('territories')
    .select('id, name, code, parent_territory_id, metadata_json')
    .eq('organization_id', ORG_ID)

  const idBySourceKey = new Map<string, string>()
  for (const t of existingTerritories ?? []) {
    const meta = (t.metadata_json ?? {}) as { source_key?: string }
    if (meta.source_key) idBySourceKey.set(meta.source_key, t.id as string)
  }

  // 4. Insert/update territories in level order so parents exist first.
  const byLevel = [...doc.territories].sort((a, b) => a.level - b.level)
  let inserted = 0
  let updated = 0
  let skippedNoParent = 0

  for (const node of byLevel) {
    const levelId = levelIdByOrder.get(node.level)
    if (!levelId) {
      console.warn(`  ! ${node.key}: no level definition for level ${node.level} — skipping`)
      continue
    }

    let parentId: string | null = null
    if (node.parent) {
      parentId = idBySourceKey.get(node.parent) ?? null
      if (!parentId) {
        console.warn(`  ! ${node.key}: parent "${node.parent}" not found yet — skipping`)
        skippedNoParent++
        continue
      }
    }

    const metadata_json = {
      source_key: node.key,
      source: doc.source ?? 'territory-seed',
      ...(node.meta ?? {}),
    }

    const existingId = idBySourceKey.get(node.key)
    if (existingId) {
      const { error } = await supabase
        .from('territories')
        .update({
          name: node.name,
          code: node.code,
          level_definition_id: levelId,
          parent_territory_id: parentId,
          active: true,
          metadata_json,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existingId)
      if (error) {
        console.error(`  x update ${node.key}: ${error.message}`)
        process.exit(1)
      }
      updated++
      continue
    }

    const { data: created, error } = await supabase
      .from('territories')
      .insert({
        organization_id: ORG_ID,
        name: node.name,
        code: node.code,
        level_definition_id: levelId,
        parent_territory_id: parentId,
        active: true,
        metadata_json,
        updated_at: new Date().toISOString(),
      })
      .select('id')
      .single()
    if (error || !created) {
      console.error(`  x insert ${node.key}: ${error?.message}`)
      process.exit(1)
    }
    idBySourceKey.set(node.key, created.id as string)
    inserted++
  }

  invalidateTerritoryTreeCache(ORG_ID)
  const repaired = await repairTelanganaDistrictParents(ORG_ID)

  console.log(
    `\nDone. inserted=${inserted} updated=${updated} skipped(no parent)=${skippedNoParent} ` +
      `repaired_district_parents=${repaired} total=${doc.territories.length}`,
  )
  if (skippedNoParent > 0) {
    console.warn('Some nodes were skipped because their parent was missing. Re-run to retry.')
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
