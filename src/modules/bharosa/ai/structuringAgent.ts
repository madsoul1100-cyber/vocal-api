import { z } from 'zod'
import { dbQuery } from '@/lib/db.js'
import { tenantCivicScope } from '@/config/tenant.config.js'
import { GROUNDING_RULES, llmJson, recordFallbackRun } from './llm.js'

const PROMPT_VERSION = 'structuring.v1'

export const StructuredFactsSchema = z.object({
  detected_language: z.string().default('te'),
  is_civic_issue: z.boolean().default(true),
  out_of_scope_reason: z.string().nullable().optional(),
  title: z.object({ en: z.string(), te: z.string() }),
  summary: z.object({ en: z.string(), te: z.string() }),
  category: z.string().nullable(),
  issue_type: z.string().nullable().optional(),
  severity: z.enum(['critical', 'high', 'medium', 'low']).default('medium'),
  safety_risk: z.boolean().default(false),
  issue_location: z
    .object({ text: z.string().nullable(), landmark: z.string().nullable().optional() })
    .default({ text: null }),
  incident_dates: z.array(z.string()).default([]),
  offices_or_officials_mentioned: z.array(z.string()).default([]),
  affected_people_estimate: z.string().nullable().optional(),
  missing_questions: z
    .array(z.object({ key: z.string(), question_en: z.string(), question_te: z.string() }))
    .max(5)
    .default([]),
  confidence: z.number().min(0).max(1).default(0.5),
})
export type StructuredFacts = z.infer<typeof StructuredFactsSchema>

async function categoryNames(orgId: string): Promise<string[]> {
  const res = await dbQuery<{ name: string }>(
    `SELECT name FROM issue_categories
     WHERE (organization_id = $1 OR organization_id IS NULL) AND active = true AND level = 1
     ORDER BY sort_order, name`,
    [orgId],
  )
  return res.rows.map((r) => r.name)
}

function fallbackFacts(text: string, locationText: string | null, language: string): StructuredFacts {
  const short = text.replace(/\s+/g, ' ').trim()
  const title = short.slice(0, 80)
  return {
    detected_language: language,
    is_civic_issue: true,
    out_of_scope_reason: null,
    title: { en: title, te: title },
    summary: { en: short.slice(0, 600), te: short.slice(0, 600) },
    category: null,
    issue_type: null,
    severity: 'medium',
    safety_risk: false,
    issue_location: { text: locationText, landmark: null },
    incident_dates: [],
    offices_or_officials_mentioned: [],
    affected_people_estimate: null,
    missing_questions: locationText
      ? []
      : [{ key: 'location', question_en: 'Where exactly is this problem?', question_te: 'ఈ సమస్య ఎక్కడ ఉంది?' }],
    confidence: 0,
  }
}

export async function runStructuringAgent(args: {
  orgId: string
  submissionId: string
  text: string
  language: string
  issueLocationText: string | null
  categoryHint: string | null
  answers: Record<string, string> | null
  evidenceCount: number
}): Promise<{ facts: StructuredFacts; runId: string | null; fallback: boolean }> {
  const categories = await categoryNames(args.orgId)
  const system = `You structure civic grievances submitted by citizens in Telangana, India, for a grievance-resolution platform.
The citizen will review your output before submitting, so be faithful to what they said.

Scope: ${tenantCivicScope.summary}
Out of scope: ${tenantCivicScope.excluded.join('; ')}

Tasks:
1. Write a short title and a neutral 2-4 sentence summary in BOTH English ("en") and Telugu script ("te").
2. Pick "category" from this list exactly, or null if none fits: ${categories.join(' | ') || '(no categories configured)'}.
3. Set "issue_type" to a short snake_case type (e.g. drainage_overflow, streetlight_not_working, pension_delay).
4. Severity: critical = immediate danger to life/health; high = many people affected or essential service down; medium = default; low = minor.
5. Extract issue location text, dates and any offices/officials named, exactly as written.
6. Ask up to 3 short follow-up questions ONLY for facts needed to act (exact location, since when, how many affected, prior complaint number). Give each question in English and Telugu.
7. "confidence" (0-1) = how sure you are about the category and location.
8. If it is a private/personal dispute, set is_civic_issue=false with a short out_of_scope_reason.

${GROUNDING_RULES}

JSON shape:
{"detected_language":"te|en","is_civic_issue":true,"out_of_scope_reason":null,"title":{"en":"","te":""},"summary":{"en":"","te":""},"category":"","issue_type":"","severity":"medium","safety_risk":false,"issue_location":{"text":"","landmark":null},"incident_dates":[],"offices_or_officials_mentioned":[],"affected_people_estimate":null,"missing_questions":[{"key":"","question_en":"","question_te":""}],"confidence":0.0}`

  const answers = args.answers && Object.keys(args.answers).length
    ? `\n\nCitizen's answers to earlier questions:\n${Object.entries(args.answers).map(([k, v]) => `- ${k}: ${v}`).join('\n')}`
    : ''
  const user = `Citizen's language: ${args.language}
Citizen's description:
"""${args.text}"""
Issue location (as typed): ${args.issueLocationText ?? '(not given)'}
Category chosen by citizen: ${args.categoryHint ?? '(none)'}
Photos/videos attached: ${args.evidenceCount}${answers}`

  const result = await llmJson({
    agent: 'structuring',
    promptVersion: PROMPT_VERSION,
    orgId: args.orgId,
    submissionId: args.submissionId,
    language: args.language,
    inputRefs: { submission_id: args.submissionId, evidence_count: args.evidenceCount },
    system,
    user,
    schema: StructuredFactsSchema,
    temperature: 0.1,
  })

  if (result.ok) {
    const facts = result.data
    if (facts.category && !categories.includes(facts.category)) facts.category = null
    return { facts, runId: result.runId, fallback: false }
  }

  const facts = fallbackFacts(args.text, args.issueLocationText, args.language)
  const runId = result.runId ?? (await recordFallbackRun({ orgId: args.orgId, submissionId: args.submissionId }, 'structuring', PROMPT_VERSION, facts, result.error))
  return { facts, runId, fallback: true }
}
