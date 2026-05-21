/**
 * Assign category tags to existing directory_contacts (tag_type = 'category').
 *
 * Usage:
 *   npm run seed:directory-categories
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (or DATABASE_URL) and ORG_ID in .env.local
 */
import '../src/loadEnv.js'
import { createSupabaseServiceClient } from '../src/lib/supabase.js'

const ORG_ID = process.env.ORG_ID?.trim()
if (!ORG_ID) {
  console.error('ORG_ID is required in .env.local')
  process.exit(1)
}

type ContactRow = {
  id: string
  contact_name: string
  organization_name: string | null
  role_designation: string | null
  availability_notes: string | null
  internal_notes: string | null
}

/** Infer one or more category tag_values from contact text. */
export function inferDirectoryCategories(c: ContactRow): string[] {
  const text = [
    c.contact_name,
    c.organization_name,
    c.role_designation,
    c.availability_notes,
    c.internal_notes,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()

  const cats = new Set<string>()

  const add = (cat: string) => cats.add(cat)

  if (/\b(ambulance|emergency|108|112|fire|rescue)\b/.test(text)) add('emergency')
  if (/\bpolice\b/.test(text)) add('law_enforcement')
  if (
    /\b(health|aarogya|hospital|medical|maternal|nutrition|asha|arogyasri)\b|health van/.test(text)
  ) {
    add('health')
  }
  if (/\b(power|electric|epdcl|spdcl|npdcl)\b|power distribution|billing/.test(text)) add('utilities')
  if (/\b(water|hmwssb|sewerage)\b|water supply|water resources/.test(text)) add('utilities')
  if (/\b(bus|rtc|transport)\b|road transport/.test(text)) add('transport')
  if (/\b(municipal|ghmc|gvmc|vmc|civic|garbage|drainage|sanitation)\b|street light/.test(text)) {
    add('civic')
  }
  if (
    /chief minister|cm's|cm helpline|spandana|secretariat|grievance|mee seva|e-gov|e-government|general enquiry|government of/.test(
      text,
    )
  ) {
    add('government')
  }
  if (
    /\b(tribal|welfare|women|childline|senior citizen|elder|farmer|kisan|dalit|scholarship|girijan)\b|child protection|sc\/st/.test(
      text,
    )
  ) {
    add('welfare')
  }
  if (/\b(legal|nalsa)\b/.test(text)) add('legal')
  if (/\b(disaster|flood|cyclone|tsdma|apsdma)\b|natural disaster/.test(text)) add('disaster')
  if (/\b(pds|ration)\b|civil supplies|food distribution|ration card/.test(text)) {
    add('food_ration')
  }
  if (
    /\b(panchayat|rural|nrega|dharani|revenue|mutation|pattadar)\b|land record|gram panchayat/.test(text)
  ) {
    add('rural')
  }
  if (/corruption|anti-corruption|\bacb\b/.test(text)) add('corruption')
  if (/\bcyber\b/.test(text)) add('cybercrime')
  if (/\b(ngo|activist)\b/.test(text)) add('ngo')
  if (/\b(agricultur|farmer|kisan)\b/.test(text)) add('agriculture')

  if (cats.size === 0) add('government')

  return [...cats].sort()
}

async function main() {
  const supabase = createSupabaseServiceClient()

  const { data: contacts, error: listErr } = await supabase
    .from('directory_contacts')
    .select('id, contact_name, organization_name, role_designation, availability_notes, internal_notes')
    .eq('organization_id', ORG_ID)
    .eq('active', true)
    .order('contact_name')

  if (listErr || !contacts?.length) {
    console.error('Failed to load contacts:', listErr?.message ?? 'none found')
    process.exit(1)
  }

  const contactIds = contacts.map((c) => c.id as string)

  const { error: delErr } = await supabase
    .from('directory_contact_tags')
    .delete()
    .eq('tag_type', 'category')
    .in('contact_id', contactIds)

  if (delErr) {
    console.error('Failed to clear old category tags:', delErr.message)
    process.exit(1)
  }

  const rows: { contact_id: string; tag_type: 'category'; tag_value: string }[] = []
  const summary = new Map<string, number>()

  for (const contact of contacts as ContactRow[]) {
    const categories = inferDirectoryCategories(contact)
    for (const tag_value of categories) {
      rows.push({ contact_id: contact.id, tag_type: 'category', tag_value })
      summary.set(tag_value, (summary.get(tag_value) ?? 0) + 1)
    }
    console.log(`  ${contact.contact_name.slice(0, 50)} → ${categories.join(', ')}`)
  }

  const { error: insErr } = await supabase.from('directory_contact_tags').insert(rows)
  if (insErr) {
    console.error('Insert failed:', insErr.message)
    process.exit(1)
  }

  console.log(`\nTagged ${contacts.length} contacts with ${rows.length} category tags:`)
  for (const [cat, n] of [...summary.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`  ${cat}: ${n}`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
