/**
 * Server-side Clerk user management (requires CLERK_SECRET_KEY).
 * Used when admins create staff via POST /v1/workers.
 */
import '../loadEnv.js'

function clerkSecretKey(): string {
  const key = process.env.CLERK_SECRET_KEY?.trim()
  if (!key) {
    throw new Error(
      'CLERK_SECRET_KEY is not set. Add it to vocal-api/.env.local (copy from vocal-app or Clerk dashboard).',
    )
  }
  return key
}

async function clerkFetch(pathname: string, init: RequestInit = {}) {
  const res = await fetch(`https://api.clerk.com/v1${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${clerkSecretKey()}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  const body = await res.json().catch(() => null)
  if (!res.ok) {
    const msg =
      (body as { errors?: { message?: string }[] })?.errors?.[0]?.message ?? res.statusText
    throw new Error(msg)
  }
  return body
}

export async function findClerkUserIdByEmail(email: string): Promise<string | null> {
  const normalized = email.trim().toLowerCase()
  const list = (await clerkFetch(
    `/users?email_address=${encodeURIComponent(normalized)}`,
  )) as { id: string }[]
  if (Array.isArray(list) && list.length > 0) return list[0].id
  return null
}

export function splitFullName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return { firstName: 'User', lastName: '' }
  if (parts.length === 1) return { firstName: parts[0], lastName: '' }
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') }
}

type ClerkUserPayload = {
  id: string
  email_addresses?: Array<{
    id: string
    verification?: { status?: string }
  }>
}

/** Mark emails verified and clear MFA so password sign-in does not stop at /sign-in/factor-one. */
export async function ensureClerkUserReadyForPasswordSignIn(clerkUserId: string): Promise<void> {
  let user: ClerkUserPayload
  try {
    user = (await clerkFetch(`/users/${encodeURIComponent(clerkUserId)}`)) as ClerkUserPayload
  } catch {
    return
  }

  for (const em of user.email_addresses ?? []) {
    if (em.verification?.status === 'verified') continue
    try {
      await clerkFetch(`/email_addresses/${encodeURIComponent(em.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ verified: true }),
      })
    } catch {
      // continue — Clerk may already treat API-created emails as verified
    }
  }

  try {
    await clerkFetch(`/users/${encodeURIComponent(clerkUserId)}/mfa`, { method: 'DELETE' })
  } catch {
    // MFA may not be enabled for this user
  }
}

export async function createClerkUser(opts: {
  email: string
  password: string
  fullName: string
}): Promise<string> {
  const email = opts.email.trim().toLowerCase()
  const existing = await findClerkUserIdByEmail(email)
  if (existing) {
    await ensureClerkUserReadyForPasswordSignIn(existing)
    return existing
  }

  const { firstName, lastName } = splitFullName(opts.fullName)
  const now = new Date().toISOString()
  const body = (await clerkFetch('/users', {
    method: 'POST',
    body: JSON.stringify({
      email_address: [email],
      password: opts.password,
      first_name: firstName,
      last_name: lastName,
      skip_password_checks: true,
      skip_legal_checks: true,
      legal_accepted_at: now,
    }),
  })) as { id: string }

  await ensureClerkUserReadyForPasswordSignIn(body.id)
  return body.id
}

/** Repair an existing Clerk user (verify email, disable MFA) — for accounts stuck on factor-one. */
export async function repairClerkAccountByEmail(email: string): Promise<string | null> {
  const id = await findClerkUserIdByEmail(email)
  if (!id) return null
  await ensureClerkUserReadyForPasswordSignIn(id)
  return id
}

export async function deleteClerkUser(clerkUserId: string): Promise<void> {
  try {
    await clerkFetch(`/users/${encodeURIComponent(clerkUserId)}`, { method: 'DELETE' })
  } catch {
    // Best-effort rollback
  }
}
