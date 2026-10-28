/**
 * Phase 1 — thin Dify API client.
 * vocal-api stays multi-tenant; Dify is one ops workspace we call over HTTP.
 *
 * Enable with BHAROSA_DIFY_ENABLED=true and DIFY_* keys.
 * Docs: docs/AGENT_PLATFORM_PLAN.md
 */

export function difyEnabled(): boolean {
  return (process.env.BHAROSA_DIFY_ENABLED ?? '').trim().toLowerCase() === 'true'
}

function baseUrl(): string {
  return (process.env.DIFY_API_BASE ?? 'http://127.0.0.1:5001/v1').replace(/\/$/, '')
}

export type DifyChatResult =
  | { ok: true; answer: string; raw: unknown }
  | { ok: false; error: string }

/**
 * Call a Dify Chat / Agent app (blocking response mode).
 * `apiKey` is the app-specific API key from Dify → App → API Access.
 */
export async function difyChatMessage(args: {
  apiKey: string
  query: string
  user: string
  inputs?: Record<string, string | number | boolean>
  conversationId?: string | null
  timeoutMs?: number
}): Promise<DifyChatResult> {
  const key = args.apiKey.trim()
  if (!key) return { ok: false, error: 'Dify API key missing' }

  try {
    const res = await fetch(`${baseUrl()}/chat-messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        inputs: args.inputs ?? {},
        query: args.query,
        response_mode: 'blocking',
        conversation_id: args.conversationId ?? '',
        user: args.user,
      }),
      signal: AbortSignal.timeout(args.timeoutMs ?? 45_000),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return { ok: false, error: `Dify ${res.status}: ${body.slice(0, 300)}` }
    }
    const data = (await res.json()) as { answer?: string }
    const answer = (data.answer ?? '').trim()
    if (!answer) return { ok: false, error: 'Dify returned empty answer' }
    return { ok: true, answer, raw: data }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Call a Dify Workflow app (blocking).
 * Expects the workflow to finish with a text/JSON output; we return the whole outputs map.
 */
export async function difyWorkflowRun(args: {
  apiKey: string
  inputs: Record<string, unknown>
  user: string
  timeoutMs?: number
}): Promise<{ ok: true; outputs: Record<string, unknown>; raw: unknown } | { ok: false; error: string }> {
  const key = args.apiKey.trim()
  if (!key) return { ok: false, error: 'Dify workflow API key missing' }

  try {
    const res = await fetch(`${baseUrl()}/workflows/run`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        inputs: args.inputs,
        response_mode: 'blocking',
        user: args.user,
      }),
      signal: AbortSignal.timeout(args.timeoutMs ?? 60_000),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return { ok: false, error: `Dify workflow ${res.status}: ${body.slice(0, 300)}` }
    }
    const data = (await res.json()) as {
      data?: { outputs?: Record<string, unknown> }
      outputs?: Record<string, unknown>
    }
    const outputs = data.data?.outputs ?? data.outputs ?? {}
    return { ok: true, outputs, raw: data }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function parseClassifyJson(text: string): {
  category: string | null
  needs_area: boolean
  summary: string | null
  confidence: number
} | null {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '')
  try {
    const start = cleaned.indexOf('{')
    const end = cleaned.lastIndexOf('}')
    const raw = start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned
    const o = JSON.parse(raw) as Record<string, unknown>
    const category = typeof o.category === 'string' ? o.category : null
    const summary = typeof o.summary === 'string' ? o.summary : null
    const needsArea = o.needs_area === true || o.needs_area === 'true' || o.needs_area === 1
    const confidence = typeof o.confidence === 'number' ? o.confidence : Number(o.confidence) || 0.5
    return { category, needs_area: needsArea, summary, confidence }
  } catch {
    return null
  }
}

/**
 * Intake classify via Dify Chatflow (chat-messages) or Workflow.
 * Chatflow is what Studio creates by default; Workflow uses /workflows/run.
 * Falls back to null if disabled/misconfigured so OpenRouter path still works.
 */
export async function difyIntakeClassify(args: {
  orgId: string
  message: string
  language?: string | null
  name?: string | null
}): Promise<{
  category: string | null
  needs_area: boolean
  summary: string | null
  confidence: number
} | null> {
  if (!difyEnabled()) return null
  const apiKey = process.env.DIFY_APP_INTAKE_KEY?.trim()
  if (!apiKey) return null

  const mode = (process.env.DIFY_INTAKE_MODE ?? 'chat').trim().toLowerCase()
  const user = `org:${args.orgId}`
  const query = [
    args.name ? `Citizen name: ${args.name}` : null,
    args.language ? `Language: ${args.language}` : null,
    `Message: ${args.message}`,
  ]
    .filter(Boolean)
    .join('\n')

  if (mode === 'workflow') {
    const run = await difyWorkflowRun({
      apiKey,
      user,
      inputs: {
        message: args.message,
        language: args.language ?? 'te',
        name: args.name ?? '',
      },
    })
    if (!run.ok) {
      console.warn('[dify] intake workflow failed:', run.error)
      return null
    }
    const o = run.outputs
    const fromOutputs = parseClassifyJson(JSON.stringify(o))
    if (fromOutputs) return fromOutputs
    const category = typeof o.category === 'string' ? o.category : null
    const summary = typeof o.summary === 'string' ? o.summary : null
    const needsArea = o.needs_area === true || o.needs_area === 'true' || o.needs_area === 1
    const confidence = typeof o.confidence === 'number' ? o.confidence : Number(o.confidence) || 0.5
    return { category, needs_area: needsArea, summary, confidence }
  }

  const chat = await difyChatMessage({
    apiKey,
    user,
    query,
    inputs: {
      language: args.language ?? 'te',
      name: args.name ?? '',
    },
  })
  if (!chat.ok) {
    console.warn('[dify] intake chat failed:', chat.error)
    return null
  }
  const parsed = parseClassifyJson(chat.answer)
  if (!parsed) {
    console.warn('[dify] intake chat did not return JSON:', chat.answer.slice(0, 200))
    return null
  }
  return parsed
}
