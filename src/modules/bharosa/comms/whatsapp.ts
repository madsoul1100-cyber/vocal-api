import { getTwilioClient, getWhatsAppFrom, toWhatsAppAddress } from '@/lib/twilio.js'

export type SendResult = { ok: true; provider: string; messageId: string } | { ok: false; provider: string; error: string }

/**
 * WhatsApp via Twilio. Business-initiated messages outside the 24h session
 * window must use an approved template: pass `contentSid` + `variables`
 * (Twilio Content API). Free text is used when no template is configured.
 */
export async function sendWhatsApp(args: {
  to: string
  body: string
  contentSid?: string | null
  variables?: Record<string, string>
}): Promise<SendResult> {
  const client = getTwilioClient()
  const from = getWhatsAppFrom()
  if (!client || !from) {
    if (process.env.NODE_ENV === 'development') {
      console.info(`[bharosa:whatsapp:console] to=${args.to}\n  ${args.body.replace(/\n/g, '\n  ')}`)
      return { ok: true, provider: 'console', messageId: `console-${Date.now()}` }
    }
    return { ok: false, provider: 'twilio-whatsapp', error: 'Twilio WhatsApp not configured' }
  }
  try {
    const msg = await client.messages.create(
      args.contentSid
        ? {
            from,
            to: toWhatsAppAddress(args.to),
            contentSid: args.contentSid,
            contentVariables: JSON.stringify(args.variables ?? {}),
          }
        : { from, to: toWhatsAppAddress(args.to), body: args.body },
    )
    return { ok: true, provider: 'twilio-whatsapp', messageId: msg.sid }
  } catch (err) {
    return { ok: false, provider: 'twilio-whatsapp', error: err instanceof Error ? err.message : 'WhatsApp send failed' }
  }
}
