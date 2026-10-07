import { z } from 'zod'
import { dbQuery } from '@/lib/db.js'
import { HttpError } from '../common.js'
import { recordCaseEvent } from '../cases/events.js'
import { getBharosaSettings } from '../settings.js'
import { llmJson } from '../ai/llm.js'

const PROMPT_VERSION = 'routing.v1'

export interface AuthorityCandidate {
  contact_id: string
  contact_name: string
  organization_name: string | null
  role_designation: string | null
  department: string | null
  email: string | null
  has_email: boolean
  escalation_level: number
  verification_status: string
  territory_names: string[]
  score: number
  confidence: number
  reasons: string[]
}

interface TicketRoutingContext {
  id: string
  organization_id: string
  territory_id: string | null
  department: string | null
  category_name: string | null
  issue_type: string | null
  summary: string | null
  location_text: string | null
}

async function loadTicketContext(orgId: string, ticketId: string): Promise<TicketRoutingContext> {
  const res = await dbQuery<TicketRoutingContext>(
    `SELECT t.id, t.organization_id, t.territory_id, t.department, c.name AS category_name,
            t.structured_facts_json->>'issue_type' AS issue_type,
            COALESCE(t.normalized_summary, t.original_issue_text) AS summary, t.location_text
     FROM tickets t LEFT JOIN issue_categories c ON c.id = t.category_id
     WHERE t.id = $1 AND t.organization_id = $2`,
    [ticketId, orgId],
  )
  const row = res.rows[0]
  if (!row) throw new HttpError(404, 'Case not found')
  return row
}

async function territoryAncestry(territoryId: string | null): Promise<Array<{ id: string; name: string; depth: number }>> {
  if (!territoryId) return []
  const res = await dbQuery<{ id: string; name: string; depth: number }>(
    `WITH RECURSIVE chain AS (
       SELECT id, name, parent_territory_id, 0 AS depth FROM territories WHERE id = $1
       UNION ALL
       SELECT t.id, t.name, t.parent_territory_id, c.depth + 1 FROM territories t JOIN chain c ON t.id = c.parent_territory_id
       WHERE c.depth < 10
     ) SELECT id, name, depth FROM chain`,
    [territoryId],
  )
  return res.rows
}

function norm(s: string | null | undefined): string {
  return (s ?? '').toLowerCase().replace(/[^a-z0-9\u0C00-\u0C7F]+/g, ' ').trim()
}

export async function scoreAuthorityCandidates(ctx: TicketRoutingContext, limit = 10): Promise<AuthorityCandidate[]> {
  const ancestry = await territoryAncestry(ctx.territory_id)
  const depthById = new Map(ancestry.map((a) => [a.id, a.depth]))

  const res = await dbQuery<{
    id: string
    contact_name: string
    organization_name: string | null
    role_designation: string | null
    department: string | null
    email: string | null
    escalation_level: number
    verification_status: string
    bounce_count: number
    territory_ids: string[] | null
    territory_names: string[] | null
    tags: Array<{ t: string; v: string }> | null
  }>(
    `SELECT dc.id, dc.contact_name, dc.organization_name, dc.role_designation, dc.department, dc.email,
            dc.escalation_level, dc.verification_status, dc.bounce_count,
            array_remove(array_agg(DISTINCT dct.territory_id), NULL) AS territory_ids,
            array_remove(array_agg(DISTINCT tr.name), NULL) AS territory_names,
            COALESCE(jsonb_agg(DISTINCT jsonb_build_object('t', tg.tag_type, 'v', tg.tag_value))
                     FILTER (WHERE tg.id IS NOT NULL), '[]'::jsonb) AS tags
     FROM directory_contacts dc
     LEFT JOIN directory_contact_territories dct ON dct.contact_id = dc.id
     LEFT JOIN territories tr ON tr.id = dct.territory_id
     LEFT JOIN directory_contact_tags tg ON tg.contact_id = dc.id
     WHERE dc.organization_id = $1 AND dc.active = true AND dc.archived_at IS NULL
       AND (dc.valid_until IS NULL OR dc.valid_until > now())
     GROUP BY dc.id`,
    [ctx.organization_id],
  )

  const category = norm(ctx.category_name)
  const issueType = norm(ctx.issue_type?.replace(/_/g, ' '))
  const department = norm(ctx.department)

  const scored: AuthorityCandidate[] = []
  for (const c of res.rows) {
    const reasons: string[] = []
    let score = 0

    const tIds = c.territory_ids ?? []
    if (tIds.length === 0) {
      score += 5
      reasons.push('No territory restriction (state-wide office)')
    } else {
      const depths = tIds.map((id) => depthById.get(id)).filter((d): d is number => d !== undefined)
      if (depths.length) {
        const best = Math.min(...depths)
        score += best === 0 ? 50 : Math.max(35 - best * 5, 10)
        reasons.push(best === 0 ? 'Covers the exact area of the issue' : 'Covers a parent area of the issue')
      } else if (ctx.territory_id) {
        score -= 40
      }
    }

    for (const tag of c.tags ?? []) {
      const v = norm(tag.v)
      if (!v) continue
      if (tag.t === 'category' && category && (v === category || category.includes(v) || v.includes(category))) {
        score += 30
        reasons.push(`Handles category "${tag.v}"`)
      } else if (tag.t === 'issue_type' && issueType && (v === issueType || issueType.includes(v) || v.includes(issueType))) {
        score += 25
        reasons.push(`Handles issue type "${tag.v}"`)
      } else if (tag.t === 'department' && department && v === department) {
        score += 15
        reasons.push(`Department "${tag.v}"`)
      }
    }
    if (department && norm(c.department) === department) {
      score += 15
      reasons.push('Department matches')
    }
    if (c.verification_status === 'verified') score += 10
    if (c.verification_status === 'outdated') {
      score -= 30
      reasons.push('Contact marked outdated')
    }
    if (c.bounce_count > 0) {
      score -= Math.min(c.bounce_count * 10, 40)
      reasons.push(`${c.bounce_count} previous bounce(s)`)
    }
    if (!c.email) {
      score -= 20
      reasons.push('No email on file')
    }
    score += c.escalation_level === 1 ? 5 : -(c.escalation_level - 1) * 5

    if (score <= 0) continue
    scored.push({
      contact_id: c.id,
      contact_name: c.contact_name,
      organization_name: c.organization_name,
      role_designation: c.role_designation,
      department: c.department,
      email: c.email,
      has_email: !!c.email,
      escalation_level: c.escalation_level,
      verification_status: c.verification_status,
      territory_names: c.territory_names ?? [],
      score,
      confidence: Math.min(score / 120, 0.95),
      reasons,
    })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit)
}

