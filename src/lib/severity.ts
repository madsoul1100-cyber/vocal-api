import type { Severity } from '@/types/database.js'

export const TICKET_SEVERITIES: readonly Severity[] = ['critical', 'high', 'medium', 'low']

/** Used when AI/hint do not produce a severity at intake. */
export const DEFAULT_TICKET_SEVERITY: Severity = 'medium'

export function normalizeTicketSeverity(value: string | null | undefined): Severity | null {
  const s = value?.trim().toLowerCase()
  if (!s) return null
  return TICKET_SEVERITIES.includes(s as Severity) ? (s as Severity) : null
}

export function isValidTicketSeverity(value: string): value is Severity {
  return TICKET_SEVERITIES.includes(value as Severity)
}
