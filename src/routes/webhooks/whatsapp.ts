import express, { Router } from 'express'
import { createSupabaseServiceClient } from '@/lib/supabase.js'
import {
  parseWhatsAppUserId,
  twilioParamsFromBody,
  validateTwilioWebhook,
} from '@/lib/twilio.js'
import { upsertCitizenFromWhatsApp, getOrCreateConversation } from '@/services/citizenService.js'
import {
  handleInboundMessage,
  type IncomingMessage,
  type Step,
  type Draft,
  type DraftMedia,
} from '@/services/whatsappFlow.js'
import {
  handleInboundMessageAi,
  hydrateConversationMeta,
  isWhatsAppAiIntakeEnabled,
  type WhatsAppAiStep,
  type WhatsAppConversationMeta,
} from '@/services/whatsappAiFlow.js'

const router = Router()
router.use(express.urlencoded({ extended: false }))

const ORG_ID = process.env.ORG_ID!

type TwilioInbound = {
  MessageSid?: string
  From?: string
  To?: string
  Body?: string
  NumMedia?: string
  MediaUrl0?: string
  MediaContentType0?: string
  Latitude?: string
  Longitude?: string
  ProfileName?: string
}

function twilioMediaType(mime: string | undefined): DraftMedia['type'] {
  if (!mime) return 'document'
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'voice'
  return 'document'
}

function pickMedia(body: TwilioInbound): DraftMedia | null {
  const n = parseInt(body.NumMedia ?? '0', 10)
  if (n < 1 || !body.MediaUrl0) return null
  return {
    file_id: body.MediaUrl0,
    type: twilioMediaType(body.MediaContentType0),
    mime_type: body.MediaContentType0 ?? null,
    caption: body.Body ?? null,
    message_sid: body.MessageSid ?? null,
  }
}

function detectMessageType(
  body: TwilioInbound,
): 'text' | 'voice' | 'image' | 'video' | 'document' | 'location' {
  if (body.Latitude && body.Longitude) return 'location'
  const media = pickMedia(body)
  if (media) {
    if (media.type === 'voice') return 'voice'
    if (media.type === 'image') return 'image'
    if (media.type === 'video') return 'video'
    return 'document'
  }
  return 'text'
}

router.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'vocal-whatsapp-webhook',
    timestamp: new Date().toISOString(),
  })
})

router.post('/', async (req, res) => {
  const body = req.body as TwilioInbound
  const params = twilioParamsFromBody(body as Record<string, unknown>)
  const signature = req.headers['x-twilio-signature'] as string | undefined
  const proto = req.headers['x-forwarded-proto'] ?? req.protocol
  const host = req.headers['x-forwarded-host'] ?? req.get('host')
  const url = `${proto}://${host}${req.originalUrl}`

  if (!validateTwilioWebhook({ signature, url, params })) {
    res.status(403).send('Invalid signature')
    return
  }

  if (!body.From || !body.MessageSid) {
    res.type('text/xml').send('<Response></Response>')
    return
  }

  const supabase = createSupabaseServiceClient()
  const channelUserId = parseWhatsAppUserId(body.From)
  const rawText = body.Body?.trim() || null
  const messageType = detectMessageType(body)
  const media = pickMedia(body)

  try {
    const { citizenId } = await upsertCitizenFromWhatsApp(
      ORG_ID,
      channelUserId,
      body.ProfileName,
    )

    const { conversationId } = await getOrCreateConversation(
      ORG_ID,
      'whatsapp',
      channelUserId,
      citizenId,
    )

    const { data: conv } = await supabase
      .from('channel_conversations')
      .select('id, state, current_step, metadata_json')
      .eq('id', conversationId)
      .single()

    const useAi = isWhatsAppAiIntakeEnabled()
    const metaJson = hydrateConversationMeta(
      (conv?.metadata_json ?? {}) as WhatsAppConversationMeta & { draft?: Draft },
    )
    const currentStep: Step = (conv?.current_step as Step) || 'idle'
    const draft: Draft = metaJson.draft ?? {}

    const { data: dup } = await supabase
      .from('channel_messages')
      .select('id')
      .eq('channel', 'whatsapp')
      .eq('channel_message_id', body.MessageSid)
      .maybeSingle()

    if (!dup) {
      await supabase.from('channel_messages').insert({
        conversation_id: conversationId,
        organization_id: ORG_ID,
        channel: 'whatsapp',
        channel_message_id: body.MessageSid,
        direction: 'inbound',
        message_type: messageType,
        raw_text: rawText,
        raw_payload: body,
        attachment_url: media?.file_id ?? null,
        attachment_mime: media?.mime_type ?? null,
        latitude: body.Latitude ? parseFloat(body.Latitude) : null,
        longitude: body.Longitude ? parseFloat(body.Longitude) : null,
        processed: false,
      })
    }

    const incoming: IncomingMessage = {
      chat_id: channelUserId,
      message_id: body.MessageSid,
      text: rawText,
      media,
      location:
        body.Latitude && body.Longitude
          ? { latitude: parseFloat(body.Latitude), longitude: parseFloat(body.Longitude) }
          : null,
    }

    if (useAi) {
      const aiStep: WhatsAppAiStep =
        conv?.current_step === 'post_ticket' ? 'post_ticket' : 'ai_intake'
      await handleInboundMessageAi({
        supabase,
        organizationId: ORG_ID,
        conversationId,
        citizenId,
        currentStep: aiStep,
        meta: {
          history: metaJson.history ?? [],
          aiDraft: metaJson.aiDraft ?? {},
          draft: metaJson.draft ?? {},
          last_ticket_number: metaJson.last_ticket_number ?? null,
          ticketPickerOptions: metaJson.ticketPickerOptions ?? null,
          preferredLanguage: metaJson.preferredLanguage ?? null,
        },
        msg: incoming,
      })
    } else {
      await handleInboundMessage({
        supabase,
        organizationId: ORG_ID,
        conversationId,
        citizenId,
        currentStep,
        draft,
        msg: incoming,
      })
    }

    if (!dup) {
      await supabase
        .from('channel_messages')
        .update({ processed: true })
        .eq('channel', 'whatsapp')
        .eq('channel_message_id', body.MessageSid)
    }
  } catch (err) {
    console.error('[WhatsApp webhook error]', err)
    await supabase
      .from('audit_logs')
      .insert({
        organization_id: ORG_ID,
        event_type: 'webhook_error',
        actor_type: 'webhook',
        metadata_json: {
          error: err instanceof Error ? err.message : String(err),
          message_sid: body.MessageSid,
          from: body.From,
        },
      })
      .then(() => {}, () => {})
  }

  res.type('text/xml').send('<Response></Response>')
})

export default router
