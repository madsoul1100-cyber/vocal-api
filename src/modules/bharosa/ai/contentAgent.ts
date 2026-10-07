import { z } from 'zod'
import { dbQuery } from '@/lib/db.js'
import { tenantApp } from '@/config/tenant.config.js'
import { HttpError } from '../common.js'
import { GROUNDING_RULES, llmJson, recordFallbackRun } from './llm.js'

const PROMPT_VERSION = 'content.v1'

export type ContentFormat =
  | 'authority_email'
  | 'follow_up_email'
  | 'escalation_email'
  | 'letter'
  | 'whatsapp_message'
  | 'social_post'
  | 'citizen_update'

export const CONTENT_FORMATS: ContentFormat[] = [
  'authority_email', 'follow_up_email', 'escalation_email', 'letter', 'whatsapp_message', 'social_post', 'citizen_update',
]

const VersionSchema = z.object({ subject: z.string().nullable().optional(), body: z.string().min(1) })
const ContentSchema = z.object({
  versions: z.object({ en: VersionSchema, te: VersionSchema }),
  warnings: z.array(z.string()).default([]),
})
export type DraftContent = z.infer<typeof ContentSchema>

export interface CaseFacts {
  ticket_number: string
  title: string | null
  summary: string | null
  category: string | null
  issue_type: string | null
  severity: string | null
  location_text: string | null
  area: string | null
  incident_dates: string[]
  created_at: string
  evidence_count: number
  citizen_name: string | null
  citizen_name_consented: boolean
}

export async function loadCaseFacts(orgId: string, ticketId: string): Promise<CaseFacts> {
  const res = await dbQuery<CaseFacts & { facts: Record<string, unknown> | null }>(
    `SELECT t.ticket_number, t.title, COALESCE(t.normalized_summary, t.original_issue_text) AS summary,
            c.name AS category, t.structured_facts_json->>'issue_type' AS issue_type, t.severity,
            t.location_text, tr.name AS area, t.created_at,
            (SELECT COUNT(*)::int FROM ticket_attachments a WHERE a.ticket_id = t.id) AS evidence_count,
            ci.display_name AS citizen_name, t.structured_facts_json AS facts,
            COALESCE((SELECT cc.granted FROM citizen_consents cc
                      WHERE cc.ticket_id = t.id AND cc.consent_type = 'share_with_authority'
                      ORDER BY cc.created_at DESC LIMIT 1), false) AS citizen_name_consented
     FROM tickets t
     LEFT JOIN issue_categories c ON c.id = t.category_id
     LEFT JOIN territories tr ON tr.id = t.territory_id
     LEFT JOIN citizens ci ON ci.id = t.citizen_id
     WHERE t.id = $1 AND t.organization_id = $2`,
    [ticketId, orgId],
  )
  const row = res.rows[0]
  if (!row) throw new HttpError(404, 'Case not found')
  const dates = Array.isArray(row.facts?.incident_dates) ? (row.facts?.incident_dates as string[]) : []
  return { ...row, incident_dates: dates }
}

function formatInstructions(format: ContentFormat, ctx: { recipientLine: string; priorThread: string | null; followUpNumber: number }): string {
  switch (format) {
    case 'authority_email':
      return `Write a formal grievance email to the responsible public authority (${ctx.recipientLine}).
Subject: "<Issue> at <Area> – Ref <ticket_number>". Body: salutation, 1 paragraph stating the issue and location, 1 paragraph of facts (since when, impact, evidence available on request), numbered specific requests (inspect / act / respond), polite close asking for a reply to this email. 150-250 words. No threats, no political language.`
    case 'follow_up_email':
      return `Write follow-up #${ctx.followUpNumber} on an earlier grievance email that has not received a reply (${ctx.recipientLine}).
Reference the original subject and reference number, restate the issue in 2 sentences, politely ask for an update or acknowledgement. 80-150 words. Firmer than the original but courteous.
Earlier thread (for reference only):\n${ctx.priorThread ?? '(none)'}`
    case 'escalation_email':
      return `Write an escalation email to a senior officer (${ctx.recipientLine}) because the concerned office has not responded or acted.
State the issue, the original reference number, that earlier emails went unanswered (only if the thread shows that), and request intervention. 120-200 words. Formal and factual.
Earlier thread (for reference only):\n${ctx.priorThread ?? '(none)'}`
    case 'letter':
      return `Write a formal printed letter to the authority (${ctx.recipientLine}) with: [Date], To-address block using the designation, Subject line, Respected Sir/Madam, body paragraphs with facts and numbered requests, and a closing with [Name] [Contact] placeholders.`
    case 'whatsapp_message':
      return `Write a short WhatsApp message (max 600 characters) to an official (${ctx.recipientLine}) about the grievance with the reference number and one clear ask. Plain text, no markdown.`
    case 'social_post':
      return `Write a short public social media post (max 280 characters for English) raising visibility on the issue, factual and non-defamatory, with the area name and 2 hashtags. Do not include any personal data of the citizen. Must be approved by a communications approver before posting.`
    case 'citizen_update':
      return `Write a short, plain-language update to the citizen (max 400 characters) about their case. Never promise outcomes or dates that are not in the facts.`
  }
}

