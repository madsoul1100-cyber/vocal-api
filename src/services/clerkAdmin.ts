/**
 * Server-side Clerk user management (requires CLERK_SECRET_KEY).
 * Used when admins create staff via POST /v1/workers.
 */

const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY

function assertClerkConfigured(): void {
  if (!CLERK_SECRET_KEY) {
    throw new Error('CLERK_SECRET_KEY is not set on vocal-api')
  }
}

async function clerkFetch(pathname: string, init: RequestInit = {}) {
  assertClerkConfigured()
  const res = await fetch(`https://api.clerk.com/v1${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${CLERK_SECRET_KEY}`,
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

export async function createClerkUser(opts: {
  email: string
  password: string
  fullName: string
}): Promise<string> {
  const email = opts.email.trim().toLowerCase()
  const existing = await findClerkUserIdByEmail(email)
  if (existing) return existing

  const { firstName, lastName } = splitFullName(opts.fullName)
  const body = (await clerkFetch('/users', {
    method: 'POST',
    body: JSON.stringify({
      email_address: [email],
      password: opts.password,
      first_name: firstName,
      last_name: lastName,
      skip_password_checks: true,
    }),
  })) as { id: string }

  return body.id
}

export async function deleteClerkUser(clerkUserId: string): Promise<void> {
  try {
    await clerkFetch(`/users/${encodeURIComponent(clerkUserId)}`, { method: 'DELETE' })
  } catch {
    // Best-effort rollback
  }
}
