/**
 * Worker Telegram Service
 *
 * Thin wrapper around Telegram Bot API using the *worker bot* token
 * (WORKER_BOT_TOKEN). This is intentionally separate from telegramService.ts
 * (which uses the citizen bot) so the two flows never cross.
 *
 * All functions are fire-and-forget safe — they never throw.
 */

const WORKER_BOT_TOKEN = process.env.WORKER_BOT_TOKEN ?? ''
const WORKER_WEBHOOK_SECRET = process.env.WORKER_WEBHOOK_SECRET ?? ''

export { WORKER_WEBHOOK_SECRET }

export interface InlineKeyboardButton {
  text: string
  callback_data: string
}
export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][]
}

export async function sendWorkerMessage(
  chatId: number | string,
  text: string,
  opts: { reply_markup?: InlineKeyboardMarkup } = {},
): Promise<void> {
  if (!WORKER_BOT_TOKEN) return
  try {
    await fetch(`https://api.telegram.org/bot${WORKER_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        reply_markup: opts.reply_markup,
      }),
    })
  } catch { /* never throw */ }
}

export async function answerWorkerCallbackQuery(
  callbackQueryId: string,
  text?: string,
): Promise<void> {
  if (!WORKER_BOT_TOKEN) return
  try {
    await fetch(`https://api.telegram.org/bot${WORKER_BOT_TOKEN}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
    })
  } catch { /* swallow */ }
}

export async function clearWorkerInlineKeyboard(
  chatId: number | string,
  messageId: number,
): Promise<void> {
  if (!WORKER_BOT_TOKEN) return
  try {
    await fetch(`https://api.telegram.org/bot${WORKER_BOT_TOKEN}/editMessageReplyMarkup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
    })
  } catch { /* swallow */ }
}
