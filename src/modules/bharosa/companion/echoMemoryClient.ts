/**
 * Echo Memory (https://github.com/echo-mem/echo-mem) — hosted MCP client.
 *
 * Why: store graph facts (entities + edges) and recall only the few that matter,
 * instead of stuffing full chat / DB dumps into the LLM (saves tokens).
 *
 * Server never calls an LLM on write — we extract entities/facts locally.
 * Soft-fails when ECHO_MEM_API_KEY is unset (Guide still uses Postgres memory).
 *
 * Protocol: MCP over streamable HTTP — see https://echo-mem.com/docs/integration.md
 */

const DEFAULT_ENDPOINT = 'https://api.echo-mem.com/mcp'
const DEFAULT_TIMEOUT_MS = 12_000
const DEFAULT_POOL = 4

export function echoMemoryConfigured(): boolean {
  return Boolean(process.env.ECHO_MEM_API_KEY?.trim())
}

function endpoint(): string {
  return (process.env.ECHO_MEM_API_BASE?.trim() || DEFAULT_ENDPOINT).replace(/\/$/, '')
}

function apiKey(): string {
  return process.env.ECHO_MEM_API_KEY?.trim() ?? ''
}

function memoryName(): string | undefined {
  const m = process.env.ECHO_MEM_MEMORY?.trim()
  return m || undefined
}

function poolSize(): number {
  return Math.min(Math.max(Number(process.env.ECHO_MEM_CONCURRENCY ?? DEFAULT_POOL) || DEFAULT_POOL, 1), 16)
}

function timeoutMs(): number {
  return Number(process.env.ECHO_MEM_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS
}

type JsonRpc = Record<string, unknown>

let nextId = 1
const idle: string[] = []
const waiters: Array<(session: string) => void> = []
let openSessions = 0

async function post(body: JsonRpc, sessionId?: string | null): Promise<{ id: string | null; payload: unknown }> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey()}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  }
  if (sessionId) headers['Mcp-Session-Id'] = sessionId

  const res = await fetch(endpoint(), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs()),
  })

  if (res.status === 429) {
    const after = Number(res.headers.get('retry-after') ?? 1)
    await new Promise((r) => setTimeout(r, Math.min(Math.max(after, 1), 30) * 1000))
    return post(body, sessionId)
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`echo-mem HTTP ${res.status}: ${text.slice(0, 200)}`)
  }

  const text = await res.text()
  const id = res.headers.get('mcp-session-id')
  if (!text) return { id, payload: null }
  const sse = res.headers.get('content-type')?.includes('text/event-stream')
  if (sse) {
    const line = text.split('\n').find((l) => l.startsWith('data:'))
    return { id, payload: line ? JSON.parse(line.slice(5)) : null }
  }
  return { id, payload: JSON.parse(text) }
}

async function openSession(): Promise<string> {
  const { id } = await post({
    jsonrpc: '2.0',
    id: nextId++,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'bharosa-guide', version: '1' },
    },
  })
  if (!id) throw new Error('echo-mem: no Mcp-Session-Id on initialize')
  await post({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }, id)
  return id
}

async function lease(): Promise<string> {
  const ready = idle.pop()
  if (ready) return ready
  if (openSessions < poolSize()) {
    openSessions += 1
    try {
      return await openSession()
    } catch (e) {
      openSessions -= 1
      throw e
    }
  }
  return new Promise((resolve) => waiters.push(resolve))
}

function release(session: string): void {
  const next = waiters.shift()
  if (next) next(session)
  else idle.push(session)
}

function discard(): void {
  openSessions = Math.max(0, openSessions - 1)
  const next = waiters.shift()
  if (next) void lease().then(next)
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (!echoMemoryConfigured()) return null
  const session = await lease()
  try {
    const mem = memoryName()
    const { payload } = await post(
      {
        jsonrpc: '2.0',
        id: nextId++,
        method: 'tools/call',
        params: {
          name,
          arguments: mem ? { ...args, memory: mem } : args,
        },
      },
      session,
    )
    release(session)
    const row = payload as { result?: unknown } | null
    return row?.result ?? payload
  } catch (err) {
    discard()
    throw err
  }
}

