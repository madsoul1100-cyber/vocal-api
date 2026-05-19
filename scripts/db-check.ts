/**
 * Quick connectivity check for DATABASE_URL.
 *   npm run db:check
 */
import dotenv from 'dotenv'
import pg from 'pg'

dotenv.config()
dotenv.config({ path: '.env.local', override: true })

async function main() {
  const url = process.env.DATABASE_URL?.trim()
  if (!url) throw new Error('DATABASE_URL is required')

  const pool = new pg.Pool({
    connectionString: url,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  })

  const res = await pool.query('SELECT current_database() AS db, version() AS version')
  console.log('Connected:', res.rows[0])
  await pool.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
