/**
 * Build supabase/schema.sql from all numbered migration files.
 * Run after adding new migrations: npm run db:build-schema
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const migrationsDir = path.resolve(__dirname, '../supabase/migrations')
const outPath = path.resolve(__dirname, '../supabase/schema.sql')

const files = fs
  .readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort()

const parts = [
  `-- =============================================================================
-- Vocal - Full database schema (auto-generated)
-- Generated: ${new Date().toISOString()}
-- Source: supabase/migrations/*.sql (${files.length} files)
--
-- Run this ENTIRE file in one go (pgAdmin Query Tool → Execute/▶).
-- Do NOT run migration files one by one.
-- =============================================================================

-- Required on plain Postgres (RDS / pgAdmin). Supabase provides this natively.
create schema if not exists auth;

create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;
`,
]

for (const file of files) {
  const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8').trim()
  parts.push(`\n-- >>> ${file}\n\n${sql}\n`)
}

fs.writeFileSync(outPath, parts.join('\n'))
console.log(`Wrote ${outPath} (${files.length} migrations)`)
