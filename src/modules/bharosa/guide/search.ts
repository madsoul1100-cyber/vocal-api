/**
 * Public-web fallback. Used only when the Telangana playbooks do not cover
 * the question. Results are snippets for the model, not facts we store.
 */

export interface WebHit {
  title: string
  url: string
  snippet: string
}

export async function searchPublicWeb(query: string, focus = 'Telangana official'): Promise<WebHit[]> {
  const q = query.replace(/\s+/g, ' ').trim().slice(0, 180)
  if (q.length < 3) return []
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(`${q} ${focus}`)}`
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'MyLeaderGuide/1.0 (citizen help; +https://my-leader.in)',
        Accept: 'text/html',
      },
      signal: AbortSignal.timeout(8_000),
    })
    if (!res.ok) return []
    const html = await res.text()
    return parseDuckDuckGo(html).slice(0, 4)
  } catch {
    return []
  }
}

function parseDuckDuckGo(html: string): WebHit[] {
  const hits: WebHit[] = []
  const blocks = html.split('class="result__body"').slice(1, 6)
  for (const block of blocks) {
    const link = block.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
    const snippet = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|td|div)>/i)
    if (!link) continue
    const title = decode(link[2].replace(/<[^>]+>/g, ' '))
    const text = decode((snippet?.[1] ?? '').replace(/<[^>]+>/g, ' '))
    const rawUrl = decode(link[1])
    const resolved = unwrapDuckDuckGoUrl(rawUrl)
    if (!resolved || !title) continue
    hits.push({ title: title.slice(0, 180), url: resolved, snippet: text.slice(0, 300) })
  }
  return hits
}

function unwrapDuckDuckGoUrl(raw: string): string | null {
  try {
    const absolute = raw.startsWith('http') ? raw : `https:${raw}`
    const u = new URL(absolute)
    const uddg = u.searchParams.get('uddg')
    const target = uddg ? decodeURIComponent(uddg) : absolute
    const parsed = new URL(target)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
    return parsed.toString()
  } catch {
    return null
  }
}

function decode(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim()
}
