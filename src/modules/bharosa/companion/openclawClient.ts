/**
 * Optional OpenClaw Gateway client.
 * When OPENCLAW_GATEWAY_URL + OPENCLAW_GATEWAY_TOKEN are set, Guide can
 * search / write memory notes for richer returning-user context.
 * Always fails soft — vocal-api DB memory remains the source of truth.
 */

const DEFAULT_TIMEOUT_MS = 2500

export function openclawGatewayConfigured(): boolean {
  const url = process.env.OPENCLAW_GATEWAY_URL?.trim()
  const token = process.env.OPENCLAW_GATEWAY_TOKEN?.trim()
  return Boolean(url && token) && (process.env.BHAROSA_COMPANION ?? '').toLowerCase() === 'openclaw'
}

function gatewayBase(): string {
  return (process.env.OPENCLAW_GATEWAY_URL ?? '').replace(/\/$/, '')
}

function gatewayToken(): string {
  return process.env.OPENCLAW_GATEWAY_TOKEN?.trim() ?? ''
}

async function invokeTool(
  tool: string,
  args: Record<string, unknown>,
  sessionKey?: string,
): Promise<unknown | null> {
  if (!openclawGatewayConfigured()) return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)
  try {
    const res = await fetch(`${gatewayBase()}/tools/invoke`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${gatewayToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tool,
        args,
        sessionKey: sessionKey ?? process.env.OPENCLAW_MEMORY_SESSION_KEY?.trim() ?? 'bharosa-citizen',
      }),
      signal: controller.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      console.warn(`[openclaw] ${tool} HTTP ${res.status}: ${text.slice(0, 200)}`)
      return null
    }
    const json = (await res.json()) as { ok?: boolean; result?: unknown }
    if (json.ok === false) return null
    return json.result ?? json
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[openclaw] ${tool} failed: ${msg}`)
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** Search OpenClaw memory for notes about this citizen / query. */
export async function openclawMemorySearch(query: string): Promise<string[]> {
  const result = await invokeTool('memory_search', { query: query.slice(0, 400) })
  if (!result) return []
  return extractSnippets(result).slice(0, 5)
}

/**
 * Persist a short note into OpenClaw memory (best-effort).
 * Uses memory_get/write tools when available; otherwise no-op.
 */
export async function openclawMemoryRemember(note: string): Promise<void> {
  const text = note.replace(/\s+/g, ' ').trim().slice(0, 800)
  if (!text) return
  // Prefer memory append-style tools; gateway policy decides availability.
  const wrote =
    (await invokeTool('memory_write', { text, path: 'memory/bharosa-citizens.md' })) ??
    (await invokeTool('write', { path: 'memory/bharosa-citizens.md', content: `${text}\n`, append: true }))
  if (!wrote) {
    // Last resort: sessions_send is denied on HTTP; skip silently.
  }
}

function extractSnippets(result: unknown): string[] {
  if (typeof result === 'string') {
    return result
      .split(/\n+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 12)
  }
  if (Array.isArray(result)) {
    return result.flatMap((item) => extractSnippets(item))
  }
  if (result && typeof result === 'object') {
    const row = result as Record<string, unknown>
    for (const key of ['results', 'matches', 'snippets', 'output', 'text', 'content']) {
      if (row[key] != null) return extractSnippets(row[key])
    }
    if (typeof row.snippet === 'string') return [row.snippet]
  }
  return []
}
