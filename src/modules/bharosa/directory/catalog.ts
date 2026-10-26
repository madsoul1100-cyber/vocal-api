import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Read-only view of published board directories saved under data/directory.
 * Staff use this to check a department and see who can be emailed and who
 * only has a phone number, before those rows are loaded into the live directory.
 */

const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../data/directory')

export type CatalogChannel = 'mail' | 'number' | 'both'

export interface CatalogContact {
  id: string
  name: string
  office: string
  designation: string
  department: string
  email: string
  phone: string
  channel: CatalogChannel
  categories: string
  escalation_level: number
  source_url: string
}

export interface CatalogDepartment {
  name: string
  total: number
  mail: number
  number_only: number
}

export interface CatalogSummary {
  id: string
  name: string
  fetched_at: string | null
  total: number
  mail: number
  number_only: number
  departments: CatalogDepartment[]
}

interface CachedCatalog {
  mtimeMs: number
  summary: CatalogSummary
  contacts: CatalogContact[]
}

const cache = new Map<string, CachedCatalog>()

function channelOf(email: string, phone: string): CatalogChannel {
  if (email && phone) return 'both'
  if (email) return 'mail'
  return 'number'
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function loadCatalog(id: string): CachedCatalog | null {
  if (!/^[a-z0-9-]+$/.test(id)) return null
  const file = path.join(DATA_DIR, `${id}.json`)
  let mtimeMs = 0
  try {
    mtimeMs = statSync(file).mtimeMs
  } catch {
    return null
  }
  const hit = cache.get(id)
  if (hit && hit.mtimeMs === mtimeMs) return hit

  const raw = JSON.parse(readFileSync(file, 'utf8')) as {
    source?: { name?: string; fetched_at?: string }
    records?: unknown[]
  }
  const contacts: CatalogContact[] = []
  for (const row of raw.records ?? []) {
    if (!row || typeof row !== 'object') continue
    const rec = row as Record<string, unknown>
    const email = asText(rec.email)
    const phone = asText(rec.phone)
    const name = asText(rec.name)
    if (!name || (!email && !phone)) continue
    contacts.push({
      id: asText(rec.id) || `${contacts.length}`,
      name,
      office: asText(rec.office),
      designation: asText(rec.designation),
      department: asText(rec.department) || 'Unspecified',
      email,
      phone,
      channel: channelOf(email, phone),
      categories: asText(rec.categories),
      escalation_level: Number(rec.escalation_level) || 1,
      source_url: asText(rec.source_url),
    })
  }

  const byDept = new Map<string, CatalogDepartment>()
  let mail = 0
  let numberOnly = 0
  for (const contact of contacts) {
    const hasMail = contact.channel !== 'number'
    if (hasMail) mail += 1
    else numberOnly += 1
    const dept = byDept.get(contact.department) ?? {
      name: contact.department,
      total: 0,
      mail: 0,
      number_only: 0,
    }
    dept.total += 1
    if (hasMail) dept.mail += 1
    else dept.number_only += 1
    byDept.set(contact.department, dept)
  }

  const loaded: CachedCatalog = {
    mtimeMs,
    contacts,
    summary: {
      id,
      name: asText(raw.source?.name) || id,
      fetched_at: asText(raw.source?.fetched_at) || null,
      total: contacts.length,
      mail,
      number_only: numberOnly,
      departments: [...byDept.values()].sort((a, b) => a.name.localeCompare(b.name)),
    },
  }
  cache.set(id, loaded)
  return loaded
}

export function listCatalogs(): CatalogSummary[] {
  let names: string[] = []
  try {
    names = readdirSync(DATA_DIR)
  } catch {
    return []
  }
  const summaries: CatalogSummary[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const loaded = loadCatalog(name.slice(0, -'.json'.length))
    if (loaded) summaries.push(loaded.summary)
  }
  return summaries.sort((a, b) => a.name.localeCompare(b.name))
}

export function queryCatalog(
  id: string,
  opts: { department?: string; channel?: string; search?: string; limit: number; offset: number },
): { summary: CatalogSummary; contacts: CatalogContact[]; total: number } | null {
  const loaded = loadCatalog(id)
  if (!loaded) return null
  const department = opts.department?.trim()
  const search = opts.search?.trim().toLowerCase()
  const channel = opts.channel?.trim()
  const filtered = loaded.contacts.filter((contact) => {
    if (department && contact.department !== department) return false
    if (channel === 'mail' && contact.channel === 'number') return false
    if (channel === 'number' && contact.channel !== 'number') return false
    if (channel === 'both' && contact.channel !== 'both') return false
    if (!search) return true
    const blob = `${contact.name} ${contact.office} ${contact.designation} ${contact.email} ${contact.phone} ${contact.department}`.toLowerCase()
    return blob.includes(search)
  })
  return {
    summary: loaded.summary,
    total: filtered.length,
    contacts: filtered.slice(opts.offset, opts.offset + opts.limit),
  }
}
