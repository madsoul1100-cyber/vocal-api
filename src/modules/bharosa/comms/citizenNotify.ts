import { dbQuery } from '@/lib/db.js'
import { tenantApp } from '@/config/tenant.config.js'
import { sendExotelSms } from '@/lib/otp/providers/exotelSmsProvider.js'
import { getBharosaSettings } from '../settings.js'
import { CITIZEN_STATUS_LABELS, citizenSummaryForEvent, projectCitizenStatus, type CaseEventRow } from '../cases/events.js'
import { sendWhatsApp } from './whatsapp.js'

/** Events the citizen triggered themselves don't need a notification back. */
const SKIP_EVENT_TYPES = new Set(['citizen_responded', 'feedback_received'])

function caseLink(ticketId: string): string | null {
  const base = (process.env.PUBLIC_APP_URL || process.env.CITIZEN_APP_URL || '').replace(/\/$/, '')
  return base ? `${base}/cases/${ticketId}` : null
}

function waTemplateSid(lang: 'en' | 'te'): string | null {
  const v = lang === 'te' ? process.env.BHAROSA_WA_UPDATE_TEMPLATE_SID_TE : process.env.BHAROSA_WA_UPDATE_TEMPLATE_SID_EN
  return v?.trim() || process.env.BHAROSA_WA_UPDATE_TEMPLATE_SID?.trim() || null
}

/**
 * Job handler: push a citizen-visible case event to the citizen over WhatsApp
 * (in their language), with optional DLT SMS fallback. Respects opt-in.
 */
export async function notifyCitizen(caseEventId: string): Promise<{ sent: boolean; reason?: string; provider?: string }> {
  const res = await dbQuery<CaseEventRow & {
    organization_id: string; ticket_id: string; ticket_number: string; stage: string; sub_status: string; outcome: string | null
    verification_status: string | null; citizen_id: string | null; phone: string | null; whatsapp_opt_in: boolean | null
    preferred_language: string | null; ticket_language: string | null; blocked_at: string | null
  }>(
    `SELECT e.id, e.event_type, e.actor_type, e.actor_label, NULL::text AS actor_name, e.visibility, e.summary, e.language,
            e.reason, e.data_json, e.task_id, e.communication_id, e.created_at,
            e.organization_id, e.ticket_id, t.ticket_number, t.stage, t.sub_status, t.outcome, t.verification_status,
            c.id AS citizen_id, c.phone_e164 AS phone, c.whatsapp_opt_in, c.preferred_language, t.language AS ticket_language, c.blocked_at
     FROM case_events e
     JOIN tickets t ON t.id = e.ticket_id
     LEFT JOIN citizens c ON c.id = t.citizen_id
     WHERE e.id = $1`,
    [caseEventId],
  )
  const e = res.rows[0]
  if (!e) return { sent: false, reason: 'event_not_found' }
  if (e.visibility === 'internal' || SKIP_EVENT_TYPES.has(e.event_type) || e.actor_type === 'citizen') return { sent: false, reason: 'not_notifiable' }
  if (!e.citizen_id || !e.phone || e.blocked_at) return { sent: false, reason: 'no_reachable_citizen' }
  if (e.event_type === 'status_changed') {
    // Status changes usually accompany a more specific event (verified, email sent…); send only that one.
    const sibling = await dbQuery(
      `SELECT 1 FROM case_events WHERE ticket_id = $1 AND id <> $2 AND visibility <> 'internal' AND event_type <> 'status_changed'
         AND created_at BETWEEN $3::timestamptz - interval '15 seconds' AND $3::timestamptz + interval '15 seconds' LIMIT 1`,
      [e.ticket_id, e.id, e.created_at],
    )
    if (sibling.rowCount) return { sent: false, reason: 'covered_by_specific_event' }
  }

  const settings = await getBharosaSettings(e.organization_id)
  const lang: 'en' | 'te' = (e.preferred_language ?? e.ticket_language) === 'en' ? 'en' : 'te'
  const text = citizenSummaryForEvent(e, lang)
  if (!text) return { sent: false, reason: 'no_citizen_text' }

  const status = CITIZEN_STATUS_LABELS[projectCitizenStatus(e)][lang]
  const link = caseLink(e.ticket_id)
  const header = lang === 'te' ? `${tenantApp.name} – ఫిర్యాదు ${e.ticket_number}` : `${tenantApp.name} – Complaint ${e.ticket_number}`
  const statusLine = lang === 'te' ? `స్థితి: ${status}` : `Status: ${status}`
  const linkLine = link ? (lang === 'te' ? `వివరాలు: ${link}` : `Details: ${link}`) : ''
  const body = [header, text, statusLine, linkLine].filter(Boolean).join('\n')

  let provider: string | null = null
  let messageId: string | null = null
  let error: string | null = null

  const waConsent = await dbQuery<{ granted: boolean }>(
    `SELECT granted FROM citizen_consents WHERE citizen_id = $1 AND consent_type = 'whatsapp_updates' ORDER BY created_at DESC LIMIT 1`,
    [e.citizen_id],
  )
  const waAllowed = settings.notifications.whatsappEnabled && (waConsent.rows[0]?.granted ?? e.whatsapp_opt_in ?? false)

  if (waAllowed) {
    const sid = waTemplateSid(lang)
    const r = await sendWhatsApp({
      to: e.phone,
      body,
      contentSid: sid,
      variables: sid ? { '1': e.ticket_number, '2': text.slice(0, 900), '3': status, '4': link ?? '' } : undefined,
    })
    if (r.ok) {
      provider = r.provider
      messageId = r.messageId
    } else {
      error = r.error
    }
  }

  if (!provider && settings.notifications.smsFallback) {
    const templateId = process.env.EXOTEL_DLT_UPDATE_TEMPLATE_ID?.trim()
    const template = process.env.EXOTEL_UPDATE_TEMPLATE?.trim()
    if (templateId && template) {
      const smsBody = template
        .replaceAll('{ref}', e.ticket_number)
        .replaceAll('{status}', CITIZEN_STATUS_LABELS[projectCitizenStatus(e)].en)
        .replaceAll('{link}', link ?? '')
        .replaceAll('{app}', tenantApp.name)
      const r = await sendExotelSms({ to: e.phone, body: smsBody, dltTemplateId: templateId })
      if (r.ok) {
        provider = 'exotel-sms'
        messageId = r.sid
      } else {
        error = r.error
      }
    }
  }

  if (!provider) {
    if (!waAllowed && !settings.notifications.smsFallback) return { sent: false, reason: 'no_opt_in' }
    if (error) throw new Error(error)
    return { sent: false, reason: 'no_channel_configured' }
  }

  await dbQuery(
    `INSERT INTO communications (organization_id, ticket_id, channel, direction, purpose, status, approval_by, language, body,
                                 recipients_json, provider, provider_message_id, sent_at, summary_json)
     VALUES ($1,$2,$3,'outbound','citizen_update','sent','none',$4,$5,$6,$7,$8, now(), $9)`,
    [
      e.organization_id, e.ticket_id, provider === 'exotel-sms' ? 'sms' : 'whatsapp', lang, body,
      JSON.stringify([{ name: null, phone: e.phone, kind: 'to' }]), provider, messageId,
      JSON.stringify({ case_event_id: e.id, event_type: e.event_type }),
    ],
  )
  return { sent: true, provider }
}
