import { z } from 'zod'
import { dbQuery } from '@/lib/db.js'
import { GROUNDING_RULES, llmJson } from './llm.js'
import { recordCaseEvent } from '../cases/events.js'
import { createEscalation } from '../cases/escalations.js'
import { createTask } from '../cases/tasks.js'

const PROMPT_VERSION = 'response_summary.v1'

export const ReplySummarySchema = z.object({
  classification: z.enum(['acknowledged', 'action_promised', 'action_taken', 'needs_information', 'redirected', 'rejected', 'auto_reply', 'unclear']),
  internal_summary: z.string(),
  citizen_summary: z.object({ en: z.string(), te: z.string() }),
  commitments: z.array(z.object({ what: z.string(), by_date: z.string().nullable().optional() })).default([]),
  information_requested: z.array(z.string()).default([]),
  redirected_to: z.string().nullable().optional(),
  suggested_next_step: z.string(),
  confidence: z.number().min(0).max(1).default(0.5),
})
export type ReplySummary = z.infer<typeof ReplySummarySchema>

/** Job handler: summarise an inbound authority reply and route the next step to humans. */
export async function summarizeInboundReply(communicationId: string) {
  const res = await dbQuery<{
    id: string; organization_id: string; ticket_id: string | null; task_id: string | null; body: string | null; subject: string | null
    from_address: string | null; in_reply_to_id: string | null; orig_subject: string | null; orig_body: string | null; ticket_language: string | null
  }>(
    `SELECT c.id, c.organization_id, c.ticket_id, c.task_id, c.body, c.subject, c.from_address, c.in_reply_to_id,
            o.subject AS orig_subject, o.body AS orig_body, t.language AS ticket_language
     FROM communications c
     LEFT JOIN communications o ON o.id = c.in_reply_to_id
     LEFT JOIN tickets t ON t.id = c.ticket_id
     WHERE c.id = $1`,
    [communicationId],
  )
  const reply = res.rows[0]
  if (!reply || !reply.ticket_id) return { skipped: true }

  const result = await llmJson({
    agent: 'response_summary',
    promptVersion: PROMPT_VERSION,
    orgId: reply.organization_id,
    ticketId: reply.ticket_id,
    inputRefs: { communication_id: reply.id },
    system: `You read a reply from a government office to a citizen grievance email and summarise it for (a) the internal team and (b) the citizen.
Classify: acknowledged (received only), action_promised (they will act), action_taken (they say it is done), needs_information (they ask for something), redirected (another office is responsible), rejected (they refuse / not their issue), auto_reply (out-of-office or automated), unclear.
Extract commitments with dates exactly as stated. citizen_summary must be plain, neutral, 1-2 sentences in English ("en") and Telugu ("te"); never overstate what the office promised.
${GROUNDING_RULES}
Return {"classification":"","internal_summary":"","citizen_summary":{"en":"","te":""},"commitments":[{"what":"","by_date":null}],"information_requested":[],"redirected_to":null,"suggested_next_step":"","confidence":0.0}`,
    user: JSON.stringify({
      our_email: { subject: reply.orig_subject, body: reply.orig_body?.slice(0, 4000) },
      their_reply: { from: reply.from_address, subject: reply.subject, body: reply.body?.slice(0, 12_000) },
    }),
    schema: ReplySummarySchema,
    temperature: 0,
  })

  if (!result.ok) {
    await createEscalation({
      orgId: reply.organization_id, ticketId: reply.ticket_id, communicationId: reply.id, target: 'gro', trigger: 'ai_uncertain',
      reason: `Authority replied (${reply.from_address}) but the reply could not be summarised automatically. Please read it.`,
      createdByAgent: 'response_summary_agent', dedupeKey: `reply_review:${reply.id}`,
    })
    return { summarized: false }
  }

  const s = result.data
  await dbQuery(
    `UPDATE communications SET summary_json = COALESCE(summary_json, '{}'::jsonb) || $2::jsonb, updated_at = now() WHERE id = $1`,
    [reply.id, JSON.stringify({ ...s, ai_run_id: result.runId })],
  )

  if (s.classification === 'auto_reply') {
    if (reply.in_reply_to_id) {
      // Auto-replies don't count as a response: resume the follow-up clock.
      await dbQuery(
        `WITH latest AS (
           SELECT c.id FROM communications c
           WHERE c.thread_key = (SELECT thread_key FROM communications WHERE id = $1)
             AND c.direction = 'outbound' AND c.status IN ('sent','delivered')
           ORDER BY c.created_at DESC LIMIT 1
         )
         UPDATE communications SET follow_up_stopped_at = NULL, next_follow_up_at = now() + interval '72 hours'
         WHERE id IN (SELECT id FROM latest)`,
        [reply.in_reply_to_id],
      )
    }
    return { summarized: true, classification: s.classification }
  }

  const lang = reply.ticket_language === 'en' ? 'en' : 'te'
  await recordCaseEvent({
    orgId: reply.organization_id, ticketId: reply.ticket_id, communicationId: reply.id, type: 'authority_replied',
    actorType: 'ai_agent', actorLabel: 'response_summary_agent', visibility: 'citizen', language: lang,
    summary: s.citizen_summary[lang], data: { classification: s.classification, commitments: s.commitments },
  })

  if (['needs_information', 'redirected', 'rejected', 'unclear'].includes(s.classification) || s.confidence < 0.5) {
    await createEscalation({
      orgId: reply.organization_id, ticketId: reply.ticket_id, taskId: reply.task_id, communicationId: reply.id, target: 'gro',
      trigger: 'ai_uncertain',
      reason: `Authority reply: ${s.classification}. ${s.internal_summary}\nSuggested next step: ${s.suggested_next_step}`,
      createdByAgent: 'response_summary_agent', dedupeKey: `reply_review:${reply.id}`,
    })
  }
  if (s.classification === 'action_taken') {
    await createTask({
      orgId: reply.organization_id,
      ticketIds: [reply.ticket_id],
      title: 'Confirm with citizen that the issue is resolved',
      description: `Authority says action was taken: ${s.internal_summary}`,
      taskType: 'citizen_contact',
      suggestedRole: 'ground_worker',
      dueAt: new Date(Date.now() + 48 * 3600_000).toISOString(),
      createdByAgent: 'response_summary_agent',
    })
  }
  return { summarized: true, classification: s.classification }
}
