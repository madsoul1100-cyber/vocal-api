import { Router } from 'express'
import {
  answerWorkerCallbackQuery,
  clearWorkerInlineKeyboard,
  sendWorkerMessage,
  WORKER_WEBHOOK_SECRET,
} from '@/services/workerTelegramService.js'
import {
  linkWorkerTelegram,
  workerAcceptViaBot,
  workerRejectViaBot,
} from '@/services/workerNotifier.js'

const router = Router()

type TelegramMessage = {
  message_id: number
  from?: { id: number; username?: string; first_name?: string; last_name?: string }
  chat: { id: number; type: string }
  date: number
  text?: string
}

type TelegramCallbackQuery = {
  id: string
  from: { id: number; username?: string; first_name?: string; last_name?: string }
  message?: TelegramMessage
  data?: string
}

type TelegramUpdate = {
  update_id: number
  message?: TelegramMessage
  callback_query?: TelegramCallbackQuery
}

router.get('/', (_req, res) => {
  res.json({ ok: true, service: 'my-leader-worker-webhook' })
})

router.post('/', async (req, res) => {
  const secret = req.headers['x-telegram-bot-api-secret-token']
  if (WORKER_WEBHOOK_SECRET && secret !== WORKER_WEBHOOK_SECRET) {
    res.status(403).json({ error: 'Invalid secret' })
    return
  }

  const update = req.body as TelegramUpdate
  if (!update || typeof update !== 'object') {
    res.status(400).json({ error: 'Invalid JSON' })
    return
  }

  try {
    if (update.callback_query) {
      const cb = update.callback_query
      const data = cb.data ?? ''

      void answerWorkerCallbackQuery(cb.id)
      if (cb.message) {
        void clearWorkerInlineKeyboard(cb.message.chat.id, cb.message.message_id)
      }

      const chatId = cb.message?.chat.id ?? cb.from.id
      const colonIdx = data.indexOf(':')
      const prefix = colonIdx >= 0 ? data.slice(0, colonIdx) : data
      const ticketId = colonIdx >= 0 ? data.slice(colonIdx + 1) : ''

      if (prefix === 'waccept' && ticketId) {
        await workerAcceptViaBot(ticketId, chatId)
      } else if (prefix === 'wreject' && ticketId) {
        await workerRejectViaBot(ticketId, chatId)
      } else if (prefix === 'wupdate' && ticketId) {
        await sendWorkerMessage(
          chatId,
          `📝 Open the *My Leader* app → My Assignments to update your ticket status.\n\nTicket ref: \`${ticketId.slice(0, 8)}…\``,
        )
      }

      res.json({ ok: true })
      return
    }

    const msg = update.message
    if (!msg?.from) {
      res.json({ ok: true })
      return
    }

    const chatId = msg.chat.id
    const text = msg.text ?? ''

    if (text.startsWith('/start link_')) {
      const workerId = text.replace('/start link_', '').trim()
      if (workerId) {
        await linkWorkerTelegram(workerId, chatId)
      } else {
        await sendWorkerMessage(
          chatId,
          '⚠️ Invalid linking code. Open the *My Leader* app → My Assignments to get your link.',
        )
      }
      res.json({ ok: true })
      return
    }

    if (text === '/start') {
      await sendWorkerMessage(
        chatId,
        `👋 *My Leader — Worker Bot*\n\nThis bot is for My Leader team members only.\n\nTo link your account, go to *My Assignments* in the app and tap *Link Telegram*.`,
      )
      res.json({ ok: true })
      return
    }

    await sendWorkerMessage(
      chatId,
      `ℹ️ Use the *My Leader* app to manage your assignments. This bot sends you alerts and reminders only.`,
    )
  } catch (err) {
    console.error('[Worker webhook error]', err)
  }

  res.json({ ok: true })
})

export default router
