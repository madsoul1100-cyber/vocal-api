import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import { clerkMiddleware } from '@clerk/express'
import { describeDatabaseBackend } from '@/lib/db.js'
import { getClerkAuthorizedParties, isAllowedCorsOrigin } from '@/lib/corsOrigins.js'
import { isDevAuthBypassEnabled } from '@/lib/devAuth.js'
import webhooksRouter from '@/routes/webhooks/index.js'
import whatsappRouter from '@/routes/webhooks/whatsapp.js'
import v1Router from '@/routes/v1/index.js'
import v2Router from '@/routes/v2/index.js'
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

app.use('/webhooks/whatsapp', whatsappRouter)
app.use('/webhooks', express.json(), webhooksRouter)

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'vocal-api',
    auth: 'clerk',
    database: describeDatabaseBackend(),
    timestamp: new Date().toISOString(),
  })
})

app.use(express.json({ limit: '10mb' }))

const authorizedParties = getClerkAuthorizedParties()
const clerkApiMiddleware = clerkMiddleware({
  enableHandshake: false,
  authorizedParties,
})

function mountApiVersion(prefix: string, router: express.Router) {
  if (isDevAuthBypassEnabled()) {
    app.use(prefix, router)
  } else {
    app.use(prefix, clerkApiMiddleware, router)
  }
}

mountApiVersion('/v1', v1Router)
mountApiVersion('/v2', v2Router)

app.use(errorHandler)

export default app
