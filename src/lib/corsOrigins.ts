/** Fixed dev/prod origins (vocal-web, Flutter default, etc.) */
export const DEFAULT_CORS_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:3000',
  'http://localhost:8080',
]

/** Flutter web / local tools on any localhost port. */
const LOCALHOST_ORIGIN =
  /^https?:\/\/(localhost|127\.0\.0\.1):\d+$/

/** Vercel production + preview deployments (https://*.vercel.app). */
const VERCEL_ORIGIN = /^https:\/\/[\w-]+\.vercel\.app$/

export function getExtraCorsOrigins(): string[] {
  return process.env.CORS_ORIGINS?.split(',').map((s) => s.trim()).filter(Boolean) ?? []
}

/** Allow any http(s)://localhost:PORT and 127.0.0.1:PORT (local dev tools, Flutter web, etc.). */
export function isLocalhostOrigin(origin: string): boolean {
  return LOCALHOST_ORIGIN.test(origin)
}

function envFlagEnabled(name: string): boolean {
  const flag = process.env[name]?.trim().toLowerCase()
  return flag === 'true' || flag === '1' || flag === 'yes'
}

function isLocalhostCorsEnabled(): boolean {
  if (process.env.NODE_ENV !== 'production') return true
  return envFlagEnabled('ALLOW_LOCALHOST_CORS')
}

function isVercelCorsEnabled(): boolean {
  if (process.env.NODE_ENV !== 'production') return true
  return envFlagEnabled('ALLOW_VERCEL_CORS')
}

export function isVercelOrigin(origin: string): boolean {
  return VERCEL_ORIGIN.test(origin)
}

export function isAllowedCorsOrigin(origin: string): boolean {
  if (DEFAULT_CORS_ORIGINS.includes(origin)) return true
  if (getExtraCorsOrigins().includes(origin)) return true
  if (isLocalhostCorsEnabled() && isLocalhostOrigin(origin)) return true
  if (isVercelCorsEnabled() && isVercelOrigin(origin)) return true
  return false
}

