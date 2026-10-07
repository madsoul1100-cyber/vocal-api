import crypto from 'node:crypto'
import { dbQuery } from '@/lib/db.js'
import { HttpError, assertPublicHttpUrl } from '../common.js'

/**
 * Political feed: curated RSS/Atom/JSON-feed links configured by the tenant,
 * polled on a schedule and shown publicly (pinned first, hidden excluded).
 */

export interface FeedSourceRow {
  id: string
  organization_id: string
  name: string
  url: string
  kind: 'rss' | 'atom' | 'json' | 'link'
  language: string | null
  active: boolean
  refresh_minutes: number
  last_fetched_at: string | null
  last_status: string | null
  last_error: string | null
}

interface ParsedItem {
  guid: string
  title: string
  link: string | null
  summary: string | null
  image_url: string | null
  published_at: string | null
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
}

function stripHtml(s: string): string {
  return decode(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

function tag(xml: string, name: string): string | null {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'))
  return m ? decode(m[1]).trim() : null
}

function attr(xml: string, name: string, attribute: string, where?: RegExp): string | null {
  const re = new RegExp(`<${name}\\s[^>]*>`, 'gi')
  for (const m of xml.matchAll(re)) {
    if (where && !where.test(m[0])) continue
    const a = m[0].match(new RegExp(`${attribute}\\s*=\\s*["']([^"']+)["']`, 'i'))
    if (a) return decode(a[1])
  }
  return null
}

function firstImage(html: string | null): string | null {
  if (!html) return null
  const m = html.match(/<img[^>]+src=["']([^"']+)["']/i)
  return m ? decode(m[1]) : null
}

function toIso(s: string | null): string | null {
  if (!s) return null
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

function safeLink(s: string | null): string | null {
  if (!s) return null
  try {
    const u = new URL(s)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null
  } catch {
    return null
  }
}

export function parseFeed(body: string, kind: FeedSourceRow['kind']): ParsedItem[] {
  if (kind === 'json' || body.trimStart().startsWith('{')) {
    const j = JSON.parse(body) as { items?: Array<Record<string, unknown>> }
    return (j.items ?? []).map((it) => {
      const link = safeLink((it.url as string) ?? (it.external_url as string) ?? null)
      const title = String(it.title ?? '').trim()
      return {
        guid: String(it.id ?? link ?? title),
        title: title || (link ?? 'Untitled'),
        link,
        summary: it.summary ? String(it.summary) : it.content_text ? String(it.content_text).slice(0, 500) : it.content_html ? stripHtml(String(it.content_html)).slice(0, 500) : null,
        image_url: safeLink((it.image as string) ?? (it.banner_image as string) ?? null),
        published_at: toIso((it.date_published as string) ?? null),
      }
    })
  }

  const isAtom = /<feed[\s>]/i.test(body) && !/<rss[\s>]/i.test(body)
  const blocks = [...body.matchAll(isAtom ? /<entry[\s>][\s\S]*?<\/entry>/gi : /<item[\s>][\s\S]*?<\/item>/gi)].map((m) => m[0])
  return blocks.map((b) => {
    const rawDesc = isAtom ? tag(b, 'summary') ?? tag(b, 'content') : tag(b, 'description') ?? tag(b, 'content:encoded')
    const link = isAtom ? attr(b, 'link', 'href', /rel=["']alternate["']|^(?!.*rel=)/i) ?? attr(b, 'link', 'href') : tag(b, 'link')
    const title = stripHtml(tag(b, 'title') ?? '')
    const image =
      attr(b, 'media:content', 'url') ?? attr(b, 'media:thumbnail', 'url') ?? attr(b, 'enclosure', 'url', /type=["']image/i) ?? firstImage(rawDesc)
    return {
      guid: (isAtom ? tag(b, 'id') : tag(b, 'guid')) ?? link ?? title,
      title: title || 'Untitled',
      link: safeLink(link),
      summary: rawDesc ? stripHtml(rawDesc).slice(0, 500) : null,
      image_url: safeLink(image),
      published_at: toIso(isAtom ? tag(b, 'published') ?? tag(b, 'updated') : tag(b, 'pubDate') ?? tag(b, 'dc:date')),
    }
  })
}

async function fetchLinkPreview(url: string): Promise<ParsedItem> {
  await assertPublicHttpUrl(url)
  const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { 'User-Agent': 'BharosaFeedBot/1.0' } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const html = (await res.text()).slice(0, 300_000)
  const meta = (p: string) =>
    html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${p}["'][^>]+content=["']([^"']*)["']`, 'i'))?.[1] ??
    html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${p}["']`, 'i'))?.[1] ??
    null
  const title = meta('og:title') ?? tag(html, 'title') ?? url
  return {
    guid: url,
    title: stripHtml(title),
    link: url,
    summary: meta('og:description') ? stripHtml(meta('og:description')!) : null,
    image_url: safeLink(meta('og:image') ? decode(meta('og:image')!) : null),
    published_at: toIso(meta('article:published_time')),
  }
}

export async function refreshFeedSource(src: FeedSourceRow): Promise<{ fetched: number; inserted: number }> {
  try {
    let items: ParsedItem[]
    if (src.kind === 'link') {
      items = [await fetchLinkPreview(src.url)]
    } else {
      await assertPublicHttpUrl(src.url)
      const res = await fetch(src.url, {
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
        headers: { 'User-Agent': 'BharosaFeedBot/1.0', Accept: 'application/rss+xml, application/atom+xml, application/feed+json, application/xml, text/xml, */*' },
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      items = parseFeed(await res.text(), src.kind)
    }
    let inserted = 0
    for (const it of items.slice(0, 100)) {
      const guid = crypto.createHash('sha256').update(`${src.id}:${it.guid}`).digest('hex')
      const r = await dbQuery(
        `INSERT INTO feed_items (organization_id, source_id, guid, title, link, summary, image_url, language, published_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9::timestamptz, now()))
         ON CONFLICT (organization_id, guid) DO UPDATE SET title = EXCLUDED.title, summary = EXCLUDED.summary,
           image_url = COALESCE(EXCLUDED.image_url, feed_items.image_url)
         RETURNING (xmax = 0) AS inserted`,
        [src.organization_id, src.id, guid, it.title.slice(0, 500), it.link, it.summary, it.image_url, src.language, it.published_at],
      )
      if ((r.rows[0] as { inserted?: boolean } | undefined)?.inserted) inserted++
    }
    await dbQuery(`UPDATE feed_sources SET last_fetched_at = now(), last_status = 'ok', last_error = NULL WHERE id = $1`, [src.id])
    return { fetched: items.length, inserted }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await dbQuery(`UPDATE feed_sources SET last_fetched_at = now(), last_status = 'error', last_error = $2 WHERE id = $1`, [src.id, msg.slice(0, 1000)])
    throw err
  }
}

export async function refreshDueFeeds(orgId?: string | null) {
  const res = await dbQuery<FeedSourceRow>(
    `SELECT * FROM feed_sources
     WHERE active = true AND ($1::uuid IS NULL OR organization_id = $1)
       AND (last_fetched_at IS NULL OR last_fetched_at < now() - make_interval(mins => refresh_minutes))
     ORDER BY last_fetched_at NULLS FIRST LIMIT 30`,
    [orgId ?? null],
  )
  const out: Array<{ id: string; ok: boolean; inserted?: number; error?: string }> = []
  for (const s of res.rows) {
    try {
      const r = await refreshFeedSource(s)
      out.push({ id: s.id, ok: true, inserted: r.inserted })
    } catch (err) {
      out.push({ id: s.id, ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return out
}

export async function listPublicFeed(orgId: string, args: { limit: number; offset: number; language?: string | null }) {
  const res = await dbQuery(
    `SELECT i.id, i.title, i.link, i.summary, i.image_url, i.language, i.published_at, i.pinned, s.name AS source_name
     FROM feed_items i LEFT JOIN feed_sources s ON s.id = i.source_id
     WHERE i.organization_id = $1 AND i.hidden = false AND (s.id IS NULL OR s.active = true)
       AND ($4::text IS NULL OR i.language IS NULL OR i.language = $4)
     ORDER BY i.pinned DESC, i.published_at DESC NULLS LAST
     LIMIT $2 OFFSET $3`,
    [orgId, args.limit, args.offset, args.language ?? null],
  )
  return res.rows
}

export async function listFeedItemsAdmin(orgId: string, args: { limit: number; offset: number; sourceId?: string | null }) {
  const res = await dbQuery(
    `SELECT i.*, s.name AS source_name FROM feed_items i LEFT JOIN feed_sources s ON s.id = i.source_id
     WHERE i.organization_id = $1 AND ($4::uuid IS NULL OR i.source_id = $4)
     ORDER BY i.pinned DESC, i.published_at DESC NULLS LAST LIMIT $2 OFFSET $3`,
    [orgId, args.limit, args.offset, args.sourceId ?? null],
  )
  return res.rows
}

export async function listFeedSources(orgId: string) {
  return (await dbQuery<FeedSourceRow>(`SELECT * FROM feed_sources WHERE organization_id = $1 ORDER BY created_at DESC`, [orgId])).rows
}

async function validUrl(u: unknown): Promise<string> {
  if (typeof u !== 'string') throw new HttpError(400, 'url is required')
  const s = safeLink(u.trim())
  if (!s) throw new HttpError(400, 'url must be a valid http(s) URL')
  await assertPublicHttpUrl(s)
  return s
}

const KINDS = ['rss', 'atom', 'json', 'link'] as const

export async function createFeedSource(orgId: string, userId: string, body: Record<string, unknown>) {
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : null
  if (!name) throw new HttpError(400, 'name is required')
  const kind = KINDS.includes(body.kind as (typeof KINDS)[number]) ? (body.kind as FeedSourceRow['kind']) : 'rss'
  const res = await dbQuery<FeedSourceRow>(
    `INSERT INTO feed_sources (organization_id, name, url, kind, language, refresh_minutes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (organization_id, url) DO UPDATE SET name = EXCLUDED.name, kind = EXCLUDED.kind, active = true
     RETURNING *`,
    [
      orgId, name, await validUrl(body.url), kind,
      body.language === 'te' || body.language === 'en' ? body.language : null,
      Math.max(5, Math.min(24 * 60, Number(body.refresh_minutes ?? 30) || 30)), userId,
    ],
  )
  return res.rows[0]
}

export async function updateFeedSource(orgId: string, id: string, body: Record<string, unknown>) {
  const res = await dbQuery<FeedSourceRow>(
    `UPDATE feed_sources SET
       name = COALESCE($3, name), active = COALESCE($4, active), refresh_minutes = COALESCE($5, refresh_minutes),
       language = CASE WHEN $6::boolean THEN $7 ELSE language END
     WHERE id = $1 AND organization_id = $2 RETURNING *`,
    [
      id, orgId,
      typeof body.name === 'string' && body.name.trim() ? body.name.trim() : null,
      typeof body.active === 'boolean' ? body.active : null,
      body.refresh_minutes !== undefined ? Math.max(5, Number(body.refresh_minutes) || 30) : null,
      body.language !== undefined,
      body.language === 'te' || body.language === 'en' ? body.language : null,
    ],
  )
  if (!res.rows[0]) throw new HttpError(404, 'Feed source not found')
  return res.rows[0]
}

export async function deleteFeedSource(orgId: string, id: string) {
  const res = await dbQuery(`DELETE FROM feed_sources WHERE id = $1 AND organization_id = $2`, [id, orgId])
  if (!res.rowCount) throw new HttpError(404, 'Feed source not found')
}

export async function moderateFeedItem(orgId: string, id: string, body: { pinned?: boolean; hidden?: boolean }) {
  const res = await dbQuery(
    `UPDATE feed_items SET pinned = COALESCE($3, pinned), hidden = COALESCE($4, hidden)
     WHERE id = $1 AND organization_id = $2 RETURNING id, pinned, hidden`,
    [id, orgId, typeof body.pinned === 'boolean' ? body.pinned : null, typeof body.hidden === 'boolean' ? body.hidden : null],
  )
  if (!res.rows[0]) throw new HttpError(404, 'Feed item not found')
  return res.rows[0]
}

export async function addManualFeedItem(orgId: string, body: Record<string, unknown>) {
  const link = await validUrl(body.link ?? body.url)
  let item: ParsedItem
  try {
    item = await fetchLinkPreview(link)
  } catch {
    item = { guid: link, title: link, link, summary: null, image_url: null, published_at: null }
  }
  if (typeof body.title === 'string' && body.title.trim()) item.title = body.title.trim()
  if (typeof body.summary === 'string') item.summary = body.summary.trim() || null
  const guid = crypto.createHash('sha256').update(`manual:${link}`).digest('hex')
  const res = await dbQuery(
    `INSERT INTO feed_items (organization_id, source_id, guid, title, link, summary, image_url, language, published_at, pinned)
     VALUES ($1,NULL,$2,$3,$4,$5,$6,$7,COALESCE($8::timestamptz, now()),$9)
     ON CONFLICT (organization_id, guid) DO UPDATE SET title = EXCLUDED.title, summary = EXCLUDED.summary, hidden = false
     RETURNING *`,
    [orgId, guid, item.title.slice(0, 500), item.link, item.summary, item.image_url,
     body.language === 'te' || body.language === 'en' ? body.language : null, item.published_at, body.pinned === true],
  )
  return res.rows[0]
}
