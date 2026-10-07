import { dbQuery } from '@/lib/db.js'
import { HttpError, assertPublicHttpUrl } from '../common.js'

/**
 * Authority directory refresh from published sources (JSON or CSV URLs).
 * Records are upserted by (source_id, external_ref); contacts that disappear
 * from the source are marked outdated rather than deleted, so history and
 * routing explanations stay intact.
 */

export interface DirectorySourceRow {
  id: string
  organization_id: string
  name: string
  url: string
  format: 'json' | 'csv'
  field_map_json: FieldMap | null
  refresh_interval_hours: number
  active: boolean
  last_fetched_at: string | null
  last_status: string | null
  last_error: string | null
  last_stats_json: unknown
}

/** Maps our fields → source column/key names. `records_path` is a dot path to the array in JSON. */
export interface FieldMap {
  records_path?: string
  external_ref?: string
  contact_name?: string
  organization_name?: string
  role_designation?: string
  department?: string
  email?: string
  phone?: string
  whatsapp?: string
  jurisdiction_level?: string
  escalation_level?: string
  territory_name?: string
  territory_code?: string
  categories?: string
}

const DEFAULT_MAP: Required<Omit<FieldMap, 'records_path'>> = {
  external_ref: 'id',
  contact_name: 'name',
  organization_name: 'office',
  role_designation: 'designation',
  department: 'department',
  email: 'email',
  phone: 'phone',
  whatsapp: 'whatsapp',
  jurisdiction_level: 'jurisdiction_level',
  escalation_level: 'escalation_level',
  territory_name: 'territory',
  territory_code: 'territory_code',
  categories: 'categories',
}

const MAX_RECORDS = 5000

export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"'
        i++
      } else if (ch === '"') {
        quoted = false
      } else {
        field += ch
      }
      continue
    }
    if (ch === '"') quoted = true
    else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      field = ''
      if (row.some((c) => c.trim() !== '')) rows.push(row)
      row = []
    } else field += ch
  }
  row.push(field)
  if (row.some((c) => c.trim() !== '')) rows.push(row)
  const [header, ...data] = rows
  if (!header) return []
  const keys = header.map((h) => h.trim())
  return data.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? '').trim()])))
}

function getPath(obj: unknown, path: string | undefined): unknown {
  if (!path) return obj
  return path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj)
}

function pick(rec: Record<string, unknown>, key: string | undefined): string | null {
  if (!key) return null
  const v = rec[key]
  if (v == null) return null
  const s = String(v).trim()
  return s || null
}

function normEmail(s: string | null): string | null {
  if (!s) return null
  const e = s.trim().toLowerCase()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null
}

function normPhone(s: string | null): string | null {
  if (!s) return null
  const digits = s.replace(/[^\d+]/g, '')
  if (!digits) return null
  if (digits.startsWith('+')) return digits
  const d = digits.replace(/^0+/, '')
  return d.length === 10 ? `+91${d}` : d.length === 12 && d.startsWith('91') ? `+${d}` : digits
}

