/**
 * WhatsApp AI intake — conversational chatbot via intakeConversationManager.
 * Replaces rigid step-by-step scripts when WHATSAPP_INTAKE_MODE=ai (default).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  processInbound,
  type ConversationTurn,
  type IntakeResponse,
} from './intakeConversationManager.js'
import {
  sendWhatsAppMessage,
  extractTicketNumber,
  words,
  isCommand,
} from './whatsappService.js'
import {
  looksLikeStatusFollowUp,
  offerTicketStatusFlow,
  resolveTicketPickerChoice,
  sendTicketStatus,
  type TicketPickerOption,
} from './whatsappTicketStatus.js'
import {
  normalizeStoredLanguage,
  resolveReplyLanguage,
  statusCopy,
  type WhatsAppLang,
} from './whatsappLocale.js'
import { createTicket } from './ticketService.js'
import { enrichTicketFromIssueText } from './ticketIntakeAi.js'
import { downloadFromTwilioAndStore } from './attachmentService.js'
import { maskWhatsAppUserId, waLog, waLogError, whatsappAutoOfferWorker } from '@/lib/whatsappFlowLog.js'
import type { Draft, DraftMedia, IncomingMessage } from './whatsappFlow.js'

const MAX_HISTORY_TURNS = 24

export type WhatsAppAiStep = 'ai_intake' | 'post_ticket'

export interface AiDraftState {
  issue_text?: string | null
  issue_text_native?: string | null
  location_text?: string | null
  latitude?: number | null
  longitude?: number | null
  category?: string | null
  severity_hint?: string | null
  scope_assessment?: string | null
  media?: DraftMedia[]
}

export interface WhatsAppConversationMeta {
  history?: ConversationTurn[]
  aiDraft?: AiDraftState
  draft?: Draft
  last_ticket_number?: string | null
  /** Active numbered menu for ticket status (reply 1, 2, …). */
  ticketPickerOptions?: TicketPickerOption[] | null
  /** Last detected reply language (hi / te / en). */
  preferredLanguage?: string | null
}

export interface AiFlowContext {
  supabase: SupabaseClient
  organizationId: string
  conversationId: string
  citizenId: string
  currentStep: WhatsAppAiStep
  meta: WhatsAppConversationMeta
  msg: IncomingMessage
}

export function isWhatsAppAiIntakeEnabled(): boolean {
  const mode = (process.env.WHATSAPP_INTAKE_MODE ?? 'ai').trim().toLowerCase()
  return mode !== 'script' && mode !== 'v1'
}

function buildUserContent(ctx: AiFlowContext): string {
  const parts: string[] = []
  const text = (ctx.msg.text ?? '').trim()
  if (text) parts.push(text)

  if (ctx.msg.location) {
    parts.push(
      `[Location shared: latitude ${ctx.msg.location.latitude}, longitude ${ctx.msg.location.longitude}]`,
    )
  }

  if (ctx.msg.media) {
    const kind = ctx.msg.media.type
    const cap = ctx.msg.media.caption?.trim()
    parts.push(
      cap
        ? `[${kind} attachment sent: ${cap}]`
        : `[${kind} attachment sent — please consider this as evidence for the issue]`,
    )
  }

  return parts.join('\n\n') || '[Empty message]'
}

function mergeAiDraft(
  current: AiDraftState,
  updates: IntakeResponse['draftUpdates'],
  ctx: AiFlowContext,
): AiDraftState {
  const media = [...(current.media ?? [])]
  if (ctx.msg.media) media.push(ctx.msg.media)

  return {
    ...current,
    issue_text: updates.issue_text ?? current.issue_text,
    issue_text_native: updates.issue_text_native ?? current.issue_text_native,
    location_text: updates.location_text ?? current.location_text,
    latitude: ctx.msg.location?.latitude ?? current.latitude,
    longitude: ctx.msg.location?.longitude ?? current.longitude,
    category: updates.category ?? current.category,
    severity_hint: updates.severity_hint ?? current.severity_hint,
    media,
  }
}

function trimHistory(history: ConversationTurn[]): ConversationTurn[] {
  return history.slice(-MAX_HISTORY_TURNS)
}

function isShortGreeting(text: string): boolean {
  const t = text.trim().toLowerCase()
  return /^(hi+|hii+|hello+|hey+|namaste|namaskar)\s*!?\.?$/.test(t)
}

/** Location-only message (pin, city, "I live in…") — not an issue description that mentions a road. */
function isStandaloneLocationMessage(text: string): boolean {
  const t = text.trim()
  if (/\b\d{6}\b/.test(t)) return true
  if (/\b(pin\s*code|pincode|pin\s*[-:])\s*\d{5,6}/i.test(t)) return true
  if (/\b(i live in|located at|my address is|address:)\b/i.test(t)) return true
  if (t.length < 90 && /\b(kanpur|rawatpur|lucknow|delhi|mumbai|nagar|ward)\b/i.test(t)) return true
  return false
}

