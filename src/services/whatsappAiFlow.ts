/**
 * WhatsApp AI intake — conversational chatbot via intakeConversationManager.
 * Replaces rigid step-by-step scripts when WHATSAPP_INTAKE_MODE=ai (default).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  absorbIntakeSlots,
  extractBareName,
  extractNamedIntro,
  isShortGreeting,
  looksLikeProblem,
  wantsContinue,
  wantsNewIssue,
  type IntakePhase,
} from '@/lib/citizenIntakeLadder.js'
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
  fetchCitizenTickets,
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
import { resolveTicketTerritory } from './territoryResolveService.js'
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
  /** Citizen's preferred name collected during intake. */
  citizen_name?: string | null
  /** Phase-0 ladder position. */
  intake_phase?: IntakePhase | null
  /** When true, next 1/2 replies mean continue vs new. */
  awaiting_resume_choice?: boolean | null
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
    citizen_name: updates.citizen_name ?? current.citizen_name,
    media,
  }
}

function trimHistory(history: ConversationTurn[]): ConversationTurn[] {
  return history.slice(-MAX_HISTORY_TURNS)
}

function draftHasProgress(draft: AiDraftState): boolean {
  return !!(
    (draft.issue_text_native ?? draft.issue_text ?? '').trim() ||
    (draft.location_text ?? '').trim() ||
    (draft.media?.length ?? 0) > 0
  )
}

