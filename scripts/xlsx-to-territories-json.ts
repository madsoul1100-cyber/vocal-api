/**
 * Convert "vocal territory database.xlsx" → import-ready JSON for seed:territories.
 *
 * Usage:
 *   npm run convert:territories
 *   npm run convert:territories -- path/to/file.xlsx path/to/out.json
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import XLSX from 'xlsx'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

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
  source: string
  state: string
  levels: SeedLevel[]
  territories: SeedTerritory[]
}

const defaultXlsx = path.resolve(ROOT, 'vocal territory database.xlsx')
const defaultOut = path.resolve(ROOT, 'data/territories/telangana-full.json')

const xlsxPath = path.resolve(ROOT, process.argv[2]?.trim() || 'vocal territory database.xlsx')
const outPath = path.resolve(
  ROOT,
  process.argv[3]?.trim() || 'data/territories/telangana-full.json',
)

if (!fs.existsSync(xlsxPath)) {
  console.error(`Excel file not found: ${xlsxPath}`)
  console.error(`Place "vocal territory database.xlsx" in vocal-api/ or pass a path.`)
  process.exit(1)
}

const wb = XLSX.readFile(xlsxPath)

function rowsAsObjects<T extends Record<string, unknown>>(sheetName: string): T[] {
  const sheet = wb.Sheets[sheetName]
  if (!sheet) {
    console.error(`Sheet "${sheetName}" not found in workbook`)
    process.exit(1)
  }
  return XLSX.utils.sheet_to_json<T>(sheet)
}

function rowsAsArrays(sheetName: string): unknown[][] {
  const sheet = wb.Sheets[sheetName]
  if (!sheet) {
    console.error(`Sheet "${sheetName}" not found in workbook`)
    process.exit(1)
  }
  return XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '' })
}

const territories: SeedTerritory[] = []

// --- State (Telangana) ---
const states = rowsAsObjects<{
  state_id_PK: number
  lgd_state_code: string
  state_name: string
  state_type: string
  iso_3166_2: string
  capital: string
}>('01_states')

const tgState = states.find((s) => s.state_name === 'Telangana' || String(s.lgd_state_code) === '36')
if (!tgState) {
  console.error('Telangana not found in 01_states sheet')
  process.exit(1)
}

const stateKey = `S-${tgState.lgd_state_code}`
territories.push({
  key: stateKey,
  level: 1,
  name: tgState.state_name,
  code: String(tgState.lgd_state_code),
  parent: null,
  meta: {
    state_type: tgState.state_type,
    iso: tgState.iso_3166_2,
    capital: tgState.capital,
  },
})

// --- Districts ---
const districts = rowsAsObjects<{
  district_id_PK: string
  lgd_district_code: string
  district_name: string
  state_id_FK: number
  headquarters: string
  is_rural: boolean
  is_urban: boolean
}>('02_districts').filter((d) => d.state_id_FK === tgState.state_id_PK)

for (const d of districts) {
  territories.push({
    key: d.district_id_PK,
    level: 2,
    name: d.district_name,
    code: String(d.lgd_district_code),
    parent: stateKey,
    meta: {
      headquarters: d.headquarters,
      is_rural: d.is_rural,
      is_urban: d.is_urban,
    },
  })
}

// --- Mandals (03_subdistricts — positional; header row misaligned in workbook) ---
const subRows = rowsAsArrays('03_subdistricts').slice(1)
for (const row of subRows) {
  const [id, name, subType, districtFk, , stateFk] = row as [
    string,
    string,
    string,
    string,
    string,
    number,
  ]
  if (!id || typeof id !== 'string' || !id.startsWith('TG-SD-')) continue
  if (stateFk !== tgState.state_id_PK) continue
  territories.push({
    key: id,
    level: 3,
    name: String(name),
    code: null,
    parent: String(districtFk),
    meta: {
      kind: 'mandal',
      subdistrict_type: String(subType),
    },
  })
}

// --- Urban local bodies ---
const ulbs = rowsAsObjects<{
  ulb_id_PK: string
  lgd_ulb_code: string
  ulb_name: string
  ulb_type: string
  district_id_FK: string
  state_id_FK: number
}>('05_urban_local_bodies').filter((u) => u.state_id_FK === tgState.state_id_PK)

for (const u of ulbs) {
  territories.push({
    key: u.ulb_id_PK,
    level: 3,
    name: u.ulb_name,
    code: String(u.lgd_ulb_code),
    parent: u.district_id_FK,
    meta: {
      kind: 'urban_local_body',
      ulb_type: u.ulb_type,
    },
  })
}

// --- Wards (skip warning row) ---
const wardRows = rowsAsArrays('06_wards').slice(1)
for (const row of wardRows) {
  const [id, lgdCode, wardNum, wardName, ulbFk, , , stateFk] = row as [
    string,
    string,
    number | string,
    string,
    string,
    string,
    string,
    number,
  ]
  if (!id || typeof id !== 'string' || !id.includes('-W-')) continue
  if (stateFk !== tgState.state_id_PK) continue
  territories.push({
    key: id,
    level: 4,
    name: String(wardName),
    code: lgdCode ? String(lgdCode) : null,
    parent: String(ulbFk),
    meta: {
      ward_number: String(wardNum),
    },
  })
}

const doc: SeedDoc = {
  source: 'vocal territory database.xlsx',
  state: tgState.state_name,
  levels: [
    { order: 1, label: 'State' },
    { order: 2, label: 'District' },
    { order: 3, label: 'Mandal / Municipal Body' },
    { order: 4, label: 'Ward' },
  ],
  territories,
}

fs.mkdirSync(path.dirname(outPath), { recursive: true })
fs.writeFileSync(outPath, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')

const byLevel = [1, 2, 3, 4].map((lvl) => ({
  level: lvl,
  count: territories.filter((t) => t.level === lvl).length,
}))

console.log(`Wrote ${outPath}`)
console.log(`  territories: ${territories.length}`)
for (const { level, count } of byLevel) {
  console.log(`    level ${level}: ${count}`)
}
console.log('\nNext:')
console.log(`  ORG_ID=<your-org-uuid> npm run seed:territories -- ${path.relative(ROOT, outPath)}`)
