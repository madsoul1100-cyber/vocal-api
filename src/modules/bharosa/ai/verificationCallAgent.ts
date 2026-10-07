import { z } from 'zod'
import { GROUNDING_RULES, llmJson } from './llm.js'
import { loadCaseFacts } from './contentAgent.js'
import { dbQuery } from '@/lib/db.js'

const SCRIPT_VERSION = 'verification_call.script.v1'
const EXTRACT_VERSION = 'verification_call.extract.v1'

export const CallScriptSchema = z.object({
  greeting: z.object({ te: z.string(), en: z.string() }),
  confirmations: z.array(z.object({ key: z.string(), statement_te: z.string(), statement_en: z.string() })).max(6),
  questions: z.array(z.object({ key: z.string(), question_te: z.string(), question_en: z.string(), why: z.string() })).max(6),
  closing: z.object({ te: z.string(), en: z.string() }),
})
export type CallScript = z.infer<typeof CallScriptSchema>

export const CallOutcomeSchema = z.object({
  reached_citizen: z.boolean(),
  citizen_confirmed_complaint: z.boolean().nullable(),
  answers: z.record(z.string(), z.string()).default({}),
  corrections: z.array(z.string()).default([]),
  new_facts: z.array(z.string()).default([]),
  concerns: z.array(z.string()).default([]),
  recommended_status: z.enum(['passed', 'failed', 'inconclusive']),
  confidence: z.number().min(0).max(1).default(0.5),
})
export type CallOutcome = z.infer<typeof CallOutcomeSchema>

function fallbackScript(ticketNumber: string, missing: Array<{ key: string; question_en: string; question_te: string }>): CallScript {
  return {
    greeting: {
      te: `నమస్కారం, మీరు నమోదు చేసిన ఫిర్యాదు ${ticketNumber} గురించి భరోసా నుండి కాల్ చేస్తున్నాం. రెండు నిమిషాలు మాట్లాడవచ్చా?`,
      en: `Hello, this is Bharosa calling about your complaint ${ticketNumber}. Do you have two minutes?`,
    },
    confirmations: [
      { key: 'complaint_is_yours', statement_te: 'ఈ ఫిర్యాదు మీరే నమోదు చేశారా?', statement_en: 'Did you file this complaint yourself?' },
      { key: 'issue_still_present', statement_te: 'ఈ సమస్య ఇంకా ఉందా?', statement_en: 'Is the problem still there?' },
    ],
    questions: missing.map((m) => ({ key: m.key, question_te: m.question_te, question_en: m.question_en, why: 'Missing from submission' })),
    closing: {
      te: 'ధన్యవాదాలు. మీ ఫిర్యాదు పురోగతిని మీకు తెలియజేస్తాం.',
      en: 'Thank you. We will keep you updated on progress.',
    },
  }
}

export async function buildCallScript(orgId: string, ticketId: string): Promise<{ script: CallScript; runId: string | null }> {
  const facts = await loadCaseFacts(orgId, ticketId)
  const structured = (
    await dbQuery<{ s: { missing_questions?: Array<{ key: string; question_en: string; question_te: string }> } | null }>(
      `SELECT structured_facts_json AS s FROM tickets WHERE id = $1`,
      [ticketId],
    )
  ).rows[0]?.s
  const missing = structured?.missing_questions ?? []

  const result = await llmJson({
    agent: 'verification_call',
    promptVersion: SCRIPT_VERSION,
    orgId,
    ticketId,
    inputRefs: { missing_count: missing.length },
    system: `Write a short, polite phone verification script for a grievance platform calling a citizen in Telangana.
Goal: confirm the citizen filed the complaint, confirm the key facts, and ask only the clarifying questions needed to act.
Keep it under 2 minutes. Simple spoken Telugu ("te") with English ("en") equivalents. Never promise outcomes. Never ask for Aadhaar, bank or OTP details.
${GROUNDING_RULES}
Return {"greeting":{"te":"","en":""},"confirmations":[{"key":"","statement_te":"","statement_en":""}],"questions":[{"key":"","question_te":"","question_en":"","why":""}],"closing":{"te":"","en":""}}`,
    user: JSON.stringify({ reference: facts.ticket_number, title: facts.title, summary: facts.summary, location: facts.location_text, missing_questions: missing }),
    schema: CallScriptSchema,
    temperature: 0.2,
  })
  if (result.ok) return { script: result.data, runId: result.runId }
  return { script: fallbackScript(facts.ticket_number, missing), runId: result.runId }
}

export async function extractCallOutcome(args: {
  orgId: string
  ticketId: string
  script: CallScript | null
  transcript: string
}): Promise<{ outcome: CallOutcome | null; runId: string | null }> {
  const result = await llmJson({
    agent: 'verification_call',
    promptVersion: EXTRACT_VERSION,
    orgId: args.orgId,
    ticketId: args.ticketId,
    inputRefs: { transcript_chars: args.transcript.length },
    system: `Extract the outcome of a verification phone call between a grievance platform and a citizen.
Answer keys must match the script's question keys. recommended_status: passed = citizen reached and confirmed the complaint; failed = citizen denies filing it or says it is false; inconclusive = not reached or unclear.
Only report what was actually said in the transcript.
Return {"reached_citizen":true,"citizen_confirmed_complaint":true,"answers":{},"corrections":[],"new_facts":[],"concerns":[],"recommended_status":"passed","confidence":0.0}`,
    user: JSON.stringify({ script: args.script, transcript: args.transcript.slice(0, 20_000) }),
    schema: CallOutcomeSchema,
    temperature: 0,
  })
  return result.ok ? { outcome: result.data, runId: result.runId } : { outcome: null, runId: result.runId }
}
