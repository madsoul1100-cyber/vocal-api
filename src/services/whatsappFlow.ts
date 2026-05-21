/**
 * WhatsApp (Twilio) conversation state machine — mirrors telegramFlow.ts.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  BOT,
  sendWhatsAppMessage,
  citizenStageLabel,
  words,
  extractTicketNumber,
  isCommand,
  normalize,
  menuDigitToAction,
} from './whatsappService.js'
import { classifyIntent } from './aiService.js'
import { createTicket } from './ticketService.js'
import { generateTicketSuggestions } from './aiService.js'
import { findNearestAvailableWorker, offerTicketToWorker } from './assignmentService.js'
import { downloadFromTwilioAndStore } from './attachmentService.js'

export type Step =
  | 'idle'
  | 'collecting_issue'
  | 'collecting_media'
  | 'collecting_location'
  | 'confirming'
  | 'editing'
  | 'post_ticket'

export interface DraftMedia {
  /** Twilio MediaUrl for download, or message sid for fallback pointer */
  file_id: string
  type: 'image' | 'video' | 'document' | 'voice'
  mime_type?: string | null
  caption?: string | null
  message_sid?: string | null
}

export interface Draft {
  issue_text?: string | null
  media?: DraftMedia[]
  location_text?: string | null
  latitude?: number | null
  longitude?: number | null
  intent?: 'report_issue' | null
}

export interface IncomingMessage {
  chat_id: string
  message_id: string
  text: string | null
  media?: DraftMedia | null
  location?: { latitude: number; longitude: number } | null
}

export interface FlowContext {
  supabase: SupabaseClient
  organizationId: string
  conversationId: string
  citizenId: string
  currentStep: Step
  draft: Draft
  msg: IncomingMessage
}

function applyMenuShortcut(text: string): string {
  const action = menuDigitToAction(text)
  if (action === 'report') return 'report'
  if (action === 'status') return 'status'
  if (action === 'help') return 'help'
  return text
}

export async function handleInboundMessage(ctx: FlowContext): Promise<void> {
  let text = ctx.msg.text ?? ''
  text = applyMenuShortcut(text)

  if (isCommand(text, '/start') || words.isStart(text)) return doStart(ctx)
  if (isCommand(text, '/help') || words.isHelp(text)) return doHelp(ctx)
  if (isCommand(text, '/cancel') || words.isNo(text)) return doCancel(ctx)
  if (isCommand(text, '/status') || words.isStatus(text)) return doStatusCommand(ctx, text)

  switch (ctx.currentStep) {
    case 'idle': return handleIdle(ctx, text)
    case 'collecting_issue': return handleCollectingIssue(ctx)
    case 'collecting_media': return handleCollectingMedia(ctx)
    case 'collecting_location': return handleCollectingLocation(ctx)
    case 'confirming': return handleConfirming(ctx)
    case 'editing': return handleEditing(ctx)
    case 'post_ticket': return handlePostTicket(ctx, text)
    default: return handleIdle(ctx, text)
  }
}

async function doStart(ctx: FlowContext) {
  await resetConversation(ctx, 'idle')
  await sendWhatsAppMessage(ctx.msg.chat_id, BOT.welcome())
}

async function doHelp(ctx: FlowContext) {
  await sendWhatsAppMessage(ctx.msg.chat_id, BOT.help())
}

async function doCancel(ctx: FlowContext) {
  await resetConversation(ctx, 'idle')
  await sendWhatsAppMessage(ctx.msg.chat_id, BOT.cancelled())
}

async function doStatusCommand(ctx: FlowContext, text: string) {
  await replyStatus(ctx, extractTicketNumber(text))
}

