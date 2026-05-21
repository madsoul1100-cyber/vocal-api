import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import { clerkMiddleware } from '@clerk/express'
import { isDevAuthBypassEnabled } from '@/lib/devAuth.js'
import webhooksRouter from '@/routes/webhooks/index.js'
import v1Router from '@/routes/v1/index.js'
import { errorHandler } from '@/middleware/errorHandler.js'

const app = express()

app.use(helmet())
app.use(
  cors({
    origin: process.env.CORS_ORIGINS?.split(',').map((s) => s.trim()) ?? [
      'http://localhost:5173',
    ],
    credentials: true,
  }),
)

app.use('/webhooks', express.json(), webhooksRouter)

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'vocal-api',
    auth: isDevAuthBypassEnabled() ? 'dev-bypass' : 'clerk',
    timestamp: new Date().toISOString(),
  })
})

app.use(express.json({ limit: '10mb' }))

const authorizedParties = [
  'http://localhost:5173',
  'http://localhost:3000',
  ...(process.env.CORS_ORIGINS?.split(',').map((s) => s.trim()) ?? []),
].filter(Boolean)

if (isDevAuthBypassEnabled()) {
  app.use('/v1', v1Router)
} else {
  app.use(
    '/v1',
    clerkMiddleware({
      // API-only: do not run browser handshake on Bearer token requests
      enableHandshake: false,
      authorizedParties,
    }),
    v1Router,
  )
}

app.use(errorHandler)

export default app
