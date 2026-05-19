import './loadEnv.js'
import app from './app.js'

const port = Number(process.env.PORT) || 3001

app.listen(port, () => {
  console.log(`vocal-api listening on http://localhost:${port}`)
  console.log(`  auth:     GET  http://localhost:${port}/v1/auth/me (Clerk Bearer token)`)
  console.log(`  health:   GET  http://localhost:${port}/health`)
  console.log(`  webhook: POST http://localhost:${port}/webhooks/telegram`)
  if (!process.env.CLERK_SECRET_KEY) {
    console.warn('  warn: CLERK_SECRET_KEY missing — POST /v1/workers cannot create Clerk users')
  }
})
