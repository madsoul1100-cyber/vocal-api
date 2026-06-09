/**
 * Set up a fresh PostgreSQL database with the full Vocal schema.
 *
 * Usage:
 *   npm run db:setup              # apply schema.sql on empty DB
 *   npm run db:setup -- --migrate # apply incremental migrations instead
 *   npm run db:setup -- --sync    # mark all migrations applied (schema already exists)
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
const schemaPath = path.resolve(__dirname, '../supabase/schema.sql')

const APP_TABLES = [
  'organizations',
  'organization_settings',
  'organization_ticket_counters',
  'territory_level_definitions',
  'territories',
  'roles',
  'users',
  'user_territories',
  'worker_activation_requests',
  'staff_auth_otps',
  'citizens',
  'citizen_channel_identities',
  'channel_conversations',
  'channel_messages',
  'issue_categories',
  'tickets',
  'ticket_stage_history',
  'ticket_notes',
  'ticket_assignments',
  'ticket_attachments',
  'ai_ticket_suggestions',
  'directory_contacts',
  'directory_contact_territories',
  'directory_contact_tags',
  'amplify_sessions',
  'amplify_source_selections',
  'amplify_generated_outputs',
  'audit_logs',
]

function listMigrationFiles(): string[] {
  return fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
}

async function ensureMigrationsTable(pool: pg.Pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `)
}

async function recordMigrations(pool: pg.Pool, files: string[]) {
  for (const file of files) {
    await pool.query(
      `INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT (filename) DO NOTHING`,
      [file],
    )
  }
}

async function countAppTables(pool: pg.Pool): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM pg_tables
     WHERE schemaname = 'public'
       AND tablename = ANY($1::text[])`,
    [APP_TABLES],
  )
  return Number(rows[0]?.count ?? 0)
}

async function applySchemaSql(pool: pg.Pool) {
  if (!fs.existsSync(schemaPath)) {
    console.error('supabase/schema.sql not found. Run: npm run db:build-schema')
    process.exit(1)
  }
  const sql = fs.readFileSync(schemaPath, 'utf8')
  console.log('Applying supabase/schema.sql...')
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(sql)
    await client.query('COMMIT')
    console.log('Schema applied.')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

async function applyIncrementalMigrations(pool: pg.Pool) {
  const files = listMigrationFiles()
  await ensureMigrationsTable(pool)
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
}

async function main() {
  const url = process.env.DATABASE_URL?.trim()
  if (!url) {
    console.error('DATABASE_URL is required in .env.local')
    process.exit(1)
  }

  const modeMigrate = process.argv.includes('--migrate')
  const modeSync = process.argv.includes('--sync')

  const pool = new pg.Pool({
    connectionString: url,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  })

  const migrationFiles = listMigrationFiles()

  try {
    await ensureMigrationsTable(pool)
    const existingTables = await countAppTables(pool)

    if (modeSync) {
      console.log('Syncing schema_migrations (no SQL changes)...')
      await recordMigrations(pool, migrationFiles)
      console.log(`Recorded ${migrationFiles.length} migrations.`)
      return
    }

    if (modeMigrate) {
      console.log('Applying incremental migrations...')
      await applyIncrementalMigrations(pool)
      console.log('Migrations complete.')
      return
    }

    if (existingTables > 0) {
      console.error(
        `Database already has ${existingTables}/${APP_TABLES.length} app tables.`,
      )
      console.error('Options:')
      console.error('  npm run db:setup -- --migrate   # apply only pending migrations')
      console.error('  npm run db:setup -- --sync      # mark all migrations as applied')
      console.error('  npm run db:migrate              # same as --migrate')
      process.exit(1)
    }

    await applySchemaSql(pool)
    await recordMigrations(pool, migrationFiles)
    console.log(`Fresh database ready (${migrationFiles.length} migrations recorded).`)
  } finally {
    await pool.end()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
