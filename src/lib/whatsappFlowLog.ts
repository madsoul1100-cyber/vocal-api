/**
 * Structured logs for WhatsApp → backend flow tracing.
 *
 * Enable (default): logs on
 * Disable: WHATSAPP_FLOW_LOG=0 or WHATSAPP_FLOW_LOG=false
 */

import { findNearestAvailableWorker, offerTicketToWorker } from '@/services/assignmentService.js'

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

/** After WhatsApp ticket create: nearest-worker offer (same as script + AI intake). */
export async function whatsappAutoOfferWorker(args: {
  ticketId: string
  ticketNumber: string
  intake: 'script' | 'ai'
}): Promise<void> {
  const { ticketId, ticketNumber, intake } = args
  waLog('assign.start', 'finding nearest worker', { ticketId, ticketNumber, intake })
  try {
    const worker = await findNearestAvailableWorker(ticketId)
    if (!worker) {
      waLog('assign.skip', 'no eligible worker found', { ticketId, ticketNumber, intake })
      return
    }
    const offer = await offerTicketToWorker({
      ticketId,
      workerId: worker.id,
      assignedByUserId: null,
      reason: `Auto-assigned after WhatsApp intake (${intake})`,
    })
    if (offer.ok) {
      waLog('assign.ok', 'worker offered', {
        ticketId,
        ticketNumber,
        intake,
        workerId: worker.id,
        workerName: worker.full_name,
        assignmentId: offer.assignmentId,
        expiresAt: offer.expiresAt,
      })
    } else {
      waLog('assign.fail', offer.error, { ticketId, ticketNumber, intake, workerId: worker.id })
    }
  } catch (err) {
    waLogError('assign.error', 'auto-offer threw', err, { ticketId, ticketNumber, intake })
  }
}
