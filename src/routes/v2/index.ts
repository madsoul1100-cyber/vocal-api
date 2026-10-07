import { Router } from 'express'
import authRouter from '@/routes/v2/auth.js'
import meRouter from '@/routes/v2/me.js'
import ticketsRouter from '@/routes/v2/tickets.js'
import workerRouter from '@/routes/v2/worker.js'
import directoryRouter from '@/routes/v2/directory.js'
import workersRouter from '@/routes/v2/workers.js'
import reportsRouter from '@/routes/v2/reports.js'
import dashboardRouter from '@/routes/v2/dashboard.js'
import amplifyRouter from '@/routes/v2/amplify.js'
import auditRouter from '@/routes/v2/audit.js'
import jobsRouter from '@/routes/v2/jobs.js'
import adminRouter from '@/routes/v2/admin/index.js'
import publicRouter from '@/routes/v2/public.js'
import bharosaRouter from '@/routes/v2/bharosa.js'

const router = Router()

router.use('/auth', authRouter)
router.use('/me', meRouter)
router.use('/tickets', ticketsRouter)
router.use('/worker', workerRouter)
router.use('/workers', workersRouter)
router.use('/directory', directoryRouter)
router.use('/reports', reportsRouter)
router.use('/dashboard', dashboardRouter)
router.use('/amplify', amplifyRouter)
router.use('/audit', auditRouter)
router.use('/jobs', jobsRouter)
router.use('/admin', adminRouter)
router.use('/public', publicRouter)
router.use('/bharosa', bharosaRouter)

export default router
