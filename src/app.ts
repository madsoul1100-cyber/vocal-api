import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import { clerkMiddleware } from '@clerk/express'
import { getClerkAuthorizedParties, isAllowedCorsOrigin } from '@/lib/corsOrigins.js'
import { isDevAuthBypassEnabled } from '@/lib/devAuth.js'
import webhooksRouter from '@/routes/webhooks/index.js'
import v1Router from '@/routes/v1/index.js'
import { errorHandler } from '@/middleware/errorHandler.js'

const app = express()

app.use(helmet())
app.use(
  cors({
    origin(origin, callback) {
      if (!origin) {
        callback(null, true)
        return
      }
      if (isAllowedCorsOrigin(origin)) {
        callback(null, origin)
        return
      }
      callback(new Error(`CORS: origin not allowed: ${origin}`))
    },
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

const authorizedParties = getClerkAuthorizedParties()

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
