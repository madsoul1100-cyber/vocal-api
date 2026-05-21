/** Fixed dev/prod origins (vocal-web, Flutter default, etc.) */
export const DEFAULT_CORS_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:3000',
  'http://localhost:8080',
]

/** Flutter web / local tools on any localhost port (dev only). */
const LOCALHOST_ORIGIN =
  /^https?:\/\/(localhost|127\.0\.0\.1):\d+$/

export function getExtraCorsOrigins(): string[] {
  return process.env.CORS_ORIGINS?.split(',').map((s) => s.trim()).filter(Boolean) ?? []
}

export function isAllowedCorsOrigin(origin: string): boolean {
  if (DEFAULT_CORS_ORIGINS.includes(origin)) return true
  if (getExtraCorsOrigins().includes(origin)) return true
  if (process.env.NODE_ENV !== 'production' && LOCALHOST_ORIGIN.test(origin)) {
    return true
  }
  return false
}

/** Clerk `authorizedParties` — explicit URLs only (no regex). */
export function getClerkAuthorizedParties(): string[] {
  return [...new Set([...DEFAULT_CORS_ORIGINS, ...getExtraCorsOrigins()])]
}
