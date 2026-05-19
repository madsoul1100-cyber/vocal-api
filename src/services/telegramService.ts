/**
 * Telegram low-level helpers.
 *
 * - Sends messages via Telegram Bot API.
 * - Holds the canned message templates the bot uses. The bot is a GUIDED
 *   INTAKE assistant only — it must never give advice, answer general
 *   questions, or discuss anything outside the intake flow. All user-facing
 *   copy lives here so it's reviewable in one place.
 *
 * Message parse mode is Markdown V1 ("Markdown"): * = bold, _ = italic,
 * ` = code. Keep templates simple.
 */

import { tenantApp } from '@/config/tenant.config.js'

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? ''

// ----------------------------------------------------------------------------
// Inline-keyboard types (Telegram Bot API shape).
// ----------------------------------------------------------------------------
export interface InlineKeyboardButton {
  text: string
  callback_data: string
}
export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][]
}

export async function sendTelegramMessage(
  chatId: number | string,
  text: string,
  opts: { markdown?: boolean; reply_markup?: InlineKeyboardMarkup } = {},
): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN) return
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: opts.markdown === false ? undefined : 'Markdown',
        disable_web_page_preview: true,
        reply_markup: opts.reply_markup,
      }),
    })
  } catch {
    // Never throw from send — webhook must always return 200.
  }
}

/**
 * Acknowledge a callback_query so Telegram stops the loading spinner on the
 * button. Best-effort; never throws.
 */
export async function answerCallbackQuery(
  callbackQueryId: string,
  text?: string,
): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN) return
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
    })
  } catch {
    // swallow
  }
}

/**
 * Strip the inline keyboard off a previously-sent message so the user can't
 * tap it again once they've made their choice. Best-effort; never throws.
 */
export async function clearInlineKeyboard(
  chatId: number | string,
  messageId: number,
): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN) return
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageReplyMarkup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
    })
  } catch {
    // swallow
  }
}

// ============================================================================
// Canned messages. Keep each one tight; the bot's voice is calm + helpful.
// No hype, no advice. Square brackets = slot-fills.
// ============================================================================

export const BOT = {
  welcome: () =>
`👋 *Hi, I'm the ${tenantApp.name} assistant.*
I help you report civic issues to your local organization.

*Tap a button below to get started.*
You can send /cancel at any time to stop.`,

  help: () =>
`*About ${tenantApp.name}*
${tenantApp.name} collects civic issues from citizens and routes them to people who can help.

I can help you with just two things:
1. Filing a new issue — I'll ask a few quick questions.
2. Checking the status of a ticket you've already filed.

I won't give advice or discuss other topics — our team does that once your ticket is filed.

Tap *Report an issue* below to start.`,

  unclear: () =>
`Sorry, I didn't follow. Please pick one of the options below.`,

  startIssue: () =>
`Got it. Please *describe the issue* in your own words — what happened, where, and when if you know.

You can also send a voice note instead of typing.`,

  askMedia: () =>
`Thanks. If you have *photos or videos* that show the issue, send them now (one by one is fine).

When you're done, tap *Done*. If you have no media, tap *Skip media*.`,

  mediaAdded: (count: number) =>
`Got it — ${count} attachment${count === 1 ? '' : 's'} so far. Send more, or tap *Done* when finished.`,

  askLocation: () =>
`Last step — *where is this happening?*

Easiest: tap the 📎 attachment button and share your *Location* pin.
Or just type the address, landmark, or area in a message.`,

  locationNeedsText: () =>
`I need something for the location. Please *share a location pin* or type the address in a message.`,

  confirm: (args: { issue: string; mediaCount: number; location: string }) =>
`*Please confirm*

📝 *Issue*
${args.issue}

📎 *Attachments:* ${args.mediaCount}
📍 *Location:* ${args.location}

Tap *Confirm & file* to submit, *Edit something* to make changes, or *Cancel* to stop.`,

  editMenu: () =>
`What would you like to change? Tap one of the options below.`,

  cancelled: () =>
`Got it — cancelled. Tap *Report an issue* whenever you're ready to start again.`,

  filed: (ticketNumber: string) =>
`✅ *Filed as \`${ticketNumber}\`*

Our team will review this and someone from the organization will reach out to you. Thanks for reporting.

Tap *Check status* below anytime to see progress, or *Report another* to file a new issue.`,

  failed: () =>
`Something went wrong while filing this. Please tap *Confirm & file* to retry, or /cancel to stop.`,

  statusNotFound: () =>
`I couldn't find that ticket. Please check the number (e.g. \`VOC-DEMO-0001\`) and try again, or tap *Check status* below to see your most recent ticket.`,

  statusNoRecent: () =>
`You don't have a ticket on record yet. Tap *Report an issue* below to file one.`,

  statusReply: (args: {
    ticketNumber: string
    stage: string
    lastUpdate: string
    latestNote?: string | null
  }) =>
`📋 *\`${args.ticketNumber}\`*
Stage: ${args.stage}
Last update: ${args.lastUpdate}${args.latestNote ? `\n\nLatest note:\n${args.latestNote}` : ''}`,

  postTicketIdle: () =>
`Tap *Report another* to file a new issue, or *Check status* to see an existing one.`,
} as const

