import './loadEnv.js'
import app from './app.js'
import { describeDatabaseBackend, isPostgresMode } from '@/lib/db.js'
import { isDevAuthBypassEnabled } from './lib/devAuth.js'
import { getOtpDeliveryStatus } from '@/lib/otp/delivery.js'

const port = Number(process.env.PORT) || 3001

app.listen(port, () => {
  const db = describeDatabaseBackend()
  console.log(`vocal-api listening on http://localhost:${port}`)
  console.log(
    `  database: ${db}${isPostgresMode() ? ' (DATABASE_URL)' : ' (SUPABASE_URL — set DATABASE_URL on the server to use RDS)'}`,
  )
  if (isDevAuthBypassEnabled()) {
    console.warn(
      '  warn: DEV auth bypass ON — /v1/* and /v2/* accept requests without JWT (NODE_ENV=development)',
    )
    console.log(`  auth:     POST http://localhost:${port}/v1/auth/login`)
    console.log(`  auth:     GET  http://localhost:${port}/v1/auth/me  (no token in dev)`)
  } else {
    console.log(`  auth:     POST http://localhost:${port}/v1/auth/login`)
    console.log(`  auth:     GET  http://localhost:${port}/v1/auth/me  (Bearer JWT)`)
  }
  console.log(`  api:      /v1/*  /v2/* (v2 copy of v1 — change responses in src/routes/v2/)`)
  console.log(`  health:   GET  http://localhost:${port}/health`)
  const otp = getOtpDeliveryStatus()
  console.log(
    `  otp:      mode=${otp.mode} | email=${otp.email.provider}(${otp.email.configured ? 'ok' : 'missing'}) | sms=${otp.sms.provider}(${otp.sms.configured ? 'ok' : 'missing'})`,
  )
  if (!process.env.JWT_SECRET && !isDevAuthBypassEnabled()) {
    console.warn('  warn: JWT_SECRET missing — login and protected routes will fail')
  }
})