const RerankSchema = z.object({
  ranked: z.array(z.object({ contact_id: z.string(), confidence: z.number().min(0).max(1), reason: z.string() })),
  uncertain: z.boolean().default(false),
  uncertainty_reason: z.string().nullable().optional(),
})

export async function suggestAuthorities(orgId: string, ticketId: string, opts: { persist?: boolean } = {}) {
  const settings = await getBharosaSettings(orgId)
  const ctx = await loadTicketContext(orgId, ticketId)
  let candidates = await scoreAuthorityCandidates(ctx, 8)
  let aiRunId: string | null = null
  let uncertaintyReason: string | null = null

  if (candidates.length > 1) {
    const ai = await llmJson({
      agent: 'routing',
      promptVersion: PROMPT_VERSION,
      orgId,
      ticketId,
      inputRefs: { candidate_ids: candidates.map((c) => c.contact_id) },
      system: `You help route Indian civic grievances to the public office most likely responsible.
Rank ONLY the provided candidates. Use the grievance summary, category, location and each office's designation/department/coverage.
confidence = probability this office has jurisdiction. Mark uncertain=true if no candidate clearly owns the issue. Never invent offices.
Return {"ranked":[{"contact_id":"","confidence":0.0,"reason":""}],"uncertain":false,"uncertainty_reason":null}`,
      user: JSON.stringify({
        grievance: { category: ctx.category_name, issue_type: ctx.issue_type, summary: ctx.summary?.slice(0, 1500), location: ctx.location_text },
        candidates: candidates.map((c) => ({
          contact_id: c.contact_id,
          office: c.organization_name,
          designation: c.role_designation,
          department: c.department,
          covers: c.territory_names,
          escalation_level: c.escalation_level,
        })),
      }),
      schema: RerankSchema,
      temperature: 0,
    })
    aiRunId = ai.runId
    if (ai.ok) {
      const byId = new Map(candidates.map((c) => [c.contact_id, c]))
      const reranked: AuthorityCandidate[] = []
      for (const r of ai.data.ranked) {
        const c = byId.get(r.contact_id)
        if (!c) continue
        byId.delete(r.contact_id)
        reranked.push({ ...c, confidence: r.confidence, reasons: [r.reason, ...c.reasons] })
      }
      candidates = [...reranked, ...byId.values()]
      if (ai.data.uncertain) uncertaintyReason = ai.data.uncertainty_reason ?? 'AI could not identify a clear owner'
    }
  }

  candidates = candidates.slice(0, settings.routing.maxCandidates)
  const top = candidates[0]
  const uncertain = !top || top.confidence < settings.routing.minConfidence || !!uncertaintyReason
  const routingStatus = uncertain ? 'uncertain' : 'suggested'

  if (opts.persist !== false) {
    await dbQuery(
      `UPDATE tickets SET routing_status = $2 WHERE id = $1 AND routing_status IN ('unrouted','suggested','uncertain')`,
      [ticketId, routingStatus],
    )
    await recordCaseEvent({
      orgId,
      ticketId,
      type: 'routing_suggested',
      actorType: 'ai_agent',
      actorLabel: 'routing_agent',
      visibility: 'internal',
      reason: uncertaintyReason,
      data: { ai_run_id: aiRunId, routing_status: routingStatus, candidates: candidates.map((c) => ({ id: c.contact_id, confidence: c.confidence })) },
    })
  }

  return {
    routing_status: routingStatus,
    uncertain,
    uncertainty_reason: uncertain ? uncertaintyReason ?? (top ? 'Low confidence in the best match' : 'No matching authority in the directory') : null,
    candidates,
    ai_run_id: aiRunId,
  }
}

/** Next level up the escalation chain for a contact (explicit parent first, then higher level in the same office/department). */
export async function findEscalationContact(orgId: string, contactId: string): Promise<{ id: string; email: string | null; contact_name: string } | null> {
  const res = await dbQuery<{ id: string; email: string | null; contact_name: string }>(
    `WITH base AS (SELECT * FROM directory_contacts WHERE id = $2 AND organization_id = $1)
     SELECT dc.id, dc.email, dc.contact_name FROM directory_contacts dc, base
     WHERE dc.organization_id = $1 AND dc.active = true AND dc.archived_at IS NULL AND dc.id <> base.id
       AND (dc.id = base.parent_contact_id
            OR (dc.escalation_level > base.escalation_level
                AND (dc.department IS NOT DISTINCT FROM base.department
                     OR dc.organization_name IS NOT DISTINCT FROM base.organization_name)))
     ORDER BY (dc.id = base.parent_contact_id) DESC, dc.escalation_level ASC, (dc.email IS NOT NULL) DESC
     LIMIT 1`,
    [orgId, contactId],
  )
  return res.rows[0] ?? null
}