// ============================================================================
// Inline keyboards for each prompt.
//
// Callback-data scheme: "<group>:<value>" — kept short (Telegram cap is 64 B).
// The webhook route translates these back to synthetic text commands so the
// existing state machine in telegramFlow.ts works unchanged. Text-command
// fallback ("report", "done", "confirm", "1"/"2"/"3", …) still works for
// users on clients that can't render inline keyboards.
// ============================================================================
export const CB = {
  // main menu
  MENU_REPORT: 'menu:report',
  MENU_STATUS: 'menu:status',
  MENU_HELP:   'menu:help',
  // intake: media step
  MEDIA_DONE:  'media:done',
  MEDIA_SKIP:  'media:skip',
  // intake: confirm step
  CONFIRM_YES:    'confirm:yes',
  CONFIRM_EDIT:   'confirm:edit',
  CONFIRM_CANCEL: 'confirm:cancel',
  // intake: edit menu
  EDIT_ISSUE:    'edit:issue',
  EDIT_MEDIA:    'edit:media',
  EDIT_LOCATION: 'edit:location',
  EDIT_CONFIRM:  'edit:confirm',
  // global
  CANCEL: 'global:cancel',
} as const

export const KB = {
  mainMenu: (): InlineKeyboardMarkup => ({
    inline_keyboard: [
      [{ text: '📝 Report an issue', callback_data: CB.MENU_REPORT }],
      [{ text: '📋 Check ticket status', callback_data: CB.MENU_STATUS }],
      [{ text: 'ℹ️ Help', callback_data: CB.MENU_HELP }],
    ],
  }),
  collectingIssue: (): InlineKeyboardMarkup => ({
    inline_keyboard: [
      [{ text: '✖️ Cancel', callback_data: CB.CANCEL }],
    ],
  }),
  askMedia: (): InlineKeyboardMarkup => ({
    inline_keyboard: [
      [
        { text: '✅ Done',      callback_data: CB.MEDIA_DONE },
        { text: '⏭ Skip media', callback_data: CB.MEDIA_SKIP },
      ],
      [{ text: '✖️ Cancel', callback_data: CB.CANCEL }],
    ],
  }),
  mediaAdded: (): InlineKeyboardMarkup => ({
    inline_keyboard: [
      [
        { text: '✅ Done',  callback_data: CB.MEDIA_DONE },
        { text: '⏭ Skip',   callback_data: CB.MEDIA_SKIP },
      ],
    ],
  }),
  askLocation: (): InlineKeyboardMarkup => ({
    inline_keyboard: [
      [{ text: '✖️ Cancel', callback_data: CB.CANCEL }],
    ],
  }),
  confirm: (): InlineKeyboardMarkup => ({
    inline_keyboard: [
      [{ text: '✅ Confirm & file',   callback_data: CB.CONFIRM_YES }],
      [{ text: '✏️ Edit something',  callback_data: CB.CONFIRM_EDIT }],
      [{ text: '✖️ Cancel',           callback_data: CB.CONFIRM_CANCEL }],
    ],
  }),
  editMenu: (): InlineKeyboardMarkup => ({
    inline_keyboard: [
      [{ text: '📝 Issue description', callback_data: CB.EDIT_ISSUE }],
      [{ text: '📎 Attachments',       callback_data: CB.EDIT_MEDIA }],
      [{ text: '📍 Location',          callback_data: CB.EDIT_LOCATION }],
      [{ text: '✅ File as-is',         callback_data: CB.EDIT_CONFIRM }],
    ],
  }),
  postTicket: (): InlineKeyboardMarkup => ({
    inline_keyboard: [
      [{ text: '📝 Report another', callback_data: CB.MENU_REPORT }],
      [{ text: '📋 Check status',   callback_data: CB.MENU_STATUS }],
    ],
  }),
} as const

