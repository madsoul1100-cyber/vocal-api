/**
 * Sets password_hash on staff users for backend JWT login.
 *
 * Usage (from vocal-api):
 *   npm run seed:passwords
 *
 * Default password: Vocal!Test2026 (same as Clerk seed script)
 *
 * Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, migration 007 applied
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'url'
import { createClient } from '@supabase/supabase-js'
import bcrypt from 'bcryptjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const envPaths = [
  path.join(root, '.env'),
  path.join(root, '.env.local'),
  path.resolve(root, '../vocal-app/.env.local'),
]
for (const p of envPaths) {
  if (!fs.existsSync(p)) continue
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
  }
}

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const PASSWORD = process.env.SEED_PASSWORD ?? 'Vocal!Test2026'

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
]

async function main() {
  if (!SUPABASE_URL || !KEY) throw new Error('Missing Supabase env')
  const hash = await bcrypt.hash(PASSWORD, 12)
  const supabase = createClient(SUPABASE_URL, KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  let ok = 0
  for (const email of TEST_EMAILS) {
    const { data, error } = await supabase
      .from('users')
      .update({ password_hash: hash })
      .eq('email', email.toLowerCase())
      .select('id, full_name, email')
      .maybeSingle()

    if (error) {
      console.error(`✗ ${email}:`, error.message)
      if (error.message.includes('password_hash')) {
        console.error('  → Run migration 007_user_password_auth.sql in Supabase first')
        process.exit(1)
      }
      continue
    }
    if (!data) {
      console.warn(`○ ${email}: no user row (run monolith seed:test-users first)`)
      continue
    }
    console.log(`✓ ${email}`)
    ok++
  }

  console.log(`\nDone. ${ok}/${TEST_EMAILS.length} users can sign in with password: ${PASSWORD}`)
  console.log('Login: POST http://localhost:3001/v1/auth/login')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
