/**
 * Sets password_hash on staff users for backend JWT login.
 *
 * Usage (from vocal-api):
 *   npm run seed:passwords
 *
 * Default password: Vocal!Test2026
 *
 * By default seeds every active user in ORG_ID that has an email.
 * Set SEED_EMAILS_ONLY=1 to use the fixed vocal-test-* list only.
 * Set SEED_ONLY_MISSING=1 to skip users who already have password_hash.
 *
 * Requires: DATABASE_URL (PostgreSQL/RDS), migration 007 applied
 */
import dotenv from 'dotenv'
import bcrypt from 'bcryptjs'
import pg from 'pg'

dotenv.config()
dotenv.config({ path: '.env.local', override: true })

const PASSWORD = process.env.SEED_PASSWORD ?? 'Vocal!Test2026'
const ORG_ID = process.env.ORG_ID?.trim()
const EMAILS_ONLY = process.env.SEED_EMAILS_ONLY === '1' || process.env.SEED_EMAILS_ONLY === 'true'
const ONLY_MISSING =
  process.env.SEED_ONLY_MISSING === '1' || process.env.SEED_ONLY_MISSING === 'true'

const TEST_EMAILS = [
  'vocal-test-super@example.com',
  'vocal-test-cs1@example.com',
  'vocal-test-cs2@example.com',
  'vocal-test-state@example.com',
  'vocal-test-district@example.com',
  'vocal-test-worker1@example.com',
  'vocal-test-worker2@example.com',
  'vocal-test-worker3@example.com',
  'vocal-test-media@example.com',
  'vocal-test-legal@example.com',
  'raja@dugoutlive.com',
  'anuragkartik7@gmail.com',
  'abhijit.sai09@gmail.com',
]

async function main() {
  const url = process.env.DATABASE_URL?.trim()
  if (!url) {
    throw new Error('DATABASE_URL is required in .env.local (PostgreSQL/RDS connection string)')
  }

  const hash = await bcrypt.hash(PASSWORD, 12)
  const pool = new pg.Pool({
    connectionString: url,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  })

  let targets: { id: string; email: string; full_name: string }[] = []

  try {
    if (EMAILS_ONLY || !ORG_ID) {
      if (!EMAILS_ONLY && !ORG_ID) {
        console.warn('ORG_ID not set — using fixed test email list only')
      }
      const res = await pool.query<{ id: string; email: string; full_name: string }>(
        `SELECT id, email, full_name FROM users
         WHERE LOWER(email) = ANY($1::text[])`,
        [TEST_EMAILS.map((e) => e.toLowerCase())],
      )
      targets = res.rows
      const found = new Set(targets.map((r) => r.email.toLowerCase()))
      for (const email of TEST_EMAILS) {
        if (!found.has(email.toLowerCase())) {
          console.warn(`○ ${email}: no user row`)
        }
      }
    } else {
      const res = await pool.query<{ id: string; email: string; full_name: string }>(
        `SELECT id, email, full_name FROM users
         WHERE organization_id = $1
           AND active = true
           AND email IS NOT NULL
           AND TRIM(email) <> ''
         ORDER BY email`,
        [ORG_ID],
      )
      targets = res.rows
      console.log(`Org ${ORG_ID}: ${targets.length} active user(s) with email`)
    }

    if (targets.length === 0) {
      console.warn('No users to update.')
      return
    }

    let ok = 0
    let skipped = 0

    for (const row of targets) {
      try {
        const res = await pool.query(
          `UPDATE users
           SET password_hash = $1, updated_at = NOW()
           WHERE id = $2
             ${ONLY_MISSING ? 'AND (password_hash IS NULL OR password_hash = \'\')' : ''}
           RETURNING id`,
          [hash, row.id],
        )

        if (res.rowCount === 0) {
          console.log(`○ ${row.email} (${row.full_name}): already has password`)
          skipped++
          continue
        }

        console.log(`✓ ${row.email} (${row.full_name})`)
        ok++
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`✗ ${row.email}:`, msg)
        if (msg.includes('password_hash')) {
          console.error('  → Run migration 007_user_password_auth.sql first')
          process.exit(1)
        }
      }
    }

    console.log(`\nDone. ${ok} updated, ${skipped} skipped, ${targets.length} total`)
    console.log(`Password: ${PASSWORD}`)
    console.log('Login: POST http://localhost:3001/v1/auth/login')
  } finally {
    await pool.end()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