function syncWaPhase(draft: AiDraftState): IntakePhase {
  if (!(draft.citizen_name ?? '').trim()) return 'ask_name'
  if (!(draft.issue_text_native ?? draft.issue_text ?? '').trim()) return 'ask_problem'
  if (!(draft.location_text ?? '').trim()) return 'ask_area'
  return 'help'
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

  const name = (draft.citizen_name ?? '').trim()
  const slots = absorbIntakeSlots(text)
  const bareName = extractBareName(text) || extractNamedIntro(text) || slots.name

  if (!name) {
    if (isShortGreeting(text) && !hasPhoto) {
      return { replyText: c.greeting, draftUpdates: {}, readyToFile: false }
    }
    if (bareName) {
      const nextIssue = slots.problem || (looksLikeProblem(text) ? text : undefined)
      if (nextIssue) {
        return {
          replyText: c.ackIssueAskLocation(nextIssue.slice(0, 100)),
          draftUpdates: {
            citizen_name: bareName,
            issue_text: nextIssue,
            issue_text_native: nextIssue,
            ...(slots.place ? { location_text: slots.place } : {}),
          },
          readyToFile: false,
        }
      }
      return {
        replyText: c.askProblem(bareName),
        draftUpdates: { citizen_name: bareName },
        readyToFile: false,
      }
    }
    return {
      replyText: isShortGreeting(text) ? c.greeting : c.askNameAgain,
      draftUpdates: {},
      readyToFile: false,
    }
  }

  if (isShortGreeting(text) && !hasPhoto && !issue) {
    return { replyText: c.askProblem(name), draftUpdates: {}, readyToFile: false }
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
    return { replyText: c.askProblem(name), draftUpdates: {}, readyToFile: false }
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

async function persistTicketMediaRows(
  ctx: AiFlowContext,
  ticketId: string,
  mediaList: DraftMedia[],
): Promise<number> {
  if (!mediaList.length) return 0
  const rows = await Promise.all(
    mediaList.map(async (m) => {
      const isUrl = m.file_id.startsWith('http')
      let stored = null
      if (isUrl) {
        stored = await downloadFromTwilioAndStore({
          media_url: m.file_id,
          org_id: ctx.organizationId,
          ticket_id: ticketId,
          mime_hint: m.mime_type ?? null,
          message_sid: m.message_sid ?? undefined,
        })
      }
      return {
        ticket_id: ticketId,
        file_name: m.message_sid ?? m.file_id.slice(0, 64),
        storage_path: stored?.storage_path ?? `twilio:${m.message_sid ?? m.file_id}`,
        mime_type: stored?.mime_type ?? m.mime_type ?? null,
        file_size_bytes: stored?.size_bytes ?? null,
        attachment_type:
          stored?.attachment_type ??
          (m.type === 'voice'
            ? 'audio'
            : m.type === 'image'
              ? 'image'
              : m.type === 'video'
                ? 'video'
                : m.type === 'document'
                  ? 'document'
                  : 'other'),
      }
    }),
  )
  const { error } = await ctx.supabase.from('ticket_attachments').insert(rows)
  if (error) {
    waLogError('ai.media', 'attachment insert failed', error, { ticketId })
    return 0
  }
  waLog('ai.media', 'attachments saved', { ticketId, count: rows.length })
  return rows.length
}

/** Attach WhatsApp media to an already-filed ticket (post_ticket follow-up). */
async function attachMediaToTicketByNumber(
  ctx: AiFlowContext,
  ticketNumber: string,
): Promise<{ ok: boolean; ticketId?: string }> {
  if (!ctx.msg.media) return { ok: false }
  const { data: ticket, error } = await ctx.supabase
    .from('tickets')
    .select('id')
    .eq('organization_id', ctx.organizationId)
    .eq('ticket_number', ticketNumber)
    .maybeSingle()
  if (error || !ticket?.id) {
    waLogError('ai.media', 'ticket lookup for attachment failed', error, { ticketNumber })
    return { ok: false }
  }
  const saved = await persistTicketMediaRows(ctx, ticket.id as string, [ctx.msg.media])
  return { ok: saved > 0, ticketId: ticket.id as string }
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

/**
 * Phase-0 ladder: greet → name → (resume / past tickets) → problem → area.
 * Returns true when this turn was fully handled (message sent + meta saved).
 */
async function handleWhatsAppIntakeLadder(
  ctx: AiFlowContext,
  text: string,
  lang: WhatsAppLang,
): Promise<boolean> {
  let draft = { ...(ctx.meta.aiDraft ?? {}) }
  const c = intakeCopy(lang)
  const name = (draft.citizen_name ?? '').trim()
  const hasMedia = Boolean(ctx.msg.media)
  const hasLocationPin = Boolean(ctx.msg.location)

  // Resume choice: 1 = continue unfinished draft, 2 / new = clear and start fresh
  if (draft.awaiting_resume_choice) {
    if (wantsNewIssue(text) || text.trim() === '2') {
      draft = {
        citizen_name: draft.citizen_name,
        intake_phase: name ? 'ask_problem' : 'ask_name',
        awaiting_resume_choice: false,
      }
      const reply = name ? c.askProblem(name) : c.askName
      await replyAndPersistLadder(ctx, text, reply, draft, lang)
      return true
    }
    if (wantsContinue(text) || text.trim() === '1') {
      draft = { ...draft, awaiting_resume_choice: false, intake_phase: syncWaPhase(draft) }
      const issue = (draft.issue_text_native ?? draft.issue_text ?? '').trim()
      const location = (draft.location_text ?? '').trim()
      let reply: string
      if (!name) reply = c.askName
      else if (!issue) reply = c.askProblem(name)
      else if (!location) reply = c.ackIssueAskLocation(issue.slice(0, 100))
      else reply = c.confirmSubmit(issue, location)
      await replyAndPersistLadder(ctx, text, reply, draft, lang)
      return true
    }
    // Unrecognised — re-prompt resume
    const preview = (draft.issue_text_native ?? draft.issue_text ?? draft.location_text ?? 'your report')
      .toString()
      .slice(0, 80)
    await replyAndPersistLadder(ctx, text, c.resumeDraft(name, preview), draft, lang)
    return true
  }

  // On greeting: offer unfinished draft or past tickets before asking again
  if (isShortGreeting(text) && !hasMedia && !hasLocationPin) {
    if (draftHasProgress(draft)) {
      const preview = (draft.issue_text_native ?? draft.issue_text ?? draft.location_text ?? 'your report')
        .toString()
        .slice(0, 80)
      draft = { ...draft, awaiting_resume_choice: true }
      await replyAndPersistLadder(ctx, text, c.resumeDraft(name, preview), draft, lang)
      return true
    }

    const tickets = await fetchCitizenTickets(ctx.supabase, ctx.organizationId, ctx.citizenId, 5)
    if (tickets.length > 0) {
      const lines = tickets
        .map((t, i) => {
          const preview = (t.original_issue_text ?? t.ticket_number).replace(/\s+/g, ' ').slice(0, 45)
          return `${i + 1} — *${t.ticket_number}*\n   ${preview}${preview.length >= 45 ? '…' : ''}`
        })
        .join('\n\n')
      const pickerOptions: TicketPickerOption[] = tickets.map((t, i) => ({
        n: i + 1,
        ticket_number: t.ticket_number,
      }))
      const reply = name
        ? c.pastTicketsMenu(name, lines)
        : `${c.pastTicketsMenu('', lines)}\n\n${c.askName}`
      const history = trimHistory([
        ...(ctx.meta.history ?? []),
        { role: 'user', content: text || '[greeting]' },
        { role: 'assistant', content: reply },
      ])
      await sendWhatsAppMessage(ctx.msg.chat_id, reply)
      await persistMeta(ctx, 'ai_intake', {
        ...ctx.meta,
        history,
        aiDraft: {
          ...draft,
          intake_phase: name ? 'ask_problem' : 'ask_name',
        },
        ticketPickerOptions: pickerOptions,
        preferredLanguage: lang,
      })
      return true
    }

    if (!name) {
      draft = { ...draft, intake_phase: 'ask_name' }
      await replyAndPersistLadder(ctx, text, c.greeting, draft, lang)
      return true
    }

    draft = { ...draft, intake_phase: 'ask_problem' }
    await replyAndPersistLadder(ctx, text, c.askProblem(name), draft, lang)
    return true
  }

  // Collect name before letting the LLM roam
  if (!name && !hasMedia && !hasLocationPin) {
    const slots = absorbIntakeSlots(text)
    const bare = extractBareName(text) || extractNamedIntro(text) || slots.name
    if (bare) {
      draft.citizen_name = bare
      if (slots.problem || looksLikeProblem(text)) {
        const problem = slots.problem || text
        draft.issue_text = problem
        draft.issue_text_native = problem
      }
      if (slots.place) draft.location_text = slots.place
      draft.intake_phase = syncWaPhase(draft)
      draft.awaiting_resume_choice = false

      let reply: string
      if (draft.intake_phase === 'ask_problem') reply = c.askProblem(bare)
      else if (draft.intake_phase === 'ask_area') {
        const preview = (draft.issue_text_native ?? draft.issue_text ?? '').slice(0, 100)
        reply = c.ackIssueAskLocation(preview)
      } else reply = c.askProblem(bare)

      await replyAndPersistLadder(ctx, text, reply, draft, lang)
      return true
    }

    if (!looksLikeProblem(text)) {
      draft.intake_phase = 'ask_name'
      await replyAndPersistLadder(ctx, text, isShortGreeting(text) ? c.greeting : c.askNameAgain, draft, lang)
      return true
    }
    // Problem dumped without name — keep going but ask name first next; stash problem
    draft.issue_text = text
    draft.issue_text_native = text
    draft.intake_phase = 'ask_name'
    await replyAndPersistLadder(
      ctx,
      text,
      `${c.askName} ${lang === 'te' || lang === 'te-en' ? 'సమస్య గుర్తుంచుకున్నాను.' : lang === 'hi' || lang === 'hi-en' ? 'समस्या नोट कर ली।' : "I've noted the problem."}`,
      draft,
      lang,
    )
    return true
  }

  return false
}

async function replyAndPersistLadder(
  ctx: AiFlowContext,
  userText: string,
  reply: string,
  draft: AiDraftState,
  lang: WhatsAppLang,
): Promise<void> {
  const history = trimHistory([
    ...(ctx.meta.history ?? []),
    { role: 'user', content: userText || '[message]' },
    { role: 'assistant', content: reply },
  ])
  await sendWhatsAppMessage(ctx.msg.chat_id, reply)
  await persistMeta(ctx, 'ai_intake', {
    ...ctx.meta,
    history,
    aiDraft: { ...draft, intake_phase: draft.intake_phase ?? syncWaPhase(draft) },
    preferredLanguage: lang,
  })
}

async function finalizeTicket(ctx: AiFlowContext, aiDraft: AiDraftState) {
  aiDraft = mergeAiDraft(aiDraft, {}, ctx)

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

  const locationText = aiDraft.location_text ?? undefined
  const territoryMatch = await resolveTicketTerritory({
    organizationId: ctx.organizationId,
    locationText: locationText ?? '',
    issueText,
    latitude: aiDraft.latitude,
    longitude: aiDraft.longitude,
  })
  if (territoryMatch.territoryId) {
    waLog('ai.territory', 'resolved from location', {
      conversationId: ctx.conversationId,
      territoryId: territoryMatch.territoryId,
      territoryName: territoryMatch.territoryName,
      quality: territoryMatch.matchQuality,
      level: territoryMatch.levelOrder,
      distanceKm: territoryMatch.distanceKm ?? null,
    })
  } else {
    waLog('ai.territory', 'no territory match', {
      conversationId: ctx.conversationId,
      locationPreview: (locationText ?? issueText).slice(0, 120),
    })
  }

  const result = await createTicket({
    organizationId: ctx.organizationId,
    sourceChannel: 'whatsapp',
    sourceConversationId: ctx.conversationId,
    citizenId: ctx.citizenId,
    anonymousFlag: false,
    originalIssueText: issueText.slice(0, 4000),
    locationText,
    latitude: aiDraft.latitude ?? undefined,
    longitude: aiDraft.longitude ?? undefined,
    territoryId: territoryMatch.territoryId ?? undefined,
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
      await persistTicketMediaRows(ctx, result.ticketId, aiDraft.media)
    } catch (err) {
      waLogError('ai.media', 'attachment upload failed', err, { ticketId: result.ticketId })
    }
  }

  const enrich = await enrichTicketFromIssueText({
    ticketId: result.ticketId,
    organizationId: ctx.organizationId,
    issueText,
    severityHint: aiDraft.severity_hint ?? null,
    ensureSeverity: true,
  })
  if (!enrich.ok) {
    waLog('ai.enrich', 'classification partial', {
      ticketId: result.ticketId,
      error: enrich.error,
      severity: enrich.severity,
    })
  } else {
    waLog('ai.enrich', 'classification applied', {
      ticketId: result.ticketId,
      fields: enrich.fieldsApplied,
      severity: enrich.severity,
    })
  }

  await whatsappAutoOfferWorker({
    ticketId: result.ticketId,
    ticketNumber: result.ticketNumber,
    organizationId: ctx.organizationId,
    locationText: locationText,
    issueText: issueText,
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
    if (wantsNewIssue(text)) {
      const draft = ctx.meta.aiDraft ?? {}
      const name = (draft.citizen_name ?? '').trim()
      const c = intakeCopy(lang)
      const reply = name ? c.askProblem(name) : c.askName
      const history = trimHistory([
        ...(ctx.meta.history ?? []),
        { role: 'user', content: text },
        { role: 'assistant', content: reply },
      ])
      await sendWhatsAppMessage(ctx.msg.chat_id, reply)
      await persistMeta(ctx, 'ai_intake', {
        ...ctx.meta,
        history,
        ticketPickerOptions: null,
        aiDraft: {
          ...draft,
          issue_text: null,
          issue_text_native: null,
          location_text: null,
          media: [],
          intake_phase: name ? 'ask_problem' : 'ask_name',
          awaiting_resume_choice: false,
        },
        preferredLanguage: lang,
      })
      return
    }
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

  const existingDraft = ctx.meta.aiDraft ?? {}
  const langEarly = replyLang(ctx, text)

  if (ctx.msg.media) {
    const issueM = (existingDraft.issue_text_native ?? existingDraft.issue_text ?? '').trim()
    const locationM = (existingDraft.location_text ?? '').trim()

    if (issueM && locationM && !isVagueLocation(locationM) && ctx.currentStep === 'ai_intake') {
      const aiDraft = mergeAiDraft(existingDraft, {}, ctx)
      const c = intakeCopy(langEarly)
      const assistantText = `${c.photoReceivedAck}\n\n${c.confirmSubmit(issueM, locationM)}`
      const userContent = buildUserContent(ctx)
      const updatedHistory = trimHistory([
        ...(ctx.meta.history ?? []),
        { role: 'user', content: userContent },
        { role: 'assistant', content: assistantText },
      ])
      await sendWhatsAppMessage(ctx.msg.chat_id, assistantText)
      await persistMeta(ctx, 'ai_intake', {
        ...ctx.meta,
        history: updatedHistory,
        aiDraft: { ...aiDraft, photo_requested: true },
        preferredLanguage: langEarly,
      })
      return
    }

    const ticketNumber = ctx.meta.last_ticket_number
    if (ctx.currentStep === 'post_ticket' && ticketNumber) {
      const attached = await attachMediaToTicketByNumber(ctx, ticketNumber)
      const c = intakeCopy(langEarly)
      const msg = attached.ok
        ? c.photoAttachedToTicket(ticketNumber)
        : 'Sorry — I could not save that photo on your ticket. Please try sending it again.'
      await sendWhatsAppMessage(ctx.msg.chat_id, msg)
      return
    }
  }

  if (ctx.currentStep === 'post_ticket' && looksLikeStatusFollowUp(text)) {
    await handleTicketStatusRequest(ctx, ctx.meta.last_ticket_number ?? null, text)
    return
  }

  if (words.isYes(text)) {
    const mergedForYes = mergeAiDraft(existingDraft, {}, ctx)
    if (draftReadyForConfirmation(mergedForYes, Boolean(ctx.msg.media))) {
      await finalizeTicket(ctx, mergedForYes)
      return
    }
    const gateLang = replyLang(ctx, text)
    const gated = applyIntakeGates({
      draft: mergedForYes,
      modelReadyToFile: true,
      lang: gateLang,
      hasMedia: Boolean(ctx.msg.media),
      userText: text,
    })
    const merged = { ...mergedForYes, ...gated.draftPatch }
    await sendWhatsAppMessage(ctx.msg.chat_id, gated.replyOverride ?? intakeCopy(gateLang).askIssue)
    await persistMeta(ctx, 'ai_intake', {
      ...ctx.meta,
      aiDraft: merged as AiDraftState,
      preferredLanguage: gateLang,
    })
    return
  }

  const ladderHandled = await handleWhatsAppIntakeLadder(ctx, text, lang)
  if (ladderHandled) return

  const userContent = buildUserContent(ctx)
  const history = ctx.meta.history ?? []
  const existingForModel = {
    ...(ctx.meta.aiDraft ?? {}),
    citizen_name: ctx.meta.aiDraft?.citizen_name ?? null,
  }

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
    existingDraft: existingForModel as Record<string, unknown>,
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
  aiDraft.intake_phase = syncWaPhase(aiDraft)
  aiDraft.awaiting_resume_choice = false

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
