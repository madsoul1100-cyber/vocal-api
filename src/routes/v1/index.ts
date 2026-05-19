import { Router } from 'express'
import authRouter from '@/routes/v1/auth.js'
import meRouter from '@/routes/v1/me.js'
import ticketsRouter from '@/routes/v1/tickets.js'
import workerRouter from '@/routes/v1/worker.js'
import directoryRouter from '@/routes/v1/directory.js'
import workersRouter from '@/routes/v1/workers.js'
import reportsRouter from '@/routes/v1/reports.js'
import amplifyRouter from '@/routes/v1/amplify.js'
import auditRouter from '@/routes/v1/audit.js'
import jobsRouter from '@/routes/v1/jobs.js'
import adminRouter from '@/routes/v1/admin/index.js'

const router = Router()

router.use('/auth', authRouter)
router.use('/me', meRouter)
router.use('/tickets', ticketsRouter)
router.use('/worker', workerRouter)
router.use('/workers', workersRouter)
router.use('/directory', directoryRouter)
router.use('/reports', reportsRouter)
router.use('/amplify', amplifyRouter)
router.use('/audit', auditRouter)
router.use('/jobs', jobsRouter)
router.use('/admin', adminRouter)

export default router
