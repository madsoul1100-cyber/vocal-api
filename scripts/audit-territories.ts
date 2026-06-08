/**
 * Audit territory coverage for an org: counts by level, junk rows, districts without mandals.
 *
 * Usage:
 *   ORG_ID=<uuid> npm run audit:territories
 */
import '../src/loadEnv.js'
import { createSupabaseServiceClient } from '../src/lib/supabase.js'
import { loadOrgTerritoryRowsCached } from '../src/services/territoryService.js'

const ORG_ID = process.env.ORG_ID?.trim()
if (!ORG_ID) {
  console.error('ORG_ID is required')
  process.exit(1)
}

const JUNK_STATE_NAMES = new Set(
  ['demo state', 'uttar pradesh', 'hyderabad', 'hydrabad', 'hyerabad'].map((s) => s.toLowerCase()),
)

async function main() {
  const rows = await loadOrgTerritoryRowsCached(ORG_ID!)
  const byLevel = new Map<number, number>()
  for (const r of rows) {
    byLevel.set(r.level_order, (byLevel.get(r.level_order) ?? 0) + 1)
  }

  const telangana = rows.find(
    (r) => r.level_order === 1 && r.name.trim().toLowerCase() === 'telangana',
  )

  const childrenOf = new Map<string, string[]>()
  const rowById = new Map(rows.map((r) => [r.id, r]))
  for (const r of rows) {
    if (!r.parent_territory_id) continue
    const list = childrenOf.get(r.parent_territory_id) ?? []
    list.push(r.id)
    childrenOf.set(r.parent_territory_id, list)
  }

  function isUnderTelangana(id: string): boolean {
    if (!telangana) return false
    let cur: string | null = id
    const seen = new Set<string>()
    while (cur && !seen.has(cur)) {
      seen.add(cur)
      if (cur === telangana.id) return true
      cur = rowById.get(cur)?.parent_territory_id ?? null
    }
    return false
  }

  const junk: typeof rows = []
  for (const r of rows) {
    if (r.level_order === 1 && r.name.trim().toLowerCase() !== 'telangana') {
      junk.push(r)
      continue
    }
    if (r.level_order === 1 && JUNK_STATE_NAMES.has(r.name.trim().toLowerCase())) {
      junk.push(r)
      continue
    }
    if (telangana && r.level_order >= 2 && !isUnderTelangana(r.id)) {
      junk.push(r)
    }
  }

  const districts = rows.filter((r) => r.level_order === 2 && isUnderTelangana(r.id))
  const districtsWithoutMandals: string[] = []
  for (const d of districts) {
    const kids = (childrenOf.get(d.id) ?? [])
      .map((id) => rowById.get(id))
      .filter(Boolean)
    const hasMandalOrUlb = kids.some((k) => k!.level_order >= 3)
    if (!hasMandalOrUlb) districtsWithoutMandals.push(d.name)
  }

  const mandalCount = rows.filter((r) => r.level_order === 3 && isUnderTelangana(r.id)).length
  const wardCount = rows.filter((r) => r.level_order === 4 && isUnderTelangana(r.id)).length

  console.log('\n=== Territory audit ===')
  console.log(`Org: ${ORG_ID}`)
  console.log(`Total active territories: ${rows.length}`)
  console.log('By level:', Object.fromEntries([...byLevel.entries()].sort((a, b) => a[0] - b[0])))
  console.log(`Telangana state id: ${telangana?.id ?? '(missing)'}`)
  console.log(`Districts under Telangana: ${districts.length} (expected ~33)`)
  console.log(`Mandals / ULBs (level 3): ${mandalCount} (Telangana has ~589 mandals + ULBs in LGD)`)
  console.log(`Wards (level 4): ${wardCount} (GHMC alone has ~150 wards)`)
  console.log(`Districts with no child mandal/ULB: ${districtsWithoutMandals.length}`)
  if (districtsWithoutMandals.length > 0 && districtsWithoutMandals.length <= 40) {
    console.log('  ', districtsWithoutMandals.join(', '))
  }

  if (junk.length > 0) {
    console.log(`\nJunk / orphan rows (${junk.length}) — consider deactivating:`)
    for (const j of junk) {
      const parent = j.parent_territory_id ? rowById.get(j.parent_territory_id)?.name : '(root)'
      console.log(`  - ${j.name} [level ${j.level_order}] parent=${parent} id=${j.id}`)
    }
  }

  const supabase = createSupabaseServiceClient()
  const { count: workerTerritoryLinks } = await supabase
    .from('user_territories')
    .select('id', { count: 'exact', head: true })

  console.log(`\nWorker territory assignments (all orgs): ${workerTerritoryLinks ?? 0}`)
  console.log('\nRecommendations:')
  console.log('  1. Re-import full LGD mandal list into data/territories/telangana.json')
  console.log('  2. Add GHMC wards (parent TG-ULB-01) for Hyderabad routing')
  console.log('  3. npm run seed:territories — then deactivate junk rows listed above')
  console.log('  4. Assign workers to mandal/ward nodes in admin UI\n')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
