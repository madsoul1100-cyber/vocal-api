/**
 * Structured logs for WhatsApp → backend flow tracing.
 *
 * Enable (default): logs on
 * Disable: WHATSAPP_FLOW_LOG=0 or WHATSAPP_FLOW_LOG=false
 */

import { intakeTerritoryAutoAssign } from '@/services/assignmentService.js'

const PREFIX = '[whatsappFlow]'

export function isWhatsAppFlowLogEnabled(): boolean {
  const v = (process.env.WHATSAPP_FLOW_LOG ?? 'true').trim().toLowerCase()
  return v !== '0' && v !== 'false' && v !== 'off'
}

/** Mask phone for logs: keep last 4 digits. */
export function maskWhatsAppUserId(channelUserId: string): string {
  const digits = channelUserId.replace(/\D/g, '')
  if (digits.length <= 4) return '****'
  return `***${digits.slice(-4)}`
}

export function waLog(
  phase: string,
  message: string,
  extra?: Record<string, unknown>,
): void {
  if (!isWhatsAppFlowLogEnabled()) return
  if (extra && Object.keys(extra).length > 0) {
    console.log(`${PREFIX} ${phase} | ${message}`, extra)
  } else {
    console.log(`${PREFIX} ${phase} | ${message}`)
  }
}

export function waLogError(
  phase: string,
  message: string,
  err: unknown,
  extra?: Record<string, unknown>,
): void {
  if (!isWhatsAppFlowLogEnabled()) return
  const detail = err instanceof Error ? err.message : String(err)
  console.error(`${PREFIX} ${phase} | ${message}`, { ...extra, error: detail })
}

/** After WhatsApp ticket create: territory-hierarchy direct assign. */
export async function whatsappAutoOfferWorker(args: {
  ticketId: string
  ticketNumber: string
  organizationId: string
  locationText?: string | null
  issueText?: string | null
  intake: 'script' | 'ai'
}): Promise<void> {
  const { ticketId, ticketNumber, organizationId, locationText, issueText, intake } = args
  waLog('assign.start', 'territory auto-assign', { ticketId, ticketNumber, intake })
  const result = await intakeTerritoryAutoAssign({
    ticketId,
    ticketNumber,
    organizationId,
    locationText,
    issueText,
    source: `whatsapp:${intake}`,
  })
  if (result.routed === 'direct') {
    waLog('assign.ok', 'territory worker assigned', {
      ticketId,
      ticketNumber,
      intake,
      workerId: result.workerId,
      matchedTerritoryId: result.matchedTerritoryId,
    })
  } else {
    waLog('assign.skip', result.reason ?? 'none', { ticketId, ticketNumber, intake })
  }
}