async function handleIdle(ctx: FlowContext, text: string) {
  if (words.isReport(text)) return startIntake(ctx)
  if (words.isStatus(text)) return replyStatus(ctx, extractTicketNumber(text))

  if (!text && (ctx.msg.media || ctx.msg.location)) {
    await sendWhatsAppMessage(ctx.msg.chat_id, BOT.welcome())
    return
  }

  if (!text) {
    await sendWhatsAppMessage(ctx.msg.chat_id, BOT.welcome())
    return
  }

  const { intent, ticket_number } = await classifyIntent(text)
  switch (intent) {
    case 'greeting':
      return sendWhatsAppMessage(ctx.msg.chat_id, BOT.welcome())
    case 'info_query':
      return sendWhatsAppMessage(ctx.msg.chat_id, BOT.help())
    case 'status_check':
      return replyStatus(ctx, ticket_number)
    case 'report_issue':
      return startIntake(ctx)
    default:
      return sendWhatsAppMessage(ctx.msg.chat_id, BOT.unclear())
  }
}

async function startIntake(ctx: FlowContext) {
  await setStep(ctx, 'collecting_issue', { intent: 'report_issue', media: [] })
  await sendWhatsAppMessage(ctx.msg.chat_id, BOT.startIssue())
}

async function handleCollectingIssue(ctx: FlowContext) {
  const text = (ctx.msg.text ?? '').trim()

  if (ctx.msg.media && !text) {
    const draft = mergeDraft(ctx.draft, { media: [...(ctx.draft.media ?? []), ctx.msg.media] })
    await setStep(ctx, 'collecting_issue', draft)
    await sendWhatsAppMessage(
      ctx.msg.chat_id,
      'Got the attachment. Now please describe the issue in a message. Reply cancel to stop.',
    )
    return
  }

  if (!text) {
    await sendWhatsAppMessage(ctx.msg.chat_id, BOT.startIssue())
    return
  }

  if (text.length < 4) {
    await sendWhatsAppMessage(ctx.msg.chat_id, "A bit more detail please — what's happening, and where?")
    return
  }

  const draft = mergeDraft(ctx.draft, { issue_text: text.slice(0, 4000) })
  await setStep(ctx, 'collecting_media', draft)
  await sendWhatsAppMessage(ctx.msg.chat_id, BOT.askMedia())
}

async function handleCollectingMedia(ctx: FlowContext) {
  const text = (ctx.msg.text ?? '').trim()

  if (ctx.msg.media) {
    const media = [...(ctx.draft.media ?? []), ctx.msg.media]
    const draft = mergeDraft(ctx.draft, { media })
    await setStep(ctx, 'collecting_media', draft)
    await sendWhatsAppMessage(ctx.msg.chat_id, BOT.mediaAdded(media.length))
    return
  }

  if (words.isDone(text) || words.isSkip(text) || words.isYes(text)) {
    await setStep(ctx, 'collecting_location', ctx.draft)
    await sendWhatsAppMessage(ctx.msg.chat_id, BOT.askLocation())
    return
  }

  await sendWhatsAppMessage(ctx.msg.chat_id, BOT.askMedia())
}

async function handleCollectingLocation(ctx: FlowContext) {
  const text = (ctx.msg.text ?? '').trim()

  if (ctx.msg.location) {
    const draft = mergeDraft(ctx.draft, {
      latitude: ctx.msg.location.latitude,
      longitude: ctx.msg.location.longitude,
      location_text: `${ctx.msg.location.latitude.toFixed(5)}, ${ctx.msg.location.longitude.toFixed(5)}`,
    })
    await setStep(ctx, 'confirming', draft)
    await sendSummary(ctx, draft)
    return
  }

  if (text && !words.isSkip(text)) {
    const draft = mergeDraft(ctx.draft, { location_text: text.slice(0, 500) })
    await setStep(ctx, 'confirming', draft)
    await sendSummary(ctx, draft)
    return
  }

  if (words.isSkip(text)) {
    const draft = mergeDraft(ctx.draft, { location_text: '(not provided)' })
    await setStep(ctx, 'confirming', draft)
    await sendSummary(ctx, draft)
    return
  }

  await sendWhatsAppMessage(ctx.msg.chat_id, BOT.locationNeedsText())
}

