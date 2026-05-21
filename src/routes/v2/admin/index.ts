import { Router } from 'express'
import intakeLabRouter from '@/routes/v2/admin/intakeLab.js'
import intakeSettingsRouter from '@/routes/v2/admin/intakeSettings.js'

const router = Router()

router.use('/intake-lab', intakeLabRouter)
router.use('/intake-settings', intakeSettingsRouter)

export default router
