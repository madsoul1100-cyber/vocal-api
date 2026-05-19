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
