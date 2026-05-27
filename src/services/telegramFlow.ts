/**
 * Telegram conversation state machine.
 *
 * The bot is an INTAKE ASSISTANT only. It guides the citizen through:
 *   idle → collecting_issue → collecting_media → collecting_location
 *        → confirming → post_ticket
 *
 * Global commands (/start, /help, /cancel, /status) work from any state.
 *
 * Guardrails:
 * - Bot never gives advice, never answers general questions.
 * - AI is used only for (a) intent classification when idle, (b) enrichment
 *   after ticket creation. Never for user-facing conversation.
 * - If the user's message doesn't fit the current step, the bot repeats the
 *   prompt — it doesn't guess.
 *
 * State storage (re-uses existing columns on `channel_conversations`):
 *   state         'intake' | 'follow_up' | 'completed' | 'abandoned'
 *   current_step  'idle' | 'collecting_issue' | 'collecting_media'
 *                 | 'collecting_location' | 'confirming' | 'editing'
 *                 | 'post_ticket'
 *   metadata_json { draft: { issue_text, media[], location, intent } }
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  BOT,
  KB,
  sendTelegramMessage,
  citizenStageLabel,
  words,
  extractTicketNumber,
  isCommand,
  normalize,
} from './telegramService'
import { classifyIntent } from './aiService'
import { createTicket } from './ticketService'
import { enrichTicketFromIssueText } from './ticketIntakeAi.js'
import { downloadFromTelegramAndStore } from './attachmentService'

export type Step =
  | 'idle'
  | 'collecting_issue'
  | 'collecting_media'
  | 'collecting_location'
  | 'confirming'
  | 'editing'
  | 'post_ticket'

export interface DraftMedia {
  file_id: string
  type: 'image' | 'video' | 'document' | 'voice'
  mime_type?: string | null
  caption?: string | null
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
  chat_id: number | string
  message_id: number
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

// ============================================================================
// Public entry point: route one inbound message through the state machine.
// ============================================================================
export async function handleInboundMessage(ctx: FlowContext): Promise<void> {
  const text = ctx.msg.text ?? ''

  // ---- Global commands always win -----------------------------------------
  if (isCommand(text, '/start'))  return doStart(ctx)
  if (isCommand(text, '/help'))   return doHelp(ctx)
  if (isCommand(text, '/cancel')) return doCancel(ctx)
  if (isCommand(text, '/status')) return doStatusCommand(ctx, text)

  // ---- State dispatch -----------------------------------------------------
  switch (ctx.currentStep) {
    case 'idle':                return handleIdle(ctx)
    case 'collecting_issue':    return handleCollectingIssue(ctx)
    case 'collecting_media':    return handleCollectingMedia(ctx)
    case 'collecting_location': return handleCollectingLocation(ctx)
    case 'confirming':          return handleConfirming(ctx)
    case 'editing':             return handleEditing(ctx)
    case 'post_ticket':         return handlePostTicket(ctx)
    default:                    return handleIdle(ctx)
  }
}

// ============================================================================
// Global handlers
// ============================================================================
async function doStart(ctx: FlowContext) {
  await resetConversation(ctx, 'idle')
  await sendTelegramMessage(ctx.msg.chat_id, BOT.welcome(), { reply_markup: KB.mainMenu() })
}

async function doHelp(ctx: FlowContext) {
  await sendTelegramMessage(ctx.msg.chat_id, BOT.help(), { reply_markup: KB.mainMenu() })
}

async function doCancel(ctx: FlowContext) {
  await resetConversation(ctx, 'idle')
  await sendTelegramMessage(ctx.msg.chat_id, BOT.cancelled(), { reply_markup: KB.mainMenu() })
}

async function doStatusCommand(ctx: FlowContext, text: string) {
  const fromText = extractTicketNumber(text)
  await replyStatus(ctx, fromText)
}

// ============================================================================
// State handlers
// ============================================================================
async function handleIdle(ctx: FlowContext) {
  const text = (ctx.msg.text ?? '').trim()

  // Short circuit on obvious words
  if (words.isReport(text)) return startIntake(ctx)
  if (words.isStatus(text)) return replyStatus(ctx, extractTicketNumber(text))
  if (words.isHelp(text))   return sendTelegramMessage(ctx.msg.chat_id, BOT.help())

  // First-time or unclear — if no text at all (pure media), prompt.
  if (!text && (ctx.msg.media || ctx.msg.location)) {
    await sendTelegramMessage(ctx.msg.chat_id, BOT.welcome(), { reply_markup: KB.mainMenu() })
    return
  }

  if (!text) {
    await sendTelegramMessage(ctx.msg.chat_id, BOT.welcome(), { reply_markup: KB.mainMenu() })
    return
  }

  // Use classifier for ambiguous text.
  const { intent, ticket_number } = await classifyIntent(text)
  switch (intent) {
    case 'greeting':
      return sendTelegramMessage(ctx.msg.chat_id, BOT.welcome(), { reply_markup: KB.mainMenu() })
    case 'info_query':
      return sendTelegramMessage(ctx.msg.chat_id, BOT.help(), { reply_markup: KB.mainMenu() })
    case 'status_check':
      return replyStatus(ctx, ticket_number)
    case 'report_issue':
      return startIntake(ctx)
    default:
      return sendTelegramMessage(ctx.msg.chat_id, BOT.unclear(), { reply_markup: KB.mainMenu() })
  }
}

async function startIntake(ctx: FlowContext) {
  await setStep(ctx, 'collecting_issue', { intent: 'report_issue', media: [] })
  await sendTelegramMessage(ctx.msg.chat_id, BOT.startIssue(), { reply_markup: KB.collectingIssue() })
}

async function handleCollectingIssue(ctx: FlowContext) {
  // Accept text OR voice (voice counted as a media attachment + ticket text
  // will be filled from caption/transcript later). Prefer text.
  const text = (ctx.msg.text ?? '').trim()

  // Media while we're asking for text — accept as evidence + still wait for text
  if (ctx.msg.media && !text) {
    const draft = mergeDraft(ctx.draft, { media: [...(ctx.draft.media ?? []), ctx.msg.media] })
    await setStep(ctx, 'collecting_issue', draft)
    await sendTelegramMessage(ctx.msg.chat_id,
      `Got the attachment. Now please *describe the issue* in a message (or voice note). Type /cancel to stop.`,
      { reply_markup: KB.collectingIssue() })
    return
  }

  if (!text) {
    await sendTelegramMessage(ctx.msg.chat_id, BOT.startIssue(), { reply_markup: KB.collectingIssue() })
    return
  }

  if (text.length < 4) {
    await sendTelegramMessage(ctx.msg.chat_id,
      `A bit more detail please — what's happening, and where?`,
      { reply_markup: KB.collectingIssue() })
    return
  }

  const draft = mergeDraft(ctx.draft, { issue_text: text.slice(0, 4000) })
  await setStep(ctx, 'collecting_media', draft)
  await sendTelegramMessage(ctx.msg.chat_id, BOT.askMedia(), { reply_markup: KB.askMedia() })
}

async function handleCollectingMedia(ctx: FlowContext) {
  const text = (ctx.msg.text ?? '').trim()

  if (ctx.msg.media) {
    const media = [...(ctx.draft.media ?? []), ctx.msg.media]
    const draft = mergeDraft(ctx.draft, { media })
    await setStep(ctx, 'collecting_media', draft)
    await sendTelegramMessage(ctx.msg.chat_id, BOT.mediaAdded(media.length), { reply_markup: KB.mediaAdded() })
    return
  }

  if (words.isDone(text) || words.isSkip(text) || words.isYes(text)) {
    await setStep(ctx, 'collecting_location', ctx.draft)
    await sendTelegramMessage(ctx.msg.chat_id, BOT.askLocation(), { reply_markup: KB.askLocation() })
    return
  }

  // Any other text while waiting for media — nudge, don't interpret.
  await sendTelegramMessage(ctx.msg.chat_id, BOT.askMedia(), { reply_markup: KB.askMedia() })
}

async function handleCollectingLocation(ctx: FlowContext) {
  const text = (ctx.msg.text ?? '').trim()

  if (ctx.msg.location) {
    const draft = mergeDraft(ctx.draft, {
      latitude:  ctx.msg.location.latitude,
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

  await sendTelegramMessage(ctx.msg.chat_id, BOT.locationNeedsText(), { reply_markup: KB.askLocation() })
}

async function handleConfirming(ctx: FlowContext) {
  const text = (ctx.msg.text ?? '').trim()

  if (words.isYes(text)) return fileTicket(ctx)
  if (words.isEdit(text)) {
    await setStep(ctx, 'editing', ctx.draft)
    await sendTelegramMessage(ctx.msg.chat_id, BOT.editMenu(), { reply_markup: KB.editMenu() })
    return
  }
  // Repeat the summary + menu until the user picks.
  await sendSummary(ctx, ctx.draft)
}

async function handleEditing(ctx: FlowContext) {
  const text = normalize(ctx.msg.text ?? '')

  if (text === '1' || text.includes('issue') || text.includes('description')) {
    await setStep(ctx, 'collecting_issue', { ...ctx.draft, issue_text: null })
    await sendTelegramMessage(ctx.msg.chat_id, BOT.startIssue(), { reply_markup: KB.collectingIssue() })
    return
  }
  if (text === '2' || text.includes('attach') || text.includes('media') || text.includes('photo')) {
    await setStep(ctx, 'collecting_media', { ...ctx.draft, media: [] })
    await sendTelegramMessage(ctx.msg.chat_id, BOT.askMedia(), { reply_markup: KB.askMedia() })
    return
  }
  if (text === '3' || text.includes('location') || text.includes('address')) {
    await setStep(ctx, 'collecting_location', {
      ...ctx.draft,
      latitude: null, longitude: null, location_text: null,
    })
    await sendTelegramMessage(ctx.msg.chat_id, BOT.askLocation(), { reply_markup: KB.askLocation() })
    return
  }
  if (words.isYes(text)) return fileTicket(ctx)

  await sendTelegramMessage(ctx.msg.chat_id, BOT.editMenu(), { reply_markup: KB.editMenu() })
}

async function handlePostTicket(ctx: FlowContext) {
  const text = (ctx.msg.text ?? '').trim()

  if (words.isReport(text)) return startIntake(ctx)
  if (words.isStatus(text)) return replyStatus(ctx, extractTicketNumber(text))

  // Anything else while we're post-ticket — return to idle with a gentle prompt.
  await setStep(ctx, 'idle', {})
  await sendTelegramMessage(ctx.msg.chat_id, BOT.postTicketIdle(), { reply_markup: KB.postTicket() })
}

// ============================================================================
// Helpers
// ============================================================================
async function sendSummary(ctx: FlowContext, draft: Draft) {
  const issue = (draft.issue_text ?? '').trim() || '(no description provided)'
  const mediaCount = draft.media?.length ?? 0
  const location = draft.location_text ?? '(not provided)'
  await sendTelegramMessage(
    ctx.msg.chat_id,
    BOT.confirm({ issue, mediaCount, location }),
    { reply_markup: KB.confirm() },
  )
}

async function fileTicket(ctx: FlowContext) {
  const draft = ctx.draft
  if (!draft.issue_text) {
    await setStep(ctx, 'collecting_issue', draft)
    await sendTelegramMessage(ctx.msg.chat_id, BOT.startIssue())
    return
  }

  const result = await createTicket({
    organizationId: ctx.organizationId,
    sourceChannel: 'telegram',
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
    await sendTelegramMessage(ctx.msg.chat_id, BOT.failed(), { reply_markup: KB.confirm() })
    return
  }

  // Link conversation to ticket, transition to follow_up.
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

  // Confirm to citizen FIRST so the reply is snappy — the slow media
  // upload happens immediately below but the citizen has already seen
  // confirmation.
  await sendTelegramMessage(ctx.msg.chat_id, BOT.filed(result.ticketNumber), { reply_markup: KB.postTicket() })

  // Persist media as ticket_attachments. For each media entry we try to
  // download from Telegram and upload to our Supabase Storage bucket
  // (E1). If the download/upload fails, we still record the row with the
  // legacy `telegram:<file_id>` pointer so the audit trail isn't lost.
  //
  // CRITICAL: this MUST be awaited — not fire-and-forget. Vercel
  // serverless will terminate any in-flight promise the moment the
  // parent function returns. Pre-2026-05-17 this was fire-and-forget
  // and the function returned before Telegram's getFile/download
  // round-trip (typically 2-5s) finished, so every upload fell
  // through silently to the telegram:<file_id> fallback.
  //
  // The citizen reply already went out above; this await only
  // delays the webhook's final 200 OK to Telegram (which Telegram
  // doesn't care about within its 60s window) and the auto-assign
  // kick-off below. Both fine.
  if (draft.media?.length) {
    const tStart = Date.now()
    console.error(`[telegramFlow] ENTER media upload block: ${draft.media.length} file(s) for ticket ${result.ticketNumber}`)
    try {
      const rows = await Promise.all(
        draft.media.map(async (m, idx) => {
          const t0 = Date.now()
          console.error(`[telegramFlow] file[${idx}] START download: file_id=${m.file_id.slice(0, 24)}… type=${m.type} mime_hint=${m.mime_type ?? 'null'}`)
          let stored
          try {
            stored = await downloadFromTelegramAndStore({
              file_id: m.file_id,
              org_id: ctx.organizationId,
              ticket_id: result.ticketId,
              mime_hint: m.mime_type ?? null,
            })
          } catch (err) {
            console.error(`[telegramFlow] file[${idx}] downloadFromTelegramAndStore THREW after ${Date.now() - t0}ms:`, err instanceof Error ? err.message : String(err))
            stored = null
          }
          console.error(`[telegramFlow] file[${idx}] download result in ${Date.now() - t0}ms: ${stored ? 'OK path=' + stored.storage_path : 'NULL (falling back to telegram: pointer)'}`)
          return {
            ticket_id: result.ticketId,
            file_name: m.file_id,
            storage_path: stored?.storage_path ?? `telegram:${m.file_id}`,
            mime_type: stored?.mime_type ?? m.mime_type ?? null,
            file_size_bytes: stored?.size_bytes ?? null,
            attachment_type:
              stored?.attachment_type ??
              (m.type === 'voice' ? 'audio' :
               m.type === 'image' ? 'image' :
               m.type === 'video' ? 'video' :
               m.type === 'document' ? 'document' : 'other'),
            _ok: !!stored,
          }
        }),
      )
      const okCount = rows.filter(r => r._ok).length
      const dbRows = rows.map(({ _ok: _, ...rest }) => rest)
      const { error: insErr } = await ctx.supabase.from('ticket_attachments').insert(dbRows)
      console.error(`[telegramFlow] EXIT media upload block in ${Date.now() - tStart}ms total: ${okCount}/${rows.length} stored to bucket${insErr ? ` (db insert error: ${insErr.message})` : ''}`)
    } catch (err) {
      console.error('[telegramFlow] media upload OUTER THREW — continuing without attachments:', err instanceof Error ? err.message : String(err))
    }
  } else {
    console.error(`[telegramFlow] no media on draft for ticket ${result.ticketNumber}`)
  }

  // Assignment waits until central support sets ready_for_assignment (see BUILD_TICKET_LIFECYCLE.md).

  if (draft.issue_text) {
    const enrich = await enrichTicketFromIssueText({
      ticketId: result.ticketId,
      organizationId: ctx.organizationId,
      issueText: draft.issue_text,
    })
    if (!enrich.ok) {
      console.warn(
        `[telegramFlow] AI classification skipped for ticket ${result.ticketId}: ${enrich.error}`,
      )
    }
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
      await sendTelegramMessage(ctx.msg.chat_id, BOT.statusNotFound(), { reply_markup: KB.postTicket() })
      return
    }
    await sendTelegramMessage(ctx.msg.chat_id, BOT.statusReply({
      ticketNumber: t.ticket_number,
      stage: citizenStageLabel(t.stage),
      lastUpdate: new Date(t.updated_at).toLocaleString('en-IN', {
        dateStyle: 'medium', timeStyle: 'short',
      }),
    }), { reply_markup: KB.postTicket() })
    return
  }

  // No ticket number — use most recent ticket for this citizen.
  const { data: recent } = await ctx.supabase
    .from('tickets')
    .select('ticket_number, stage, updated_at')
    .eq('organization_id', ctx.organizationId)
    .eq('citizen_id', ctx.citizenId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!recent) {
    await sendTelegramMessage(ctx.msg.chat_id, BOT.statusNoRecent(), { reply_markup: KB.mainMenu() })
    return
  }

  await sendTelegramMessage(ctx.msg.chat_id, BOT.statusReply({
    ticketNumber: recent.ticket_number,
    stage: citizenStageLabel(recent.stage),
    lastUpdate: new Date(recent.updated_at).toLocaleString('en-IN', {
      dateStyle: 'medium', timeStyle: 'short',
    }),
  }), { reply_markup: KB.postTicket() })
}

// ============================================================================
// State mutation helpers
// ============================================================================
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