/** Merge v1 script-flow draft into AI draft when switching modes mid-conversation. */
export function hydrateConversationMeta(meta: WhatsAppConversationMeta): WhatsAppConversationMeta {
  const legacy = meta.draft ?? {}
  const ai = meta.aiDraft ?? {}
  return {
    ...meta,
    aiDraft: {
      ...ai,
      issue_text: ai.issue_text ?? legacy.issue_text ?? null,
      issue_text_native: ai.issue_text_native ?? legacy.issue_text ?? null,
      location_text: ai.location_text ?? legacy.location_text ?? null,
      latitude: ai.latitude ?? legacy.latitude ?? null,
      longitude: ai.longitude ?? legacy.longitude ?? null,
      media: (ai.media?.length ? ai.media : legacy.media) ?? [],
    },
  }
}

/** When OpenRouter fails — still progress the conversation from accumulated draft + message. */
function localIntakeFallback(
  userContent: string,
  draft: AiDraftState,
): {
  replyText: string
  draftUpdates: IntakeResponse['draftUpdates']
  readyToFile: boolean
} {
  const text = userContent.trim()
  const issue = (draft.issue_text_native ?? draft.issue_text ?? '').trim()
  const location = (draft.location_text ?? '').trim()

  if (isShortGreeting(text)) {
    return {
      replyText:
        'Hello! I am here to help you report civic problems to your local team — roads, drainage, water, garbage, and similar issues. What is going on in your area?',
      draftUpdates: {},
      readyToFile: false,
    }
  }

  if (!issue) {
    if (isStandaloneLocationMessage(text)) {
      return {
        replyText:
          'Thanks for the location. What problem should we report there — for example drainage, road damage, or water supply?',
        draftUpdates: { location_text: text },
        readyToFile: false,
      }
    }
    if (text.length >= 10) {
      const preview = text.length > 100 ? `${text.slice(0, 100)}…` : text
      return {
        replyText: `I understand — "${preview}". Which locality or landmark is this in? (city, ward, or pin code)`,
        draftUpdates: { issue_text: text, issue_text_native: text },
        readyToFile: false,
      }
    }
    return {
      replyText:
        'Tell me what civic problem you are facing (for example: broken road, blocked drainage, no water).',
      draftUpdates: {},
      readyToFile: false,
    }
  }

  if (!location) {
    if (text.length >= 4) {
      return {
        replyText: `Noted your issue. Location: ${text}.\n\nReply *yes* to submit, or add more detail.`,
        draftUpdates: { location_text: text },
        readyToFile: true,
      }
    }
    return {
      replyText: `Got it: "${issue.slice(0, 120)}${issue.length > 120 ? '…' : ''}". Where is this — locality, landmark, or pin code?`,
      draftUpdates: {},
      readyToFile: false,
    }
  }

  return {
    replyText: `Ready to register:\n• Issue: ${issue.slice(0, 300)}\n• Location: ${location}\n\nReply *yes* to submit.`,
    draftUpdates: {},
    readyToFile: true,
  }
}

async function persistMeta(ctx: AiFlowContext, step: WhatsAppAiStep, meta: WhatsAppConversationMeta) {
  const payload: WhatsAppConversationMeta = {
    history: meta.history ?? [],
    aiDraft: meta.aiDraft ?? {},
    draft: meta.draft ?? {},
    last_ticket_number: meta.last_ticket_number ?? null,
    ticketPickerOptions: meta.ticketPickerOptions ?? null,
    preferredLanguage: meta.preferredLanguage ?? null,
  }
  const { error } = await ctx.supabase
    .from('channel_conversations')
    .update({
      current_step: step,
      state: step === 'post_ticket' ? 'follow_up' : 'intake',
      metadata_json: payload,
      last_activity_at: new Date().toISOString(),
    })
    .eq('id', ctx.conversationId)
  if (error) {
    console.error('[whatsappAiFlow] persistMeta failed:', error.message, { conversationId: ctx.conversationId })
  }
  ctx.currentStep = step
  ctx.meta = payload
}

function replyLang(ctx: AiFlowContext, userText?: string): WhatsAppLang {
  return resolveReplyLanguage(userText ?? ctx.msg.text ?? '', ctx.meta.preferredLanguage)
}

async function handleTicketStatusRequest(
  ctx: AiFlowContext,
  preferredTicket: string | null,
  userText?: string,
): Promise<void> {
  const lang = replyLang(ctx, userText)
  const result = await offerTicketStatusFlow({
    supabase: ctx.supabase,
    organizationId: ctx.organizationId,
    citizenId: ctx.citizenId,
    channelUserId: ctx.msg.chat_id,
    preferredTicket,
    lastTicketNumber: ctx.meta.last_ticket_number ?? null,
    replyLanguage: lang,
  })

  await persistMeta(ctx, ctx.currentStep, {
    ...ctx.meta,
    ticketPickerOptions: result.pickerOptions,
    last_ticket_number: result.shownTicket ?? ctx.meta.last_ticket_number,
    preferredLanguage: lang,
  })
}

