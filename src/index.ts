import './loadEnv.js'
import app from './app.js'
import { describeDatabaseBackend, isPostgresMode } from '@/lib/db.js'
import { isDevAuthBypassEnabled } from './lib/devAuth.js'

const port = Number(process.env.PORT) || 3001

app.listen(port, () => {
  const db = describeDatabaseBackend()
  console.log(`vocal-api listening on http://localhost:${port}`)
  console.log(`  database: ${db}${isPostgresMode() ? ' (DATABASE_URL)' : ' (SUPABASE_URL — set DATABASE_URL on the server to use RDS)'}`)
  console.log(`  auth:     GET  http://localhost:${port}/v1/auth/me (Clerk Bearer token)`)
  if (isDevAuthBypassEnabled()) {
    console.warn(
      '  warn: DEV auth bypass ON — /v1/* and /v2/* do not require Clerk (NODE_ENV=development)',
    )
    console.log(`  auth:     GET  http://localhost:${port}/v1/auth/me  |  /v2/auth/me (no token)`)
  } else {
    console.log(
      `  auth:     GET  http://localhost:${port}/v1/auth/me  |  /v2/auth/me (Clerk Bearer token)`,
    )
  }
  console.log(`  api:      /v1/*  /v2/* (v2 copy of v1 — change responses in src/routes/v2/)`)
  console.log(`  health:   GET  http://localhost:${port}/health`)
  console.log(`  webhook: POST http://localhost:${port}/webhooks/telegram`)
  if (!process.env.CLERK_SECRET_KEY && !isDevAuthBypassEnabled()) {
    console.warn('  warn: CLERK_SECRET_KEY missing — POST /v1/workers cannot create Clerk users')
  }
})
