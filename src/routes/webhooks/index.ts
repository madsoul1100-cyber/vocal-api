import { Router } from 'express'
import telegramRouter from '@/routes/webhooks/telegram.js'
import telegramWorkerRouter from '@/routes/webhooks/telegram-worker.js'

const router = Router()

router.use('/telegram', telegramRouter)
router.use('/telegram-worker', telegramWorkerRouter)

export default router
