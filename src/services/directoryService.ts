import { createSupabaseServiceClient } from '@/lib/supabase.js'
import { isPostgresMode, dbQuery } from '@/lib/db.js'

const WRITE_ROLES = ['super_admin', 'central_support']

export function canWriteDirectory(role: string | null | undefined): boolean {
  return !!role && WRITE_ROLES.includes(role)
}

function clean(v: unknown, max = 200): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim().slice(0, max)
  return s.length ? s : null
}

export interface DirectoryContact {
  id: string
  contact_name: string
  organization_name: string | null
  role_designation: string | null
  phone: string | null
  phone_alternate: string | null
  email: string | null
  availability_notes: string | null
  internal_notes: string | null
  verification_status: string
  active: boolean
}

export async function listDirectoryContacts(
  orgId: string,
  opts: { search?: string; status?: string } = {},
): Promise<{ contacts: DirectoryContact[]; count: number }> {
  if (isPostgresMode()) {
    return listDirectoryContactsPg(orgId, opts)
  }
  return listDirectoryContactsSupabase(orgId, opts)
}

async function listDirectoryContactsPg(
  orgId: string,
  opts: { search?: string; status?: string },
): Promise<{ contacts: DirectoryContact[]; count: number }> {
  const params: unknown[] = [orgId]
  let where = 'organization_id = $1 AND active = true'
  let i = 2

  if (opts.status && opts.status !== 'all') {
    where += ` AND verification_status = $${i++}`
    params.push(opts.status)
  }

  if (opts.search) {
    const safe = opts.search
      .replace(/[,()."'\\]/g, ' ')
      .replace(/[%_]/g, '')
      .trim()
      .slice(0, 100)
    if (safe) {
      const pattern = `%${safe}%`
      where += ` AND (contact_name ILIKE $${i} OR organization_name ILIKE $${i} OR role_designation ILIKE $${i})`
      params.push(pattern)
      i++
    }
  }

  const countRes = await dbQuery<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM directory_contacts WHERE ${where}`,
    params,
  )
  const count = Number(countRes.rows[0]?.c ?? 0)

  const res = await dbQuery<DirectoryContact>(
    `SELECT id, contact_name, organization_name, role_designation, phone, phone_alternate,
            email, availability_notes, internal_notes, verification_status, active
     FROM directory_contacts
     WHERE ${where}
     ORDER BY contact_name ASC
     LIMIT 200`,
    params,
  )

  return { contacts: res.rows, count }
}

async function listDirectoryContactsSupabase(
  orgId: string,
  opts: { search?: string; status?: string },
): Promise<{ contacts: DirectoryContact[]; count: number }> {
  const supabase = createSupabaseServiceClient()
  let query = supabase
    .from('directory_contacts')
    .select(
      'id, contact_name, organization_name, role_designation, phone, phone_alternate, email, availability_notes, internal_notes, verification_status, active',
      { count: 'exact' },
    )
    .eq('organization_id', orgId)
    .eq('active', true)
    .order('contact_name', { ascending: true })
    .limit(200)

  if (opts.status && opts.status !== 'all') {
    query = query.eq('verification_status', opts.status)
  }

  if (opts.search) {
    const safe = opts.search
      .replace(/[,()."'\\]/g, ' ')
      .replace(/[%_]/g, '\\$&')
      .trim()
      .slice(0, 100)
    if (safe) {
      query = query.or(
        `contact_name.ilike.%${safe}%,organization_name.ilike.%${safe}%,role_designation.ilike.%${safe}%`,
      )
    }
  }

  const { data, count } = await query
  return { contacts: (data ?? []) as DirectoryContact[], count: count ?? 0 }
}

// --- v2 list (pagination, keyword, category) ---

export const DIRECTORY_V2_DEFAULT_LIMIT = 20
export const DIRECTORY_V2_MAX_LIMIT = 100

export interface DirectoryListV2Options {
  limit: number
  offset: number
  keyword?: string
  category?: string
  status?: string
}

export interface DirectoryContactV2 extends DirectoryContact {
  categories: string[]
}

export interface DirectoryListV2Result {
  contacts: DirectoryContactV2[]
  pagination: {
    limit: number
    offset: number
    total: number
    hasNextPage: boolean
    hasPreviousPage: boolean
  }
}

function sanitizeDirectoryKeyword(raw: string): string {
  return raw
    .replace(/[,()."'\\]/g, ' ')
    .replace(/[%_]/g, '')
    .trim()
    .slice(0, 100)
}

function sanitizeDirectoryCategory(raw: string): string {
  return raw.trim().slice(0, 120)
}

export function parseDirectoryV2ListQuery(query: Record<string, unknown>): DirectoryListV2Options {
  let limit =
    parseInt(String(query.limit ?? DIRECTORY_V2_DEFAULT_LIMIT), 10) ||
    DIRECTORY_V2_DEFAULT_LIMIT
  limit = Math.min(DIRECTORY_V2_MAX_LIMIT, Math.max(1, limit))
  const offset = Math.max(0, parseInt(String(query.offset ?? '0'), 10) || 0)

  const keywordRaw =
    (typeof query.keyword === 'string' && query.keyword) ||
    (typeof query.search === 'string' && query.search) ||
    undefined
  const keyword = keywordRaw ? sanitizeDirectoryKeyword(keywordRaw) : undefined

  const categoryRaw = typeof query.category === 'string' ? query.category : undefined
  const category = categoryRaw ? sanitizeDirectoryCategory(categoryRaw) : undefined

  const status =
    typeof query.status === 'string' && query.status.trim() ? query.status.trim() : undefined

  return {
    limit,
    offset,
    keyword: keyword || undefined,
    category: category || undefined,
    status,
  }
}

function buildDirectoryV2Pagination(
  offset: number,
  limit: number,
  total: number,
): DirectoryListV2Result['pagination'] {
  return {
    limit,
    offset,
    total,
    hasNextPage: offset + limit < total,
    hasPreviousPage: offset > 0,
  }
}

async function attachContactCategories(
  contacts: DirectoryContact[],
): Promise<DirectoryContactV2[]> {
  if (!contacts.length) return []

  const ids = contacts.map((c) => c.id)

  if (isPostgresMode()) {
    const tagRes = await dbQuery<{ contact_id: string; tag_value: string }>(
      `SELECT contact_id, tag_value
       FROM directory_contact_tags
       WHERE tag_type = 'category' AND contact_id = ANY($1::uuid[])
       ORDER BY tag_value ASC`,
      [ids],
    )
    const byContact = new Map<string, string[]>()
    for (const row of tagRes.rows) {
      const list = byContact.get(row.contact_id) ?? []
      list.push(row.tag_value)
      byContact.set(row.contact_id, list)
    }
    return contacts.map((c) => ({
      ...c,
      categories: byContact.get(c.id) ?? [],
    }))
  }

  const supabase = createSupabaseServiceClient()
  const { data: tags } = await supabase
    .from('directory_contact_tags')
    .select('contact_id, tag_value')
    .eq('tag_type', 'category')
    .in('contact_id', ids)

  const byContact = new Map<string, string[]>()
  for (const row of tags ?? []) {
    const list = byContact.get(row.contact_id as string) ?? []
    list.push(row.tag_value as string)
    byContact.set(row.contact_id as string, list)
  }
  return contacts.map((c) => ({
    ...c,
    categories: byContact.get(c.id) ?? [],
  }))
}

function appendDirectoryV2Filters(
  where: string,
  params: unknown[],
  paramIndex: { i: number },
  opts: Pick<DirectoryListV2Options, 'status' | 'keyword' | 'category'>,
  tableAlias = 'directory_contacts',
): string {
  let clause = where

  if (opts.status && opts.status !== 'all') {
    clause += ` AND ${tableAlias}.verification_status = $${paramIndex.i++}`
    params.push(opts.status)
  }

  if (opts.keyword) {
    const pattern = `%${opts.keyword}%`
    clause += ` AND (
      ${tableAlias}.contact_name ILIKE $${paramIndex.i}
      OR ${tableAlias}.organization_name ILIKE $${paramIndex.i}
      OR ${tableAlias}.role_designation ILIKE $${paramIndex.i}
      OR ${tableAlias}.email ILIKE $${paramIndex.i}
      OR ${tableAlias}.phone ILIKE $${paramIndex.i}
      OR ${tableAlias}.phone_alternate ILIKE $${paramIndex.i}
    )`
    params.push(pattern)
    paramIndex.i++
  }

  if (opts.category) {
    const pattern = `%${opts.category.replace(/[%_]/g, '')}%`
    clause += ` AND EXISTS (
      SELECT 1 FROM directory_contact_tags dct
      WHERE dct.contact_id = ${tableAlias}.id
        AND dct.tag_type = 'category'
        AND dct.tag_value ILIKE $${paramIndex.i++}
    )`
    params.push(pattern)
  }

  return clause
}

async function listDirectoryContactsV2Pg(
  orgId: string,
  opts: DirectoryListV2Options,
): Promise<DirectoryListV2Result> {
  const params: unknown[] = [orgId]
  const paramIndex = { i: 2 }
  let where = appendDirectoryV2Filters(
    'directory_contacts.organization_id = $1 AND directory_contacts.active = true',
    params,
    paramIndex,
    opts,
  )

  const countRes = await dbQuery<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM directory_contacts WHERE ${where}`,
    params,
  )
  const total = Number(countRes.rows[0]?.c ?? 0)

  const listParams = [...params, opts.limit, opts.offset]
  const limitParam = paramIndex.i++
  const offsetParam = paramIndex.i++

  const res = await dbQuery<DirectoryContact>(
    `SELECT directory_contacts.id, directory_contacts.contact_name,
            directory_contacts.organization_name, directory_contacts.role_designation,
            directory_contacts.phone, directory_contacts.phone_alternate,
            directory_contacts.email, directory_contacts.availability_notes,
            directory_contacts.internal_notes, directory_contacts.verification_status,
            directory_contacts.active
     FROM directory_contacts
     WHERE ${where}
     ORDER BY directory_contacts.contact_name ASC
     LIMIT $${limitParam} OFFSET $${offsetParam}`,
    listParams,
  )

  const contacts = await attachContactCategories(res.rows)
  return {
    contacts,
    pagination: buildDirectoryV2Pagination(opts.offset, opts.limit, total),
  }
}

async function listDirectoryContactsV2Supabase(
  orgId: string,
  opts: DirectoryListV2Options,
): Promise<DirectoryListV2Result> {
  const supabase = createSupabaseServiceClient()
  const selectBase =
    'id, contact_name, organization_name, role_designation, phone, phone_alternate, email, availability_notes, internal_notes, verification_status, active'

  let select = selectBase
  if (opts.category) {
    select = `${selectBase}, directory_contact_tags!inner(tag_type, tag_value)`
  }

  let query = supabase
    .from('directory_contacts')
    .select(select, { count: 'exact' })
    .eq('organization_id', orgId)
    .eq('active', true)
    .order('contact_name', { ascending: true })
    .range(opts.offset, opts.offset + opts.limit - 1)

  if (opts.status && opts.status !== 'all') {
    query = query.eq('verification_status', opts.status)
  }

  if (opts.category) {
    const safe = opts.category.replace(/[%_]/g, '\\$&')
    query = query
      .eq('directory_contact_tags.tag_type', 'category')
      .ilike('directory_contact_tags.tag_value', `%${safe}%`)
  }

  if (opts.keyword) {
    const safe = opts.keyword.replace(/[%_]/g, '\\$&')
    query = query.or(
      `contact_name.ilike.%${safe}%,organization_name.ilike.%${safe}%,role_designation.ilike.%${safe}%,email.ilike.%${safe}%,phone.ilike.%${safe}%,phone_alternate.ilike.%${safe}%`,
    )
  }

  const { data, count, error } = await query
  if (error) {
    throw new Error(error.message)
  }

  const rows = ((data ?? []) as unknown as Array<Record<string, unknown>>).map((record) => {
    const { directory_contact_tags: _tags, ...rest } = record
    return rest as unknown as DirectoryContact
  })

  const contacts = await attachContactCategories(rows)
  const total = count ?? 0

  return {
    contacts,
    pagination: buildDirectoryV2Pagination(opts.offset, opts.limit, total),
  }
}

export async function listDirectoryContactsV2(
  orgId: string,
  opts: DirectoryListV2Options,
): Promise<DirectoryListV2Result> {
  if (isPostgresMode()) {
    return listDirectoryContactsV2Pg(orgId, opts)
  }
  return listDirectoryContactsV2Supabase(orgId, opts)
}

export async function createDirectoryContact(
  user: { id: string; organization_id: string; roles?: { name: string } | null },
  body: Record<string, unknown>,
) {
  if (!canWriteDirectory(user.roles?.name)) {
    return { ok: false as const, status: 403, error: 'Insufficient role' }
  }

  const contact_name = clean(body.contact_name, 200)
  if (!contact_name) {
    return { ok: false as const, status: 400, error: 'contact_name is required' }
  }

  const verification_status = ['unverified', 'verified', 'outdated'].includes(
    String(body.verification_status),
  )
    ? String(body.verification_status)
    : 'unverified'

  const supabase = createSupabaseServiceClient()
  const insert = {
    organization_id: user.organization_id,
    contact_name,
    organization_name: clean(body.organization_name, 200),
    role_designation: clean(body.role_designation, 120),
    phone: clean(body.phone, 40),
    phone_alternate: clean(body.phone_alternate, 40),
    email: clean(body.email, 200),
    availability_notes: clean(body.availability_notes, 500),
    internal_notes: clean(body.internal_notes, 1000),
    verification_status,
    active: true,
    created_by: user.id,
  }

  const { data, error } = await supabase.from('directory_contacts').insert(insert).select('id').single()
  if (error || !data) {
    return { ok: false as const, status: 500, error: error?.message ?? 'Insert failed' }
  }

  await supabase.from('audit_logs').insert({
    organization_id: user.organization_id,
    event_type: 'directory_contact_created',
    entity_type: 'directory_contact',
    entity_id: data.id,
    actor_type: 'user',
    actor_user_id: user.id,
    new_value_json: { contact_name, organization_name: insert.organization_name },
  })

  return { ok: true as const, id: data.id as string }
}

export async function updateDirectoryContact(
  user: { id: string; organization_id: string; roles?: { name: string } | null },
  contactId: string,
  body: Record<string, unknown>,
) {
  if (!canWriteDirectory(user.roles?.name)) {
    return { ok: false as const, status: 403, error: 'Insufficient role' }
  }

  const supabase = createSupabaseServiceClient()
  const { data: current } = await supabase
    .from('directory_contacts')
    .select('id, organization_id')
    .eq('id', contactId)
    .single()

  if (!current || current.organization_id !== user.organization_id) {
    return { ok: false as const, status: 404, error: 'Contact not found' }
  }

  const updates: Record<string, unknown> = {
    updated_by: user.id,
    updated_at: new Date().toISOString(),
  }

  const name = clean(body.contact_name, 200)
  if (name) updates.contact_name = name
  if ('organization_name' in body) updates.organization_name = clean(body.organization_name, 200)
  if ('role_designation' in body) updates.role_designation = clean(body.role_designation, 120)
  if ('phone' in body) updates.phone = clean(body.phone, 40)
  if ('phone_alternate' in body) updates.phone_alternate = clean(body.phone_alternate, 40)
  if ('email' in body) updates.email = clean(body.email, 200)
  if ('availability_notes' in body) updates.availability_notes = clean(body.availability_notes, 500)
  if ('internal_notes' in body) updates.internal_notes = clean(body.internal_notes, 1000)

  if (
    typeof body.verification_status === 'string' &&
    ['unverified', 'verified', 'outdated'].includes(body.verification_status)
  ) {
    updates.verification_status = body.verification_status
  }

  const { error } = await supabase
    .from('directory_contacts')
    .update(updates)
    .eq('id', contactId)
    .eq('organization_id', user.organization_id)

  if (error) return { ok: false as const, status: 500, error: error.message }

  await supabase.from('audit_logs').insert({
    organization_id: user.organization_id,
    event_type: 'directory_contact_updated',
    entity_type: 'directory_contact',
    entity_id: contactId,
    actor_type: 'user',
    actor_user_id: user.id,
    new_value_json: updates,
  })

  return { ok: true as const }
}

export async function archiveDirectoryContact(
  user: { id: string; organization_id: string; roles?: { name: string } | null },
  contactId: string,
) {
  if (!canWriteDirectory(user.roles?.name)) {
    return { ok: false as const, status: 403, error: 'Insufficient role' }
  }

  const supabase = createSupabaseServiceClient()
  const { data: current } = await supabase
    .from('directory_contacts')
    .select('id, organization_id')
    .eq('id', contactId)
    .single()

  if (!current || current.organization_id !== user.organization_id) {
    return { ok: false as const, status: 404, error: 'Contact not found' }
  }

  const now = new Date().toISOString()
  const { error } = await supabase
    .from('directory_contacts')
    .update({
      active: false,
      archived_by: user.id,
      archived_at: now,
      updated_by: user.id,
      updated_at: now,
    })
    .eq('id', contactId)
    .eq('organization_id', user.organization_id)

  if (error) return { ok: false as const, status: 500, error: error.message }

  await supabase.from('audit_logs').insert({
    organization_id: user.organization_id,
    event_type: 'directory_contact_archived',
    entity_type: 'directory_contact',
    entity_id: contactId,
    actor_type: 'user',
    actor_user_id: user.id,
  })

  return { ok: true as const }
}
