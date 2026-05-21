import './loadEnv.js'
import app from './app.js'
import { describeDatabaseBackend, isPostgresMode } from '@/lib/db.js'

const port = Number(process.env.PORT) || 3001

app.listen(port, () => {
  const db = describeDatabaseBackend()
  console.log(`vocal-api listening on http://localhost:${port}`)
  console.log(`  database: ${db}${isPostgresMode() ? ' (DATABASE_URL)' : ' (SUPABASE_URL — set DATABASE_URL on the server to use RDS)'}`)
  console.log(`  auth:     GET  http://localhost:${port}/v1/auth/me (Clerk Bearer token)`)
  console.log(`  health:   GET  http://localhost:${port}/health`)
  console.log(`  webhook: POST http://localhost:${port}/webhooks/telegram`)
  console.log(`  webhook: POST http://localhost:${port}/webhooks/whatsapp`)
  if (!process.env.CLERK_SECRET_KEY) {
    console.warn('  warn: CLERK_SECRET_KEY missing — POST /v1/workers cannot create Clerk users')
  }
})