/**
 * Translate an inline-keyboard callback_data value back to the synthetic
 * text command the state machine already understands. Returning `null`
 * means "unknown — ignore."
 */
export function callbackToSyntheticText(data: string): string | null {
  switch (data) {
    case CB.MENU_REPORT:     return 'report'
    case CB.MENU_STATUS:     return 'status'
    case CB.MENU_HELP:       return 'help'
    case CB.MEDIA_DONE:      return 'done'
    case CB.MEDIA_SKIP:      return 'skip'
    case CB.CONFIRM_YES:     return 'confirm'
    case CB.CONFIRM_EDIT:    return 'edit'
    case CB.CONFIRM_CANCEL:  return '/cancel'
    case CB.EDIT_ISSUE:      return '1'
    case CB.EDIT_MEDIA:      return '2'
    case CB.EDIT_LOCATION:   return '3'
    case CB.EDIT_CONFIRM:    return 'confirm'
    case CB.CANCEL:          return '/cancel'
    default:                 return null
  }
}

// ============================================================================
// Stage label — citizen-friendly wording.
// ============================================================================
const STAGE_LABELS: Record<string, string> = {
  to_do:       'Registered — awaiting review',
  in_progress: 'In progress',
  on_hold:     'On hold',
  closed:      'Closed',
}
export function citizenStageLabel(stage: string): string {
  return STAGE_LABELS[stage] ?? stage
}

// ============================================================================
// Simple command / yes-no detection (locale-aware but small).
// Everything is case-insensitive and trimmed.
// ============================================================================
export function normalize(text: string | null | undefined): string {
  return (text ?? '').trim().toLowerCase()
}

export function isCommand(text: string, cmd: string): boolean {
  const t = normalize(text)
  return t === cmd || t.startsWith(cmd + ' ') || t.startsWith(cmd + '@')
}

const YES_WORDS     = new Set(['yes', 'y', 'confirm', 'ok', 'okay', 'ha', 'haan', 'sahi', 'done', 'submit', 'file'])
const NO_WORDS      = new Set(['no', 'n', 'nope', 'cancel', 'stop'])
const SKIP_WORDS    = new Set(['skip', 'none', 'no media', 'nothing', 'pass'])
const DONE_WORDS    = new Set(['done', 'finished', 'that\'s all', 'thats all', 'no more'])
const EDIT_WORDS    = new Set(['edit', 'change', 'fix', 'update'])
const REPORT_WORDS  = new Set(['report', 'file', 'new', 'issue', 'complaint', 'problem'])
const STATUS_WORDS  = new Set(['status', 'track', 'check'])
const HELP_WORDS    = new Set(['help', 'info', '?'])

export const words = {
  isYes:    (t: string) => YES_WORDS.has(normalize(t)),
  isNo:     (t: string) => NO_WORDS.has(normalize(t)),
  isSkip:   (t: string) => SKIP_WORDS.has(normalize(t)),
  isDone:   (t: string) => DONE_WORDS.has(normalize(t)),
  isEdit:   (t: string) => EDIT_WORDS.has(normalize(t)),
  isReport: (t: string) => REPORT_WORDS.has(normalize(t)),
  isStatus: (t: string) => STATUS_WORDS.has(normalize(t)),
  isHelp:   (t: string) => HELP_WORDS.has(normalize(t)),
}

// Extract a ticket number from a string like "status VOC-DEMO-0001" or "VOC-DEMO-0001"
export function extractTicketNumber(text: string): string | null {
  const m = text.toUpperCase().match(/\b([A-Z]{2,}[-_][A-Z0-9]+[-_]\d{2,})\b/)
  return m ? m[1].replace(/_/g, '-') : null
}
