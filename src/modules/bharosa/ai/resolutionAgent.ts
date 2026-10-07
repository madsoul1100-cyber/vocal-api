import { z } from 'zod'
import { dbQuery } from '@/lib/db.js'
import { GROUNDING_RULES, llmJson } from './llm.js'
import { loadCaseFacts } from './contentAgent.js'
import { suggestAuthorities } from '../directory/routing.js'
import { TASK_TYPES } from '../cases/tasks.js'

const PROMPT_VERSION = 'resolution.v1'

export const PlanStepSchema = z.object({
  title: z.string().min(3),
  description: z.string().default(''),
  task_type: z.enum(TASK_TYPES).default('general'),
  suggested_role: z.string().nullable().optional(),
  due_in_hours: z.number().int().min(1).max(24 * 60).default(72),
  depends_on_index: z.number().int().min(0).nullable().optional(),
  authority_contact_id: z.string().nullable().optional(),
  evidence_required: z.array(z.string()).default([]),
})
export type PlanStep = z.infer<typeof PlanStepSchema>

export const PlanSchema = z.object({
  issue_type: z.string(),
  category: z.string().nullable().optional(),
  summary: z.string(),
  responsible_parties: z
    .array(z.object({ contact_id: z.string().nullable().optional(), description: z.string(), why: z.string() }))
    .default([]),
  steps: z.array(PlanStepSchema).min(1).max(12),
  questions_for_gro: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1).default(0.5),
})
export type ResolutionPlan = z.infer<typeof PlanSchema>

const ROLE_GUIDE = `Roles available: central_support (GRO / coordinator), district_leader, ground_worker (field visits, citizen contact), legal_support (legal notices, RTI), media_volunteer (public posts).`

function fallbackPlan(facts: { title: string | null; category: string | null }, topContactId: string | null): ResolutionPlan {
  return {
    issue_type: 'unclassified',
    category: facts.category,
    summary: facts.title ?? 'Citizen grievance',
    responsible_parties: [],
    steps: [
      { title: 'Verify the complaint with the citizen', description: 'Call the citizen to confirm details and location.', task_type: 'citizen_contact', suggested_role: 'ground_worker', due_in_hours: 24, depends_on_index: null, authority_contact_id: null, evidence_required: [] },
      { title: 'Collect photo evidence of the issue', description: 'Visit or request photos of the site.', task_type: 'field_visit', suggested_role: 'ground_worker', due_in_hours: 48, depends_on_index: 0, authority_contact_id: null, evidence_required: ['site_photo'] },
      { title: 'Send grievance to the responsible authority', description: 'Draft and approve an email to the concerned office.', task_type: 'contact_authority', suggested_role: 'central_support', due_in_hours: 72, depends_on_index: 1, authority_contact_id: topContactId, evidence_required: [] },
      { title: 'Follow up until the authority responds', description: 'Track replies and follow up on schedule.', task_type: 'follow_up', suggested_role: 'central_support', due_in_hours: 240, depends_on_index: 2, authority_contact_id: topContactId, evidence_required: [] },
    ],
    questions_for_gro: ['AI planning unavailable — please review this template plan.'],
    risks: [],
    confidence: 0,
  }
}

export async function runResolutionAgent(args: { orgId: string; ticketId: string }) {
  const facts = await loadCaseFacts(args.orgId, args.ticketId)
  const routing = await suggestAuthorities(args.orgId, args.ticketId, { persist: false })
  const verification = await dbQuery<{ method: string; status: string; notes: string | null }>(
    `SELECT method, status, notes FROM verification_checks WHERE ticket_id = $1 ORDER BY created_at`,
    [args.ticketId],
  )

  const result = await llmJson({
    agent: 'resolution',
    promptVersion: PROMPT_VERSION,
    orgId: args.orgId,
    ticketId: args.ticketId,
    inputRefs: { candidate_ids: routing.candidates.map((c) => c.contact_id), verification_count: verification.rowCount },
    system: `You are a resolution planner for a grievance-redressal team in Telangana, India. A human GRO (Grievance Redressal Officer) will review and edit your plan before any task is created.

Produce:
- issue_type (snake_case) and category,
- responsible_parties: which offices should act. Prefer the provided directory candidates (use their contact_id). If none fit, describe the office type with contact_id null,
- 2-8 concrete, ordered steps. Each step is one accountable unit of work: title, description, task_type, suggested_role, due_in_hours, depends_on_index (index of an earlier step or null), authority_contact_id (only from candidates), evidence_required,
- questions_for_gro: anything ambiguous (jurisdiction unclear, facts missing, safety, legal sensitivity). Ask rather than assume,
- risks and an overall confidence (0-1).

Typical pattern: verify with citizen → gather evidence (field visit if needed) → contact authority → follow up → confirm outcome with citizen. Adapt to the issue; skip steps already satisfied by the verification record.
${ROLE_GUIDE}

${GROUNDING_RULES}

Return JSON: {"issue_type":"","category":"","summary":"","responsible_parties":[{"contact_id":null,"description":"","why":""}],"steps":[{"title":"","description":"","task_type":"general","suggested_role":"","due_in_hours":72,"depends_on_index":null,"authority_contact_id":null,"evidence_required":[]}],"questions_for_gro":[],"risks":[],"confidence":0.0}`,
    user: JSON.stringify({
      case: {
        reference: facts.ticket_number, title: facts.title, summary: facts.summary, category: facts.category,
        issue_type: facts.issue_type, severity: facts.severity, location: facts.location_text, area: facts.area,
        evidence_items: facts.evidence_count,
      },
      verification: verification.rows,
      directory_candidates: routing.candidates.map((c) => ({
        contact_id: c.contact_id, office: c.organization_name, designation: c.role_designation,
        department: c.department, covers: c.territory_names, confidence: c.confidence,
      })),
      routing_uncertain: routing.uncertain,
    }),
    schema: PlanSchema,
    temperature: 0.2,
    maxTokens: 2500,
  })

  const candidateIds = new Set(routing.candidates.map((c) => c.contact_id))
  if (result.ok) {
    const plan = result.data
    for (const s of plan.steps) {
      if (s.authority_contact_id && !candidateIds.has(s.authority_contact_id)) s.authority_contact_id = null
    }
    plan.steps.forEach((s, i) => {
      if (s.depends_on_index != null && s.depends_on_index >= i) s.depends_on_index = null
    })
    for (const p of plan.responsible_parties) {
      if (p.contact_id && !candidateIds.has(p.contact_id)) p.contact_id = null
    }
    return { plan, runId: result.runId, fallback: false, routing }
  }
  return { plan: fallbackPlan(facts, routing.candidates[0]?.contact_id ?? null), runId: result.runId, fallback: true, routing }
}