async function finalizeTicket(ctx: AiFlowContext, aiDraft: AiDraftState) {
  const issueText =
    (aiDraft.issue_text_native ?? aiDraft.issue_text ?? '').trim() ||
    (ctx.msg.text ?? '').trim()

  waLog('ai.file', 'finalize ticket', {
    conversationId: ctx.conversationId,
    citizenId: ctx.citizenId,
    issueChars: issueText.length,
    hasLocation: !!(aiDraft.location_text || (aiDraft.latitude && aiDraft.longitude)),
    mediaCount: aiDraft.media?.length ?? 0,
  })

  if (!issueText) {
    await sendWhatsAppMessage(
      ctx.msg.chat_id,
      'I need a bit more detail about the problem before I can register it. What is happening, and where?',
    )
    return
  }

  const result = await createTicket({
    organizationId: ctx.organizationId,
    sourceChannel: 'whatsapp',
    sourceConversationId: ctx.conversationId,
    citizenId: ctx.citizenId,
    anonymousFlag: false,
    originalIssueText: issueText.slice(0, 4000),
    locationText: aiDraft.location_text ?? undefined,
    latitude: aiDraft.latitude ?? undefined,
    longitude: aiDraft.longitude ?? undefined,
    attachmentCount: aiDraft.media?.length ?? 0,
  })

  if (!result.success) {
    waLog('ai.file', 'createTicket failed', {
      conversationId: ctx.conversationId,
      error: result.error,
    })
    await sendWhatsAppMessage(
      ctx.msg.chat_id,
      'Something went wrong while saving your report. Please try again in a moment.',
    )
    return
  }

  waLog('ai.file', 'ticket created', {
    conversationId: ctx.conversationId,
    ticketId: result.ticketId,
    ticketNumber: result.ticketNumber,
  })

  if (aiDraft.media?.length) {
    try {
      const rows = await Promise.all(
        aiDraft.media.map(async (m) => {
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
      waLog('ai.media', 'attachments saved', { ticketId: result.ticketId, count: rows.length })
    } catch (err) {
      waLogError('ai.media', 'attachment upload failed', err, { ticketId: result.ticketId })
    }
  }

  const enrich = await enrichTicketFromIssueText({
    ticketId: result.ticketId,
    organizationId: ctx.organizationId,
    issueText,
  })
  if (!enrich.ok) {
    waLog('ai.enrich', 'classification skipped', {
      ticketId: result.ticketId,
      error: enrich.error,
    })
  } else {
    waLog('ai.enrich', 'classification applied', {
      ticketId: result.ticketId,
      fields: enrich.fieldsApplied,
    })
  }

  await whatsappAutoOfferWorker({
    ticketId: result.ticketId,
    ticketNumber: result.ticketNumber,
    intake: 'ai',
  })

  const filedNote = `Ticket registered: ${result.ticketNumber}.`
  const history = trimHistory([
    ...(ctx.meta.history ?? []),
    { role: 'assistant', content: filedNote },
  ])

  await persistMeta(ctx, 'post_ticket', {
    history,
    aiDraft: {},
    draft: {},
    last_ticket_number: result.ticketNumber,
  })

  // AI already confirmed filing in replyText on the same turn; send ticket id clearly.
  const lang = replyLang(ctx)
  await sendWhatsAppMessage(
    ctx.msg.chat_id,
    statusCopy(lang).filed(result.ticketNumber),
  )
  waLog('ai.reply', 'sent filed confirmation to citizen', {
    ticketNumber: result.ticketNumber,
    from: maskWhatsAppUserId(ctx.msg.chat_id),
  })
}

export async function handleInboundMessageAi(ctx: AiFlowContext): Promise<void> {
  ctx.meta = hydrateConversationMeta(ctx.meta)
  const text = (ctx.msg.text ?? '').trim()

  waLog('ai.dispatch', 'handle message', {
    conversationId: ctx.conversationId,
    citizenId: ctx.citizenId,
    from: maskWhatsAppUserId(ctx.msg.chat_id),
    step: ctx.currentStep,
    messageId: ctx.msg.message_id,
    textPreview: text ? text.slice(0, 80) : null,
    hasMedia: !!ctx.msg.media,
    hasLocation: !!ctx.msg.location,
    historyTurns: ctx.meta.history?.length ?? 0,
  })

  if (isCommand(text, '/cancel') || words.isNo(text)) {
    await persistMeta(ctx, 'ai_intake', { history: [], aiDraft: {}, draft: {} })
    await sendWhatsAppMessage(
      ctx.msg.chat_id,
      'Okay, we can stop here. Whenever you want to report a civic issue, just message me.',
    )
    return
  }

  const lang = replyLang(ctx, text)

  if (ctx.meta.ticketPickerOptions?.length) {
    const picked = resolveTicketPickerChoice(text, ctx.meta.ticketPickerOptions)
    if (picked) {
      await sendTicketStatus(ctx.msg.chat_id, ctx.supabase, ctx.organizationId, picked, lang)
      await persistMeta(ctx, ctx.currentStep, {
        ...ctx.meta,
        ticketPickerOptions: null,
        last_ticket_number: picked,
        preferredLanguage: lang,
      })
      return
    }
  }

  const ticketFromText = extractTicketNumber(text)
  if (ticketFromText) {
    await handleTicketStatusRequest(ctx, ticketFromText, text)
    return
  }

  if (words.isStatus(text)) {
    await handleTicketStatusRequest(ctx, null, text)
    return
  }

  if (ctx.currentStep === 'post_ticket' && (looksLikeStatusFollowUp(text) || ctx.msg.media)) {
    await handleTicketStatusRequest(ctx, ctx.meta.last_ticket_number ?? null, text)
    return
  }

  const existingDraft = ctx.meta.aiDraft ?? {}
  if (words.isYes(text)) {
    const issue = (existingDraft.issue_text_native ?? existingDraft.issue_text ?? '').trim()
    if (issue) {
      await finalizeTicket(ctx, existingDraft)
      return
    }
  }

  const userContent = buildUserContent(ctx)
  const history = ctx.meta.history ?? []

  let response = await processInbound({
    history,
    newMessage: { text: userContent },
    existingDraft: (ctx.meta.aiDraft ?? {}) as Record<string, unknown>,
  })

  waLog('ai.turn', 'intake model response', {
    conversationId: ctx.conversationId,
    intent: response.intent,
    scope: response.scopeAssessment,
    readyToFile: response.readyToFile,
    fallback: !!response._meta?.fallback,
  })

  if (response._meta?.fallback) {
    const err = response._meta.error ?? 'unknown'
    waLog('ai.turn', 'OpenRouter fallback — using local intake', {
      conversationId: ctx.conversationId,
      error: err,
      model: process.env.OPENROUTER_MODEL ?? '(default)',
      historyTurns: history.length,
    })
    const local = localIntakeFallback(userContent, ctx.meta.aiDraft ?? {})
    response = {
      ...response,
      replyText: local.replyText,
      draftUpdates: local.draftUpdates,
      readyToFile: local.readyToFile,
      scopeAssessment: 'needs_review',
      intent: 'civic_issue',
    }
  }

  const aiDraft = mergeAiDraft(ctx.meta.aiDraft ?? {}, response.draftUpdates, ctx)
  aiDraft.scope_assessment = response.scopeAssessment

  const preferredLanguage =
    response.language && response.language !== 'unknown'
      ? normalizeStoredLanguage(response.language)
      : lang

  const assistantText =
    response.replyText?.trim() ||
    'Tell me more about what happened — I am here to help you report it to the right people.'

  const updatedHistory = trimHistory([
    ...history,
    { role: 'user', content: userContent },
    { role: 'assistant', content: assistantText },
  ])

  if (response.scopeAssessment === 'out_of_scope') {
    await sendWhatsAppMessage(ctx.msg.chat_id, assistantText)
    await persistMeta(ctx, 'ai_intake', {
      ...ctx.meta,
      history: updatedHistory,
      aiDraft: {},
      preferredLanguage,
    })
    return
  }

  if (response.intent === 'status_check') {
    await handleTicketStatusRequest(
      ctx,
      ctx.meta.last_ticket_number ?? ticketFromText ?? null,
      text,
    )
    await persistMeta(ctx, ctx.currentStep === 'post_ticket' ? 'post_ticket' : 'ai_intake', {
      ...ctx.meta,
      history: updatedHistory,
      aiDraft,
      ticketPickerOptions: null,
      preferredLanguage,
    })
    return
  }

  await sendWhatsAppMessage(ctx.msg.chat_id, assistantText)

  if (response.readyToFile) {
    waLog('ai.turn', 'readyToFile — filing ticket', { conversationId: ctx.conversationId })
    await persistMeta(ctx, 'ai_intake', {
      ...ctx.meta,
      history: updatedHistory,
      aiDraft,
      preferredLanguage,
    })
    await finalizeTicket(ctx, aiDraft)
    return
  }

  await persistMeta(ctx, ctx.currentStep === 'post_ticket' ? 'post_ticket' : 'ai_intake', {
    ...ctx.meta,
    history: updatedHistory,
    aiDraft,
    preferredLanguage,
  })
}
