/**
 * Apply SQL migrations from supabase/migrations/ to DATABASE_URL (RDS / local Postgres).
 *
 * Usage:
 *   DATABASE_URL=postgresql://... npm run db:migrate
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import pg from 'pg'

dotenv.config()
dotenv.config({ path: '.env.local', override: true })

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const migrationsDir = path.resolve(__dirname, '../supabase/migrations')

async function main() {
  const url = process.env.DATABASE_URL?.trim()
  if (!url) {
    console.error('DATABASE_URL is required')
    process.exit(1)
  }

  const pool = new pg.Pool({
    connectionString: url,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  })

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `)

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()

  const { rows: applied } = await pool.query<{ filename: string }>(
    'SELECT filename FROM schema_migrations',
  )
  const done = new Set(applied.map((r) => r.filename))

  for (const file of files) {
    if (done.has(file)) {
      console.log(`skip ${file}`)
      continue
    }
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8')
    console.log(`apply ${file}...`)
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(sql)
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file])
      await client.query('COMMIT')
      console.log(`  ok ${file}`)
    } catch (err) {
      await client.query('ROLLBACK')
      console.error(`  failed ${file}:`, err)
      process.exit(1)
    } finally {
      client.release()
    }
  }

  await pool.end()
  console.log('Migrations complete.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