async function handleConfirming(ctx: FlowContext) {
  const text = (ctx.msg.text ?? '').trim()

  if (words.isYes(text)) return fileTicket(ctx)
  if (words.isEdit(text)) {
    await setStep(ctx, 'editing', ctx.draft)
    await sendWhatsAppMessage(ctx.msg.chat_id, BOT.editMenu())
    return
  }
  await sendSummary(ctx, ctx.draft)
}

async function handleEditing(ctx: FlowContext) {
  const text = normalize(ctx.msg.text ?? '')

  if (text === '1' || text.includes('issue') || text.includes('description')) {
    await setStep(ctx, 'collecting_issue', { ...ctx.draft, issue_text: null })
    await sendWhatsAppMessage(ctx.msg.chat_id, BOT.startIssue())
    return
  }
  if (text === '2' || text.includes('attach') || text.includes('media') || text.includes('photo')) {
    await setStep(ctx, 'collecting_media', { ...ctx.draft, media: [] })
    await sendWhatsAppMessage(ctx.msg.chat_id, BOT.askMedia())
    return
  }
  if (text === '3' || text.includes('location') || text.includes('address')) {
    await setStep(ctx, 'collecting_location', {
      ...ctx.draft,
      latitude: null,
      longitude: null,
      location_text: null,
    })
    await sendWhatsAppMessage(ctx.msg.chat_id, BOT.askLocation())
    return
  }
  if (words.isYes(text)) return fileTicket(ctx)

  await sendWhatsAppMessage(ctx.msg.chat_id, BOT.editMenu())
}

async function handlePostTicket(ctx: FlowContext, text: string) {
  if (words.isReport(text)) return startIntake(ctx)
  if (words.isStatus(text)) return replyStatus(ctx, extractTicketNumber(text))

  await setStep(ctx, 'idle', {})
  await sendWhatsAppMessage(ctx.msg.chat_id, BOT.postTicketIdle())
}

async function sendSummary(ctx: FlowContext, draft: Draft) {
  const issue = (draft.issue_text ?? '').trim() || '(no description provided)'
  const mediaCount = draft.media?.length ?? 0
  const location = draft.location_text ?? '(not provided)'
  await sendWhatsAppMessage(
    ctx.msg.chat_id,
    BOT.confirm({ issue, mediaCount, location }),
  )
}

