/**
 * Inspect directory_contact_tags for the org in ORG_ID.
 * Usage: npx tsx scripts/check-directory-categories.ts
 */
import dotenv from 'dotenv'
import pg from 'pg'

dotenv.config()
dotenv.config({ path: '.env.local', override: true })

async function main() {
  const orgId = process.env.ORG_ID?.trim()
  const url = process.env.DATABASE_URL?.trim()
  if (!orgId || !url) {
    throw new Error('ORG_ID and DATABASE_URL required in .env.local')
  }

  const pool = new pg.Pool({
    connectionString: url,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  })

  try {
    const q = (sql: string, params?: unknown[]) => pool.query(sql, params)

    const [{ rows: activeRows }] = await Promise.all([
      q(
        `SELECT COUNT(*)::int AS total FROM directory_contacts
         WHERE organization_id = $1 AND active = true`,
        [orgId],
      ),
    ])
    const activeContacts = activeRows[0]?.total ?? 0

    const tagCount = await q(
      `SELECT COUNT(*)::int AS total FROM directory_contact_tags dct
       JOIN directory_contacts dc ON dc.id = dct.contact_id
       WHERE dc.organization_id = $1 AND dc.active = true AND dct.tag_type = 'category'`,
      [orgId],
    )

    const distinct = await q(
      `SELECT dct.tag_value, COUNT(*)::int AS contacts
       FROM directory_contact_tags dct
       JOIN directory_contacts dc ON dc.id = dct.contact_id
       WHERE dc.organization_id = $1 AND dc.active = true AND dct.tag_type = 'category'
       GROUP BY dct.tag_value ORDER BY dct.tag_value`,
      [orgId],
    )

    const gov = await q(
      `SELECT COUNT(DISTINCT dc.id)::int AS contacts FROM directory_contacts dc
       WHERE dc.organization_id = $1 AND dc.active = true
         AND EXISTS (
           SELECT 1 FROM directory_contact_tags dct
           WHERE dct.contact_id = dc.id AND dct.tag_type = 'category'
             AND dct.tag_value ILIKE '%government%'
         )`,
      [orgId],
    )

    console.log('ORG_ID:', orgId)
    console.log('Active directory contacts:', activeContacts)
    console.log('Category tag rows:', tagCount.rows[0]?.total ?? 0)
    console.log('Matches category=government:', gov.rows[0]?.contacts ?? 0)
    console.log('\nDistinct categories:')
    if (distinct.rows.length === 0) {
      console.log('  (none — tags were never seeded)')
    } else {
      for (const row of distinct.rows) {
        console.log(`  ${row.tag_value}: ${row.contacts}`)
      }
    }
  } finally {
    await pool.end()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