function fallbackDraft(format: ContentFormat, f: CaseFacts, followUpNumber: number): DraftContent {
  const area = f.area ?? f.location_text ?? ''
  const subj = `${f.title ?? 'Civic grievance'}${area ? ` at ${area}` : ''} – Ref ${f.ticket_number}`
  const enBody =
    format === 'follow_up_email'
      ? `Respected Sir/Madam,\n\nThis is follow-up ${followUpNumber} regarding grievance ${f.ticket_number}: ${f.summary ?? ''}\n\nWe request an update on the action taken.\n\nRegards,\n${tenantApp.name}`
      : `Respected Sir/Madam,\n\n${f.summary ?? ''}\n\nLocation: ${f.location_text ?? area}\nReference: ${f.ticket_number}\n\nWe request you to kindly inspect and take necessary action, and reply to this email with the status.\n\nRegards,\n${tenantApp.name}`
  const teBody = `గౌరవనీయులైన అధికారి గారికి,\n\n${f.summary ?? ''}\n\nస్థలం: ${f.location_text ?? area}\nసూచన సంఖ్య: ${f.ticket_number}\n\nదయచేసి పరిశీలించి తగిన చర్య తీసుకుని, స్థితిని ఈ ఇమెయిల్‌కు ప్రత్యుత్తరంగా తెలియజేయగలరు.\n\nధన్యవాదాలు,\n${tenantApp.name}`
  return {
    versions: { en: { subject: subj, body: enBody }, te: { subject: `${f.ticket_number} – ఫిర్యాదు`, body: teBody } },
    warnings: ['AI unavailable — template draft. Review carefully before sending.'],
  }
}

export async function runContentAgent(args: {
  orgId: string
  ticketId: string
  format: ContentFormat
  recipients: Array<{ name?: string | null; designation?: string | null; office?: string | null }>
  priorThread?: string | null
  followUpNumber?: number
  instructions?: string | null
}): Promise<{ content: DraftContent; runId: string | null; fallback: boolean }> {
  const facts = await loadCaseFacts(args.orgId, args.ticketId)
  const recipientLine =
    args.recipients
      .map((r) => [r.designation, r.office].filter(Boolean).join(', ') || r.name)
      .filter(Boolean)
      .join('; ') || 'the concerned officer'
  const followUpNumber = args.followUpNumber ?? 1

  const safeFacts = {
    reference_number: facts.ticket_number,
    title: facts.title,
    summary: facts.summary,
    category: facts.category,
    issue_type: facts.issue_type,
    severity: facts.severity,
    location: facts.location_text,
    area: facts.area,
    incident_dates: facts.incident_dates,
    reported_on: facts.created_at,
    evidence_items_available: facts.evidence_count,
    complainant: facts.citizen_name_consented && facts.citizen_name ? facts.citizen_name : 'a verified citizen (identity withheld)',
    sent_via: tenantApp.name,
  }

  const result = await llmJson({
    agent: 'content',
    promptVersion: PROMPT_VERSION,
    orgId: args.orgId,
    ticketId: args.ticketId,
    inputRefs: { format: args.format, recipients: recipientLine, follow_up_number: followUpNumber },
    system: `You draft communications for a citizen-grievance platform in Telangana, India. Every draft is reviewed and approved by a person before sending.
${formatInstructions(args.format, { recipientLine, priorThread: args.priorThread ?? null, followUpNumber })}

Produce two versions with the same meaning: "en" (English) and "te" (Telugu script). Subjects may be null for formats without subjects.
Add a "warnings" entry if facts are too thin to make a specific request, or if anything looks sensitive.

${GROUNDING_RULES}

Return {"versions":{"en":{"subject":"","body":""},"te":{"subject":"","body":""}},"warnings":[]}`,
    user: `Approved case facts (the only facts you may use):\n${JSON.stringify(safeFacts, null, 2)}${
      args.instructions ? `\n\nReviewer instructions: ${args.instructions.slice(0, 500)}` : ''
    }`,
    schema: ContentSchema,
    temperature: 0.3,
    maxTokens: 2500,
  })

  if (result.ok) return { content: result.data, runId: result.runId, fallback: false }
  const content = fallbackDraft(args.format, facts, followUpNumber)
  const runId = result.runId ?? (await recordFallbackRun({ orgId: args.orgId, ticketId: args.ticketId }, 'content', PROMPT_VERSION, content, result.error))
  return { content, runId, fallback: true }
}
