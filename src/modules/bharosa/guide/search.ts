/**
 * Public-web fallback for civic / official Telangana questions
 * (when playbooks do not already cover the ask).
 */

export interface WebHit {
  title: string
  url: string
  snippet: string
}

/**
 * Lifestyle / personal chat — outside Bharosa’s civic circle.
 * Movies, salons, restaurants, private fights, etc. → soft redirect, not ChatGPT open chat.
 * Intentionally does NOT match bare “near me” / “best” so “MeeSeva near me” stays civic.
 */
export function isLifestyleOutOfScopeQuery(text: string): boolean {
  return /\b(salon|saloon|parlour|parlor|spa|restaurant|hotel|cafe|café|gym|fitness|yoga\s+class|petrol\s*pump|atm|movie|movies|cinema|cinemas|theatre|theater|multiplex|pvr|inox|miraj|allu\s+cinemas|bollywood|tollywood|showtimes?|now\s+showing|new\s+released?|bookmyshow|shopping\s+mall|haircut|beauty\s+parlour|barber|dating|girlfriend|boyfriend|break\s*up|marry|marriage\s+advice|beat\s+(my\s+)?friend|fight\s+with|revenge|cheat\s+on|stock\s+tip|crypto|cricket\s+score|ipl\s+score|recipe|joke|story|poem|horoscope|astrology)\b/i.test(
    text,
  )
}

/** @deprecated use isLifestyleOutOfScopeQuery — kept for older call sites */
export function isLocalDiscoveryQuery(text: string): boolean {
  return isLifestyleOutOfScopeQuery(text)
}

export async function searchPublicWeb(query: string, focus = 'Telangana official'): Promise<WebHit[]> {
  const q = query.replace(/\s+/g, ' ').trim().slice(0, 180)
  if (q.length < 3) return []
  return duckSearch(`${q} ${focus}`, 5)
}

/**
 * Multi-query local discovery: chains + local + prices + ratings.
 * Merges DuckDuckGo hits so Gemini has real snippets to ground on.
 */
export async function searchLocalDiscovery(args: {
  query: string
  place?: string | null
}): Promise<WebHit[]> {
  const place = (args.place || 'Hyderabad Telangana').replace(/\s+/g, ' ').trim().slice(0, 60)
  const topic = args.query.replace(/\s+/g, ' ').trim().slice(0, 100)
  const isCinema = /\b(movie|movies|cinema|cinemas|theatre|theater|multiplex|pvr|inox|bollywood|tollywood|showtimes?|bookmyshow|now\s+showing)\b/i.test(
    topic,
  )
  const isSalon = /\b(salon|saloon|parlour|parlor|spa|haircut|beauty|barber)\b/i.test(topic)
  const queries = isCinema
    ? [
        `movie theaters cinemas near ${place} Hyderabad ratings`,
        `new released movies theaters near ${place} BookMyShow`,
        `PVR INOX Miraj cinemas near ${place} showtimes`,
        `best multiplex near ${place} Hyderabad reviews`,
      ]
    : isSalon
      ? [
          `${topic} ${place} ratings reviews`,
          `best ${topic} near ${place} Hyderabad price`,
          `${topic} ${place} price list haircut spa`,
          `local ${topic} ${place} Google reviews`,
        ]
      : [
          `${topic} ${place} ratings reviews`,
          `best ${topic} near ${place} Hyderabad`,
          `${topic} ${place} price list`,
          `local ${topic} ${place} Google reviews`,
        ]
  const batches = await Promise.all(queries.map((q) => duckSearch(q, 4)))
  const seen = new Set<string>()
  const merged: WebHit[] = []
  for (const batch of batches) {
    for (const hit of batch) {
      const key = hit.url.split('?')[0]!.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(hit)
      if (merged.length >= 10) return merged
    }
  }
  return merged
}

async function duckSearch(query: string, limit: number): Promise<WebHit[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
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
    return parseDuckDuckGo(html).slice(0, limit)
  } catch {
    return []
  }
}

function parseDuckDuckGo(html: string): WebHit[] {
  const hits: WebHit[] = []
  const blocks = html.split('class="result__body"').slice(1, 8)
  for (const block of blocks) {
    const link = block.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
    const snippet = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|td|div)>/i)
    if (!link) continue
    const title = decode(link[2].replace(/<[^>]+>/g, ' '))
    const text = decode((snippet?.[1] ?? '').replace(/<[^>]+>/g, ' '))
    const rawUrl = decode(link[1])
    const resolved = unwrapDuckDuckGoUrl(rawUrl)
    if (!resolved || !title) continue
    hits.push({ title: title.slice(0, 180), url: resolved, snippet: text.slice(0, 400) })
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