export interface EchoEntity {
  name: string
  type: string
}

export interface EchoFact {
  source: string
  target: string
  relation_type: string
  fact: string
  confidence: 'extracted' | 'inferred' | 'ambiguous'
  causal_hint?: 'caused_by' | 'led_to' | 'enabled_by' | 'blocked_by' | 'contradicts'
}

/** Write entities + facts (no server-side LLM). */
export async function echoRemember(args: {
  sessionId: string
  entities: EchoEntity[]
  facts: EchoFact[]
  /** false when citizen/area may already exist in the graph */
  assumeNew?: boolean
  project?: string
}): Promise<unknown | null> {
  if (!echoMemoryConfigured()) return null
  if (!args.entities.length || !args.facts.length) return null
  try {
    return await callTool('write_episode', {
      scope: 'shared',
      session_id: args.sessionId.slice(0, 120),
      entities: args.entities.slice(0, 20),
      facts: args.facts.map((f) => ({
        ...f,
        fact: f.fact.slice(0, 3900),
      })),
      assume_new: args.assumeNew === true,
      project: args.project ?? 'bharosa-guide',
    })
  } catch (err) {
    console.warn('[echo-mem] write failed', err instanceof Error ? err.message : err)
    return null
  }
}

export interface EchoRecalledFact {
  fact?: string
  fact_id?: string
  score?: number | null
  rank?: number
  matched?: string[]
  [key: string]: unknown
}

/** Hybrid recall — only the few relevant facts (token-cheap). */
export async function echoRecall(args: {
  query: string
  topK?: number
  /** Exact entity names, e.g. citizen:<uuid> */
  about?: string[]
}): Promise<EchoRecalledFact[]> {
  if (!echoMemoryConfigured()) return []
  try {
    const result = await callTool('query_memory', {
      scope: 'shared',
      query: args.query.slice(0, 500),
      top_k: Math.min(Math.max(args.topK ?? 8, 1), 20),
      ...(args.about?.length ? { about: args.about.slice(0, 2) } : {}),
    })
    return normalizeFacts(result)
  } catch (err) {
    console.warn('[echo-mem] recall failed', err instanceof Error ? err.message : err)
    return []
  }
}

function normalizeFacts(result: unknown): EchoRecalledFact[] {
  if (!result) return []
  if (Array.isArray(result)) {
    return result.filter((x): x is EchoRecalledFact => !!x && typeof x === 'object')
  }
  if (typeof result === 'object') {
    const row = result as Record<string, unknown>
    for (const key of ['facts', 'results', 'items', 'content', 'structuredContent']) {
      if (Array.isArray(row[key])) return normalizeFacts(row[key])
    }
    // MCP often wraps text content
    if (Array.isArray(row.content)) {
      const texts = (row.content as Array<{ type?: string; text?: string }>)
        .filter((c) => c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text!)
      for (const t of texts) {
        try {
          return normalizeFacts(JSON.parse(t))
        } catch {
          /* keep scanning */
        }
      }
      return texts
        .filter((t) => t.trim().length > 8)
        .slice(0, 8)
        .map((fact, i) => ({ fact, rank: i + 1 }))
    }
  }
  return []
}

/** Compact lines for the Guide LLM (keeps token budget low). */
export function formatEchoFactsForPrompt(facts: EchoRecalledFact[], max = 8): string {
  const lines = facts
    .map((f) => (typeof f.fact === 'string' ? f.fact.trim() : ''))
    .filter((t) => t.length > 4)
    .slice(0, max)
  if (!lines.length) return ''
  return [
    'ECHO MEMORY (relevant facts only — prefer these over dumping old chats):',
    ...lines.map((l, i) => `${i + 1}. ${l.slice(0, 220)}`),
  ].join('\n')
}

/** Stable citizen node name for `about` queries. */
export function echoCitizenEntityId(citizenId: string): string {
  return `citizen:${citizenId}`
}