async function fileTicket(ctx: FlowContext) {
  const draft = ctx.draft
  if (!draft.issue_text) {
    await setStep(ctx, 'collecting_issue', draft)
    await sendWhatsAppMessage(ctx.msg.chat_id, BOT.startIssue())
    return
  }

  const result = await createTicket({
    organizationId: ctx.organizationId,
    sourceChannel: 'whatsapp',
    sourceConversationId: ctx.conversationId,
    citizenId: ctx.citizenId,
    anonymousFlag: false,
    originalIssueText: draft.issue_text ?? undefined,
    locationText: draft.location_text ?? undefined,
    latitude: draft.latitude ?? undefined,
    longitude: draft.longitude ?? undefined,
    attachmentCount: draft.media?.length ?? 0,
  })

  if (!result.success) {
    await sendWhatsAppMessage(ctx.msg.chat_id, BOT.failed())
    return
  }

  await ctx.supabase
    .from('channel_conversations')
    .update({
      ticket_id: result.ticketId,
      state: 'follow_up',
      current_step: 'post_ticket',
      metadata_json: { draft: {}, last_ticket_number: result.ticketNumber },
      last_activity_at: new Date().toISOString(),
    })
    .eq('id', ctx.conversationId)

  await sendWhatsAppMessage(ctx.msg.chat_id, BOT.filed(result.ticketNumber))

  if (draft.media?.length) {
    try {
      const rows = await Promise.all(
        draft.media.map(async (m) => {
          const isUrl = m.file_id.startsWith('http')
          let stored = null
          if (isUrl) {
            stored = await downloadFromTwilioAndStore({
              media_url: m.file_id,
              org_id: ctx.organizationId,
              ticket_id: result.ticketId,
              mime_hint: m.mime_type ?? null,
              message_sid: m.message_sid ?? undefined,
            })
          }
          return {
            ticket_id: result.ticketId,
            file_name: m.message_sid ?? m.file_id.slice(0, 64),
            storage_path: stored?.storage_path ?? `twilio:${m.message_sid ?? m.file_id}`,
            mime_type: stored?.mime_type ?? m.mime_type ?? null,
            file_size_bytes: stored?.size_bytes ?? null,
            attachment_type:
              stored?.attachment_type ??
              (m.type === 'voice' ? 'audio' :
               m.type === 'image' ? 'image' :
               m.type === 'video' ? 'video' :
               m.type === 'document' ? 'document' : 'other'),
          }
        }),
      )
      await ctx.supabase.from('ticket_attachments').insert(rows)
    } catch (err) {
      console.error('[whatsappFlow] media upload error:', err instanceof Error ? err.message : String(err))
    }
  }

  findNearestAvailableWorker(result.ticketId).then(async (worker) => {
    if (worker) {
      await offerTicketToWorker({
        ticketId: result.ticketId,
        workerId: worker.id,
        assignedByUserId: null,
        reason: 'Auto-assigned at ticket creation',
      })
    }
  }).catch(() => {})

  if (draft.issue_text) {
    generateTicketSuggestions(draft.issue_text).then(async (s) => {
      if (s.error) return
      await ctx.supabase.from('ai_ticket_suggestions').insert({
        ticket_id: result.ticketId,
        model_used: process.env.OPENROUTER_MODEL ?? 'unknown',
        suggested_title: s.suggested_title,
        suggested_summary: s.suggested_summary,
        suggested_category: s.suggested_category,
        suggested_severity: s.suggested_severity,
        suggested_department: s.suggested_department,
        suggested_location_text: s.suggested_location_text,
        confidence_json: s.confidence_json,
        raw_ai_response: s.raw_ai_response as Record<string, unknown>,
        status: 'completed',
      })
    }).catch(() => {})
  }
}

async function replyStatus(ctx: FlowContext, ticketNumber: string | null) {
  if (ticketNumber) {
    const { data: t } = await ctx.supabase
      .from('tickets')
      .select('ticket_number, stage, updated_at')
      .eq('organization_id', ctx.organizationId)
      .eq('ticket_number', ticketNumber)
      .maybeSingle()
    if (!t) {
      await sendWhatsAppMessage(ctx.msg.chat_id, BOT.statusNotFound())
      return
    }
    await sendWhatsAppMessage(ctx.msg.chat_id, BOT.statusReply({
      ticketNumber: t.ticket_number,
      stage: citizenStageLabel(t.stage),
      lastUpdate: new Date(t.updated_at).toLocaleString('en-IN', {
        dateStyle: 'medium',
        timeStyle: 'short',
      }),
    }))
    return
  }

  const { data: recent } = await ctx.supabase
    .from('tickets')
    .select('ticket_number, stage, updated_at')
    .eq('organization_id', ctx.organizationId)
    .eq('citizen_id', ctx.citizenId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!recent) {
    await sendWhatsAppMessage(ctx.msg.chat_id, BOT.statusNoRecent())
    return
  }

  await sendWhatsAppMessage(ctx.msg.chat_id, BOT.statusReply({
    ticketNumber: recent.ticket_number,
    stage: citizenStageLabel(recent.stage),
    lastUpdate: new Date(recent.updated_at).toLocaleString('en-IN', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }),
  }))
}

async function setStep(ctx: FlowContext, step: Step, draft: Draft) {
  await ctx.supabase
    .from('channel_conversations')
    .update({
      current_step: step,
      metadata_json: { draft },
      last_activity_at: new Date().toISOString(),
    })
    .eq('id', ctx.conversationId)
  ctx.currentStep = step
  ctx.draft = draft
}

async function resetConversation(ctx: FlowContext, step: Step) {
  await setStep(ctx, step, {})
}

function mergeDraft(current: Draft, patch: Partial<Draft>): Draft {
  return { ...current, ...patch }
}
