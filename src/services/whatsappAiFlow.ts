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
  intakeCopy,
  normalizeStoredLanguage,
  resolveReplyLanguage,
  statusCopy,
  type WhatsAppLang,
} from './whatsappLocale.js'
import { createTicket } from './ticketService.js'
import { generateTicketSuggestions } from './aiService.js'
import { autoRouteNewTicket } from './assignmentService.js'
import { enrichTicketFromIssueText } from './ticketIntakeAi.js'
import { downloadFromTwilioAndStore } from './attachmentService.js'
import { maskWhatsAppUserId, waLog, waLogError, whatsappAutoOfferWorker } from '@/lib/whatsappFlowLog.js'
import type { Draft, DraftMedia, IncomingMessage } from './whatsappFlow.js'
import {
  applyIntakeGates,
  draftReadyForConfirmation,
  isVagueLocation,
} from './whatsappIntakeGates.js'

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
  photo_requested?: boolean
  photo_skipped?: boolean
  location_confirmed?: boolean
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

/** When OpenRouter fails — conversational progress in the user's language mix. */
function localIntakeFallback(
  userContent: string,
  draft: AiDraftState,
  lang: WhatsAppLang,
  hasMedia: boolean,
): {
  replyText: string
  draftUpdates: IntakeResponse['draftUpdates']
  readyToFile: boolean
} {
  const c = intakeCopy(lang)
  const text = userContent.trim()
  const issue = (draft.issue_text_native ?? draft.issue_text ?? '').trim()
  const location = (draft.location_text ?? '').trim()
  const hasPhoto = hasMedia || (draft.media?.length ?? 0) > 0

  if (isShortGreeting(text) && !hasPhoto) {
    return { replyText: c.greeting, draftUpdates: {}, readyToFile: false }
  }

  if (hasPhoto && !issue && text.length < 15) {
    return {
      replyText: c.askIssue,
      draftUpdates: {},
      readyToFile: false,
    }
  }

  if (!issue) {
    if (isStandaloneLocationMessage(text)) {
      return {
        replyText: c.askLocationOnly,
        draftUpdates: { location_text: text },
        readyToFile: false,
      }
    }
    if (text.length >= 8) {
      const preview = text.length > 100 ? `${text.slice(0, 100)}…` : text
      return {
        replyText: c.ackIssueAskLocation(preview),
        draftUpdates: { issue_text: text, issue_text_native: text },
        readyToFile: false,
      }
    }
    return { replyText: c.askIssue, draftUpdates: {}, readyToFile: false }
  }

  let draftUpdates: IntakeResponse['draftUpdates'] = {}
  let replyText = c.readyOneField(issue)
  let modelReady = false

  if (!location) {
    if (text.length >= 4) {
      draftUpdates = { location_text: text }
      if (isVagueLocation(text)) {
        replyText = c.askSpecificLocation(text)
      } else {
        replyText = c.askPhoto
        modelReady = false
      }
    }
  } else if (isVagueLocation(location)) {
    replyText = c.askSpecificLocation(location)
    modelReady = false
  } else {
    modelReady = true
    replyText = c.confirmSubmit(issue, location)
  }

  const mergedDraft: AiDraftState = {
    ...draft,
    issue_text: issue || draft.issue_text,
    issue_text_native: issue || draft.issue_text_native,
    location_text: (draftUpdates.location_text as string) ?? location ?? draft.location_text,
    media: draft.media,
  }

  const gated = applyIntakeGates({
    draft: mergedDraft,
    modelReadyToFile: modelReady,
    lang,
    hasMedia: hasPhoto,
    userText: userContent,
  })

  return {
    replyText: gated.replyOverride ?? replyText,
    draftUpdates: {
      ...draftUpdates,
      ...(gated.draftPatch as IntakeResponse['draftUpdates']),
    },
    readyToFile: gated.readyToFile,
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

  // Auto-route: direct-assign to the territory's worker, else offer to nearest.
  autoRouteNewTicket(result.ticketId).catch(() => {})

  generateTicketSuggestions(issueText)
    .then(async (s) => {
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
    })
    .catch(() => {})

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

  const filedLang = replyLang(ctx)
  await persistMeta(ctx, 'post_ticket', {
    history,
    aiDraft: {},
    draft: {},
    last_ticket_number: result.ticketNumber,
    preferredLanguage: filedLang,
  })

  await sendWhatsAppMessage(
    ctx.msg.chat_id,
    statusCopy(filedLang).filed(result.ticketNumber),
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
    if (
      draftReadyForConfirmation(existingDraft, Boolean(ctx.msg.media))
    ) {
      await finalizeTicket(ctx, existingDraft)
      return
    }
    const gateLang = replyLang(ctx, text)
    const gated = applyIntakeGates({
      draft: existingDraft,
      modelReadyToFile: true,
      lang: gateLang,
      hasMedia: Boolean(ctx.msg.media),
      userText: text,
    })
    const merged = { ...existingDraft, ...gated.draftPatch }
    await sendWhatsAppMessage(ctx.msg.chat_id, gated.replyOverride ?? intakeCopy(gateLang).askIssue)
    await persistMeta(ctx, 'ai_intake', {
      ...ctx.meta,
      aiDraft: merged as AiDraftState,
      preferredLanguage: gateLang,
    })
    return
  }

  const userContent = buildUserContent(ctx)
  const history = ctx.meta.history ?? []

  let response = await processInbound({
    history,
    newMessage: {
      text: userContent,
      media: ctx.msg.media
        ? {
            image_description: `[Citizen sent a ${ctx.msg.media.type} on WhatsApp — thank them and use it as evidence]`,
          }
        : undefined,
    },
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
    console.error(
      '[whatsappAiFlow] OpenRouter fallback:',
      err,
      '| model:',
      process.env.OPENROUTER_MODEL ?? '(default)',
      '| history turns:',
      history.length,
    )
    waLog('ai.turn', 'OpenRouter fallback — using local intake', {
      conversationId: ctx.conversationId,
      error: err,
      model: process.env.OPENROUTER_MODEL ?? '(default)',
      historyTurns: history.length,
    })
    const local = localIntakeFallback(
      userContent,
      ctx.meta.aiDraft ?? {},
      lang,
      Boolean(ctx.msg.media),
    )
    response = {
      ...response,
      replyText: local.replyText,
      draftUpdates: local.draftUpdates,
      readyToFile: local.readyToFile,
      scopeAssessment: 'needs_review',
      intent: 'civic_issue',
    }
  }

  let aiDraft = mergeAiDraft(ctx.meta.aiDraft ?? {}, response.draftUpdates, ctx)
  aiDraft.scope_assessment = response.scopeAssessment

  const preferredLanguage =
    response.language && response.language !== 'unknown'
      ? normalizeStoredLanguage(response.language)
      : lang

  const gated = applyIntakeGates({
    draft: aiDraft,
    modelReadyToFile: response.readyToFile,
    lang: preferredLanguage,
    hasMedia: Boolean(ctx.msg.media),
    userText: text,
  })
  aiDraft = { ...aiDraft, ...(gated.draftPatch as Partial<AiDraftState>) }
  response = { ...response, readyToFile: gated.readyToFile }

  const assistantText =
    gated.replyOverride ??
    response.replyText?.trim() ??
    intakeCopy(preferredLanguage).askIssue

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