async function fetchRecords(src: DirectorySourceRow): Promise<Record<string, unknown>[]> {
  await assertPublicHttpUrl(src.url)
  const res = await fetch(src.url, { redirect: 'error', signal: AbortSignal.timeout(30_000), headers: { 'User-Agent': 'BharosaDirectoryBot/1.0' } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const text = await res.text()
  if (src.format === 'csv') return parseCsv(text).slice(0, MAX_RECORDS)
  const json = JSON.parse(text) as unknown
  const arr = getPath(json, src.field_map_json?.records_path)
  if (!Array.isArray(arr)) throw new Error('JSON records not found (check field_map.records_path)')
  return (arr as Record<string, unknown>[]).slice(0, MAX_RECORDS)
}

async function resolveTerritory(orgId: string, name: string | null, code: string | null, cache: Map<string, string | null>): Promise<string | null> {
  const key = `${code ?? ''}|${name ?? ''}`.toLowerCase()
  if (cache.has(key)) return cache.get(key)!
  let id: string | null = null
  if (code) {
    id = (await dbQuery<{ id: string }>(`SELECT id FROM territories WHERE organization_id = $1 AND lower(code) = lower($2) AND active LIMIT 1`, [orgId, code])).rows[0]?.id ?? null
  }
  if (!id && name) {
    id = (await dbQuery<{ id: string }>(`SELECT id FROM territories WHERE organization_id = $1 AND lower(name) = lower($2) AND active LIMIT 1`, [orgId, name])).rows[0]?.id ?? null
  }
  cache.set(key, id)
  return id
}

export async function refreshDirectorySource(src: DirectorySourceRow) {
  const map = { ...DEFAULT_MAP, ...(src.field_map_json ?? {}) }
  const stats = { fetched: 0, created: 0, updated: 0, skipped: 0, outdated: 0, unmatched_territories: 0 }
  const startedAt = new Date().toISOString()
  try {
    const records = await fetchRecords(src)
    stats.fetched = records.length
    const territoryCache = new Map<string, string | null>()

    for (const rec of records) {
      const name = pick(rec, map.contact_name)
      const email = normEmail(pick(rec, map.email))
      const phone = normPhone(pick(rec, map.phone))
      if (!name || (!email && !phone)) {
        stats.skipped++
        continue
      }
      const office = pick(rec, map.organization_name)
      const designation = pick(rec, map.role_designation)
      const externalRef = pick(rec, map.external_ref) ?? `${(office ?? '').toLowerCase()}|${(designation ?? name).toLowerCase()}|${email ?? phone}`
      const escalationLevel = Number(pick(rec, map.escalation_level) ?? '1')

      const up = await dbQuery<{ id: string; inserted: boolean }>(
        `INSERT INTO directory_contacts (organization_id, contact_name, organization_name, role_designation, department, email, phone,
                                         whatsapp, jurisdiction_level, escalation_level, is_public_authority, source_id, source_url,
                                         external_ref, verification_status, last_verified_at, active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,$11,$12,$13,'verified',now(),true)
         ON CONFLICT (source_id, external_ref) WHERE source_id IS NOT NULL AND external_ref IS NOT NULL DO UPDATE SET
           contact_name = EXCLUDED.contact_name, organization_name = EXCLUDED.organization_name,
           role_designation = EXCLUDED.role_designation, department = EXCLUDED.department,
           email = EXCLUDED.email, phone = EXCLUDED.phone, whatsapp = EXCLUDED.whatsapp,
           jurisdiction_level = EXCLUDED.jurisdiction_level, escalation_level = EXCLUDED.escalation_level,
           last_verified_at = now(), active = true, archived_at = NULL,
           -- A changed email resets bounce history; an unchanged bounced address stays outdated.
           bounce_count = CASE WHEN directory_contacts.email IS DISTINCT FROM EXCLUDED.email THEN 0 ELSE directory_contacts.bounce_count END,
           verification_status = CASE WHEN directory_contacts.email IS DISTINCT FROM EXCLUDED.email OR directory_contacts.bounce_count < 2
                                      THEN 'verified' ELSE directory_contacts.verification_status END,
           updated_at = now()
         RETURNING id, (xmax = 0) AS inserted`,
        [
          src.organization_id, name, office, designation, pick(rec, map.department), email, phone,
          normPhone(pick(rec, map.whatsapp)), pick(rec, map.jurisdiction_level),
          Number.isFinite(escalationLevel) && escalationLevel > 0 ? Math.floor(escalationLevel) : 1,
          src.id, src.url, externalRef,
        ],
      )
      const row = up.rows[0]
      if (row.inserted) stats.created++
      else stats.updated++

      const territoryId = await resolveTerritory(src.organization_id, pick(rec, map.territory_name), pick(rec, map.territory_code), territoryCache)
      if (territoryId) {
        await dbQuery(
          `INSERT INTO directory_contact_territories (contact_id, territory_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [row.id, territoryId],
        )
      } else if (pick(rec, map.territory_name) || pick(rec, map.territory_code)) {
        stats.unmatched_territories++
      }

      const cats = pick(rec, map.categories)
      if (cats) {
        for (const c of cats.split(/[;,|]/).map((x) => x.trim()).filter(Boolean).slice(0, 20)) {
          await dbQuery(
            `INSERT INTO directory_contact_tags (contact_id, tag_type, tag_value) VALUES ($1,'category',$2) ON CONFLICT DO NOTHING`,
            [row.id, c],
          )
        }
      }
      const dept = pick(rec, map.department)
      if (dept) {
        await dbQuery(
          `INSERT INTO directory_contact_tags (contact_id, tag_type, tag_value) VALUES ($1,'department',$2) ON CONFLICT DO NOTHING`,
          [row.id, dept],
        )
      }
    }

    if (stats.fetched > 0) {
      const gone = await dbQuery(
        `UPDATE directory_contacts SET verification_status = 'outdated', valid_until = now(), updated_at = now()
         WHERE source_id = $1 AND active = true AND (last_verified_at IS NULL OR last_verified_at < $2::timestamptz)
           AND verification_status <> 'outdated'`,
        [src.id, startedAt],
      )
      stats.outdated = gone.rowCount ?? 0
    }

    await dbQuery(
      `UPDATE directory_sources SET last_fetched_at = now(), last_status = 'ok', last_error = NULL, last_stats_json = $2 WHERE id = $1`,
      [src.id, JSON.stringify(stats)],
    )
    return stats
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await dbQuery(
      `UPDATE directory_sources SET last_fetched_at = now(), last_status = 'error', last_error = $2, last_stats_json = $3 WHERE id = $1`,
      [src.id, msg.slice(0, 1000), JSON.stringify(stats)],
    )
    throw err
  }
}

/** Scheduler entry: refresh every due source for an org (or all orgs). */
export async function refreshDueDirectorySources(orgId?: string | null) {
  const res = await dbQuery<DirectorySourceRow>(
    `SELECT * FROM directory_sources
     WHERE active = true AND ($1::uuid IS NULL OR organization_id = $1)
       AND (last_fetched_at IS NULL OR last_fetched_at < now() - make_interval(hours => refresh_interval_hours))
     ORDER BY last_fetched_at NULLS FIRST LIMIT 20`,
    [orgId ?? null],
  )
  const out: Array<{ id: string; ok: boolean; stats?: unknown; error?: string }> = []
  for (const src of res.rows) {
    try {
      out.push({ id: src.id, ok: true, stats: await refreshDirectorySource(src) })
    } catch (err) {
      out.push({ id: src.id, ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return out
}

export async function listDirectorySources(orgId: string) {
  return (await dbQuery<DirectorySourceRow>(`SELECT * FROM directory_sources WHERE organization_id = $1 ORDER BY created_at DESC`, [orgId])).rows
}

export async function getDirectorySource(orgId: string, id: string) {
  const res = await dbQuery<DirectorySourceRow>(`SELECT * FROM directory_sources WHERE id = $1 AND organization_id = $2`, [id, orgId])
  if (!res.rows[0]) throw new HttpError(404, 'Directory source not found')
  return res.rows[0]
}

async function validUrl(u: unknown): Promise<string> {
  if (typeof u !== 'string') throw new HttpError(400, 'url is required')
  return (await assertPublicHttpUrl(u.trim())).toString()
}

export async function createDirectorySource(orgId: string, userId: string, body: Record<string, unknown>) {
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : null
  if (!name) throw new HttpError(400, 'name is required')
  const format = body.format === 'csv' ? 'csv' : 'json'
  const hours = Math.max(1, Math.min(24 * 90, Number(body.refresh_interval_hours ?? 168) || 168))
  const res = await dbQuery<DirectorySourceRow>(
    `INSERT INTO directory_sources (organization_id, name, url, format, field_map_json, refresh_interval_hours, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [orgId, name, await validUrl(body.url), format, body.field_map ? JSON.stringify(body.field_map) : null, hours, userId],
  )
  return res.rows[0]
}

export async function updateDirectorySource(orgId: string, id: string, body: Record<string, unknown>) {
  const cur = await getDirectorySource(orgId, id)
  const res = await dbQuery<DirectorySourceRow>(
    `UPDATE directory_sources SET name = $3, url = $4, format = $5, field_map_json = $6, refresh_interval_hours = $7, active = $8
     WHERE id = $1 AND organization_id = $2 RETURNING *`,
    [
      id, orgId,
      typeof body.name === 'string' && body.name.trim() ? body.name.trim() : cur.name,
      body.url !== undefined ? await validUrl(body.url) : cur.url,
      body.format === 'csv' || body.format === 'json' ? body.format : cur.format,
      body.field_map !== undefined ? JSON.stringify(body.field_map) : cur.field_map_json ? JSON.stringify(cur.field_map_json) : null,
      body.refresh_interval_hours !== undefined ? Math.max(1, Number(body.refresh_interval_hours) || cur.refresh_interval_hours) : cur.refresh_interval_hours,
      typeof body.active === 'boolean' ? body.active : cur.active,
    ],
  )
  return res.rows[0]
}

/** Contacts whose data is stale or bouncing — the directory hygiene worklist. */
export async function directoryHealth(orgId: string) {
  const res = await dbQuery(
    `SELECT id, contact_name, organization_name, role_designation, email, verification_status, bounce_count,
            last_bounced_at, last_verified_at, source_id
     FROM directory_contacts
     WHERE organization_id = $1 AND active = true AND archived_at IS NULL
       AND (verification_status = 'outdated' OR bounce_count > 0 OR email IS NULL
            OR last_verified_at IS NULL OR last_verified_at < now() - interval '180 days')
     ORDER BY bounce_count DESC, last_verified_at NULLS FIRST LIMIT 500`,
    [orgId],
  )
  return res.rows
}
