import type { z } from 'zod'
import { dbQuery } from '@/lib/db.js'

const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1'

export type AgentName =
  | 'structuring'
  | 'verification_call'
  | 'resolution'
  | 'content'
  | 'follow_up'
  | 'escalation'
  | 'translation'
  | 'response_summary'
  | 'routing'

export function llmConfigured(): boolean {
  return !!process.env.OPENROUTER_API_KEY?.trim()
}

function modelFor(agent: AgentName): string {
  const specific = process.env[`BHAROSA_MODEL_${agent.toUpperCase()}`]?.trim()
  return specific || process.env.BHAROSA_MODEL?.trim() || process.env.OPENROUTER_MODEL?.trim() || 'google/gemini-2.5-flash'
}

export interface AiRunContext {
  orgId: string | null
  ticketId?: string | null
  submissionId?: string | null
  language?: string | null
  inputRefs?: Record<string, unknown>
}

export interface LlmJsonArgs<S extends z.ZodTypeAny> extends AiRunContext {
  agent: AgentName
  promptVersion: string
  system: string
  user: string
  schema: S
  temperature?: number
  maxTokens?: number
  timeoutMs?: number
}

export type LlmJsonResult<T> =
  | { ok: true; data: T; runId: string | null; model: string }
  | { ok: false; error: string; runId: string | null; model: string }

async function recordRun(args: {
  ctx: AiRunContext
  agent: AgentName
  model: string
  promptVersion: string
  status: 'succeeded' | 'failed' | 'fallback' | 'invalid_output'
  output?: unknown
  confidence?: number | null
  latencyMs: number
  error?: string | null
}): Promise<string | null> {
  try {
    const res = await dbQuery<{ id: string }>(
      `INSERT INTO ai_runs (organization_id, ticket_id, submission_id, agent, model, prompt_version, language,
                            input_refs_json, output_json, status, confidence, latency_ms, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [
        args.ctx.orgId,
        args.ctx.ticketId ?? null,
        args.ctx.submissionId ?? null,
        args.agent,
        args.model,
        args.promptVersion,
        args.ctx.language ?? null,
        args.ctx.inputRefs ? JSON.stringify(args.ctx.inputRefs) : null,
        args.output === undefined ? null : JSON.stringify(args.output),
        args.status,
        args.confidence ?? null,
        args.latencyMs,
        args.error ?? null,
      ],
    )
    return res.rows[0]?.id ?? null
  } catch (err) {
    console.error('[bharosa:ai] failed to record ai_run', err instanceof Error ? err.message : err)
    return null
  }
}

/** Records a deterministic (non-LLM) fallback so the trace stays complete. */
export async function recordFallbackRun(
  ctx: AiRunContext,
  agent: AgentName,
  promptVersion: string,
  output: unknown,
  error: string,
): Promise<string | null> {
  return recordRun({ ctx, agent, model: 'fallback-template', promptVersion, status: 'fallback', output, latencyMs: 0, error })
}

function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '')
  try {
    return JSON.parse(trimmed)
  } catch {
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1))
    throw new Error('Model did not return JSON')
  }
}

/**
 * Structured LLM call. Output is validated against `schema`; invalid output
 * fails safely (ok:false) so callers route the work to a human queue.
 */
export async function llmJson<S extends z.ZodTypeAny>(args: LlmJsonArgs<S>): Promise<LlmJsonResult<z.infer<S>>> {
  const model = modelFor(args.agent)
  const started = Date.now()
  const apiKey = process.env.OPENROUTER_API_KEY?.trim()

  if (!apiKey) {
    return { ok: false, error: 'OPENROUTER_API_KEY not configured', runId: null, model }
  }

  let raw: unknown
  try {
    const res = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'X-Title': `Bharosa ${args.agent}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: `${args.system}\n\nRespond with a single JSON object only. No prose, no code fences.` },
          { role: 'user', content: args.user },
        ],
        temperature: args.temperature ?? 0.2,
        max_tokens: args.maxTokens ?? 1500,
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(args.timeoutMs ?? 30_000),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`OpenRouter ${res.status}: ${body.slice(0, 300)}`)
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
    const content = data.choices?.[0]?.message?.content ?? ''
    if (!content.trim()) throw new Error('Empty AI response')
    raw = extractJson(content)
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    const runId = await recordRun({
      ctx: args, agent: args.agent, model, promptVersion: args.promptVersion,
      status: 'failed', latencyMs: Date.now() - started, error,
    })
    return { ok: false, error, runId, model }
  }

  const parsed = args.schema.safeParse(raw)
  if (!parsed.success) {
    const error = `Schema validation failed: ${parsed.error.message.slice(0, 500)}`
    const runId = await recordRun({
      ctx: args, agent: args.agent, model, promptVersion: args.promptVersion,
      status: 'invalid_output', output: raw, latencyMs: Date.now() - started, error,
    })
    return { ok: false, error, runId, model }
  }

  const confidence =
    raw && typeof raw === 'object' && typeof (raw as { confidence?: unknown }).confidence === 'number'
      ? ((raw as { confidence: number }).confidence)
      : null
  const runId = await recordRun({
    ctx: args, agent: args.agent, model, promptVersion: args.promptVersion,
    status: 'succeeded', output: parsed.data, confidence, latencyMs: Date.now() - started,
  })
  return { ok: true, data: parsed.data, runId, model }
}

export async function reviewAiRun(args: {
  runId: string
  orgId: string
  reviewerId: string
  decision: 'accepted' | 'edited' | 'rejected'
  notes?: string | null
}): Promise<boolean> {
  const res = await dbQuery(
    `UPDATE ai_runs SET review_decision = $3, reviewed_by = $4, reviewed_at = now(), review_notes = $5
     WHERE id = $1 AND organization_id = $2`,
    [args.runId, args.orgId, args.decision, args.reviewerId, args.notes ?? null],
  )
  return (res.rowCount ?? 0) > 0
}

/** Shared guardrails appended to every prompt that writes or summarizes case content. */
export const GROUNDING_RULES = `Grounding rules (non-negotiable):
- Use only facts present in the provided material. Never invent names, dates, numbers, quotes, commitments or recipients.
- If a fact is missing, list it as a question instead of guessing.
- Never promise an outcome or commit the organization or any authority to an action.
- Do not include the citizen's phone number, email or exact home address unless explicitly provided for that purpose.
- Keep proper nouns, place names, dates and official titles exactly as given, in every language.`
