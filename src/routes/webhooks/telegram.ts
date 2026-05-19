import { Router } from 'express'
import { createSupabaseServiceClient } from '@/lib/supabase.js'
import { upsertCitizenFromTelegram, getOrCreateConversation } from '@/services/citizenService.js'
import {
  handleInboundMessage,
  type IncomingMessage,
  type Step,
  type Draft,
} from '@/services/telegramFlow.js'
import {
  answerCallbackQuery,
  clearInlineKeyboard,
  callbackToSyntheticText,
} from '@/services/telegramService.js'

const router = Router()

const ORG_ID = process.env.ORG_ID!
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET ?? ''

type TelegramMessage = {
  message_id: number
  from?: {
    id: number
    username?: string
    first_name?: string
    last_name?: string
    phone_number?: string
  }
  chat: { id: number; type: string }
  date: number
  text?: string
  voice?: { file_id: string; duration: number; mime_type?: string; file_size?: number }
  photo?: Array<{ file_id: string; width: number; height: number; file_size?: number }>
  video?: { file_id: string; duration: number; mime_type?: string; file_size?: number }
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number }
  location?: { latitude: number; longitude: number }
  caption?: string
}

type TelegramCallbackQuery = {
  id: string
  from: {
    id: number
    username?: string
    first_name?: string
    last_name?: string
  }
  message?: TelegramMessage
  data?: string
}

type TelegramUpdate = {
  update_id: number
  message?: TelegramMessage
  edited_message?: TelegramMessage
  callback_query?: TelegramCallbackQuery
}

function detectMessageType(
  msg: TelegramMessage,
): 'text' | 'voice' | 'image' | 'video' | 'document' | 'location' {
  if (msg.voice) return 'voice'
  if (msg.photo) return 'image'
  if (msg.video) return 'video'
  if (msg.document) return 'document'
  if (msg.location) return 'location'
  return 'text'
}

function pickMedia(msg: TelegramMessage): IncomingMessage['media'] {
  if (msg.voice) {
    return {
      file_id: msg.voice.file_id,
      type: 'voice',
      mime_type: msg.voice.mime_type ?? null,
      caption: msg.caption ?? null,
    }
  }
  if (msg.photo && msg.photo.length) {
    return {
      file_id: msg.photo[msg.photo.length - 1].file_id,
      type: 'image',
      mime_type: 'image/jpeg',
      caption: msg.caption ?? null,
    }
  }
  if (msg.video) {
    return {
      file_id: msg.video.file_id,
      type: 'video',
      mime_type: msg.video.mime_type ?? null,
      caption: msg.caption ?? null,
    }
  }
  if (msg.document) {
    return {
      file_id: msg.document.file_id,
      type: 'document',
      mime_type: msg.document.mime_type ?? null,
      caption: msg.caption ?? null,
    }
  }
  return null
}

router.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'vocal-telegram-webhook',
    timestamp: new Date().toISOString(),
  })
})

router.post('/', async (req, res) => {
  const secretHeader = req.headers['x-telegram-bot-api-secret-token']
  if (WEBHOOK_SECRET && secretHeader !== WEBHOOK_SECRET) {
    res.status(403).json({ error: 'Invalid secret' })
    return
  }

  const update = req.body as TelegramUpdate
  if (!update || typeof update !== 'object') {
    res.status(400).json({ error: 'Invalid JSON' })
    return
  }

  let msg: TelegramMessage | undefined = update.message ?? update.edited_message
  let callbackMessageIdOverride: string | null = null

  if (!msg && update.callback_query) {
    const cb = update.callback_query
    const syntheticText = cb.data ? callbackToSyntheticText(cb.data) : null
    void answerCallbackQuery(cb.id)
    if (cb.message) void clearInlineKeyboard(cb.message.chat.id, cb.message.message_id)
    if (!syntheticText || !cb.message || !cb.from) {
      res.json({ ok: true })
      return
    }
    msg = {
      message_id: cb.message.message_id,
      from: cb.from,
      chat: cb.message.chat,
      date: cb.message.date,
      text: syntheticText,
    }
    callbackMessageIdOverride = `cb:${cb.id}`
  }

  if (!msg?.from) {
    res.json({ ok: true })
    return
  }

  const supabase = createSupabaseServiceClient()
  const telegramUserId = String(msg.from.id)
  const messageType = detectMessageType(msg)
  const rawText = msg.text ?? msg.caption ?? null

  try {
    const displayName =
      [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ') || undefined
    const { citizenId } = await upsertCitizenFromTelegram(
      ORG_ID,
      telegramUserId,
      msg.from.username,
      displayName,
      msg.from.phone_number,
    )

    const { conversationId } = await getOrCreateConversation(
      ORG_ID,
      'telegram',
      telegramUserId,
      citizenId,
    )

    const { data: conv } = await supabase
      .from('channel_conversations')
      .select('id, state, current_step, metadata_json')
      .eq('id', conversationId)
      .single()

    const currentStep: Step = (conv?.current_step as Step) || 'idle'
    const draft: Draft =
      (conv?.metadata_json as { draft?: Draft } | null)?.draft ?? {}

    await supabase.from('channel_messages').insert({
      conversation_id: conversationId,
      organization_id: ORG_ID,
      channel: 'telegram',
      channel_message_id: callbackMessageIdOverride ?? String(msg.message_id),
      direction: 'inbound',
      message_type: messageType,
      raw_text: rawText,
      raw_payload: update,
      attachment_url: pickMedia(msg)?.file_id ?? null,
      attachment_mime: pickMedia(msg)?.mime_type ?? null,
      latitude: msg.location?.latitude ?? null,
      longitude: msg.location?.longitude ?? null,
      processed: false,
    })

    const incoming: IncomingMessage = {
      chat_id: msg.chat.id,
      message_id: msg.message_id,
      text: rawText,
      media: pickMedia(msg),
      location: msg.location ?? null,
    }

    await handleInboundMessage({
      supabase,
      organizationId: ORG_ID,
      conversationId,
      citizenId,
      currentStep,
      draft,
      msg: incoming,
    })
  } catch (err) {
    console.error('[Telegram webhook error]', err)
    await supabase
      .from('audit_logs')
      .insert({
        organization_id: ORG_ID,
        event_type: 'webhook_error',
        actor_type: 'webhook',
        metadata_json: {
          error: err instanceof Error ? err.message : String(err),
          update_id: update.update_id,
          telegram_user_id: msg.from?.id,
        },
      })
      .then(
        () => {},
        () => {},
      )
  }

  res.json({ ok: true })
})

export default router
