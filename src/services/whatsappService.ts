/**
 * WhatsApp (Twilio) low-level helpers — send + canned copy.
 * Plain text only (no Telegram Markdown). Menus use numbered replies.
 */

import { getTwilioClient, getWhatsAppFrom, toWhatsAppAddress } from '@/lib/twilio.js'
import { tenantApp } from '@/config/tenant.config.js'

export const MENU_HINT = `
Reply with a number:
1 — Report an issue
2 — Check ticket status
3 — Help
(or type: report / status / cancel)`

export async function sendWhatsAppMessage(
  channelUserId: string,
  text: string,
): Promise<void> {
  const client = getTwilioClient()
  const from = getWhatsAppFrom()
  if (!client || !from) return
  try {
    await client.messages.create({
      from,
      to: toWhatsAppAddress(channelUserId),
      body: text,
    })
  } catch (err) {
    console.error('[whatsappService] send failed:', err instanceof Error ? err.message : String(err))
  }
}

export const BOT = {
  welcome: () =>
`Hi, I'm the ${tenantApp.name} assistant on WhatsApp.
I help you report civic issues to your local organization.

${MENU_HINT}

Type *cancel* anytime to stop.`,

  help: () =>
`About ${tenantApp.name}
We collect civic issues from citizens and route them to people who can help.

I can help with:
1. Filing a new issue (reply 1 or "report")
2. Checking ticket status (reply 2 or "status")

${MENU_HINT}`,

  unclear: () =>
`Sorry, I didn't follow. ${MENU_HINT}`,

  startIssue: () =>
`Please describe the issue in your own words — what happened, where, and when if you know.

You can also send a photo or voice note.
Reply *cancel* to stop.`,

  askMedia: () =>
`If you have photos or videos, send them now (one at a time).

When done, reply *done* or *skip*.
Reply *cancel* to stop.`,

  mediaAdded: (count: number) =>
`Got ${count} attachment${count === 1 ? '' : 's'}. Send more, or reply *done* when finished.`,

  askLocation: () =>
`Where is this happening?

Type the address, landmark, or area name.
Reply *skip* if you prefer not to share.`,

  locationNeedsText: () =>
`Please type the location (address or landmark), or reply *skip*.`,

  confirm: (args: { issue: string; mediaCount: number; location: string }) =>
`Please confirm:

Issue:
${args.issue}

Attachments: ${args.mediaCount}
Location: ${args.location}

Reply *yes* to submit, *edit* to change, or *cancel* to stop.`,

  editMenu: () =>
`What to change? Reply:
1 — Issue description
2 — Attachments
3 — Location
Or reply *yes* to file as-is.`,

  cancelled: () =>
`Cancelled. Reply 1 or *report* when you want to file a new issue.`,

  filed: (ticketNumber: string) =>
`Filed as ${ticketNumber}.

Our team will review this. Reply 2 or *status* to check progress, or 1 / *report* for another issue.`,

  failed: () =>
`Something went wrong while filing. Reply *yes* to retry or *cancel* to stop.`,

  statusNotFound: () =>
`Couldn't find that ticket. Check the number (e.g. VOC-DEMO-0001) and try again.`,

  statusNoRecent: () =>
`No ticket on record yet. Reply 1 or *report* to file one.`,

  statusReply: (args: {
    ticketNumber: string
    stage: string
    lastUpdate: string
    latestNote?: string | null
  }) =>
`Ticket ${args.ticketNumber}
Stage: ${args.stage}
Last update: ${args.lastUpdate}${args.latestNote ? `\n\nLatest note:\n${args.latestNote}` : ''}`,

  postTicketIdle: () =>
`Reply 1 / *report* for a new issue, or 2 / *status* to check an existing one.`,
} as const

const STAGE_LABELS: Record<string, string> = {
  to_do: 'Registered — awaiting review',
  in_progress: 'In progress',
  on_hold: 'On hold',
  closed: 'Closed',
}

export function citizenStageLabel(stage: string): string {
  return STAGE_LABELS[stage] ?? stage
}

export function normalize(text: string | null | undefined): string {
  return (text ?? '').trim().toLowerCase()
}

export function isCommand(text: string, cmd: string): boolean {
  const t = normalize(text)
  const bare = cmd.startsWith('/') ? cmd.slice(1) : cmd
  return t === cmd || t === bare || t.startsWith(cmd + ' ') || t.startsWith(bare + ' ')
}

const YES_WORDS = new Set(['yes', 'y', 'confirm', 'ok', 'okay', 'ha', 'haan', 'sahi', 'done', 'submit', 'file'])
const NO_WORDS = new Set(['no', 'n', 'nope', 'cancel', 'stop'])
const SKIP_WORDS = new Set(['skip', 'none', 'no media', 'nothing', 'pass'])
const DONE_WORDS = new Set(['done', 'finished', "that's all", 'thats all', 'no more'])
const EDIT_WORDS = new Set(['edit', 'change', 'fix', 'update'])
const REPORT_WORDS = new Set(['report', 'file', 'new', 'issue', 'complaint', 'problem', '1'])
const STATUS_WORDS = new Set(['status', 'track', 'check', '2'])
const HELP_WORDS = new Set(['help', 'info', '?', '3'])
const START_WORDS = new Set(['start', 'hi', 'hello', 'hey'])

export const words = {
  isYes: (t: string) => YES_WORDS.has(normalize(t)),
  isNo: (t: string) => NO_WORDS.has(normalize(t)),
  isSkip: (t: string) => SKIP_WORDS.has(normalize(t)),
  isDone: (t: string) => DONE_WORDS.has(normalize(t)),
  isEdit: (t: string) => EDIT_WORDS.has(normalize(t)),
  isReport: (t: string) => REPORT_WORDS.has(normalize(t)),
  isStatus: (t: string) => STATUS_WORDS.has(normalize(t)),
  isHelp: (t: string) => HELP_WORDS.has(normalize(t)),
  isStart: (t: string) => START_WORDS.has(normalize(t)),
}

export function extractTicketNumber(text: string): string | null {
  const m = text.toUpperCase().match(/\b([A-Z]{2,}[-_][A-Z0-9]+[-_]\d{2,})\b/)
  return m ? m[1].replace(/_/g, '-') : null
}

/** Map menu digit before state handlers. */
export function menuDigitToAction(text: string): 'report' | 'status' | 'help' | null {
  const t = normalize(text)
  if (t === '1') return 'report'
  if (t === '2') return 'status'
  if (t === '3') return 'help'
  return null
}
