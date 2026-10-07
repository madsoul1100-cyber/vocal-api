import { dbQuery } from '@/lib/db.js'
import { HttpError } from '../common.js'
import { recordCaseEvent } from './events.js'

export type EscalationTrigger =
  | 'sla_breach'
  | 'no_reply'
  | 'bounce'
  | 'ai_uncertain'
  | 'citizen_reopen'
  | 'manual'
  | 'task_overdue'

/**
 * Open an escalation. `dedupeKey` keeps sweeps idempotent: at most one open
 * escalation per key.
 */
export async function createEscalation(args: {
  orgId: string
  ticketId?: string | null
  taskId?: string | null
  communicationId?: string | null
  target: 'gro' | 'authority'
  level?: number
  trigger: EscalationTrigger
  reason: string
  targetContactId?: string | null
  createdByAgent?: string | null
  createdBy?: string | null
  dedupeKey?: string | null
}): Promise<string | null> {
  const res = await dbQuery<{ id: string }>(
    `INSERT INTO escalations (organization_id, ticket_id, task_id, communication_id, target, level, trigger_type,
                              reason, target_contact_id, created_by_agent, created_by, dedupe_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT DO NOTHING RETURNING id`,
    [
      args.orgId, args.ticketId ?? null, args.taskId ?? null, args.communicationId ?? null, args.target,
      args.level ?? 1, args.trigger, args.reason.slice(0, 2000), args.targetContactId ?? null,
      args.createdByAgent ?? null, args.createdBy ?? null, args.dedupeKey ?? null,
    ],
  )
  const id = res.rows[0]?.id ?? null
  if (id && args.ticketId) {
    await recordCaseEvent({
      orgId: args.orgId,
      ticketId: args.ticketId,
      taskId: args.taskId,
      communicationId: args.communicationId,
      type: args.target === 'gro' ? 'escalated_to_gro' : 'escalated_to_authority',
      actorType: args.createdByAgent ? 'ai_agent' : args.createdBy ? 'user' : 'system',
      actorUserId: args.createdBy,
      actorLabel: args.createdByAgent,
      visibility: 'internal',
      reason: args.reason,
      data: { escalation_id: id, trigger: args.trigger, level: args.level ?? 1 },
    })
  }
  return id
}

export async function listEscalations(args: {
  orgId: string
  status?: string | null
  target?: string | null
  ticketId?: string | null
  limit: number
  offset: number
}) {
  const params: unknown[] = [args.orgId]
  let where = 'e.organization_id = $1'
  if (args.status) {
    params.push(args.status)
    where += ` AND e.status = $${params.length}`
  }
  if (args.target) {
    params.push(args.target)
    where += ` AND e.target = $${params.length}`
  }
  if (args.ticketId) {
    params.push(args.ticketId)
    where += ` AND e.ticket_id = $${params.length}`
  }
  const count = await dbQuery<{ c: string }>(`SELECT COUNT(*)::text AS c FROM escalations e WHERE ${where}`, params)
  params.push(args.limit, args.offset)
  const res = await dbQuery(
    `SELECT e.*, t.ticket_number, t.title AS ticket_title, dc.contact_name AS target_contact_name,
            dc.organization_name AS target_contact_org, hu.full_name AS handled_by_name
     FROM escalations e
     LEFT JOIN tickets t ON t.id = e.ticket_id
     LEFT JOIN directory_contacts dc ON dc.id = e.target_contact_id
     LEFT JOIN users hu ON hu.id = e.handled_by
     WHERE ${where}
     ORDER BY CASE e.status WHEN 'open' THEN 0 WHEN 'acknowledged' THEN 1 ELSE 2 END, e.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  )
  return { escalations: res.rows, count: Number(count.rows[0].c) }
}

export async function updateEscalationStatus(args: {
  orgId: string
  id: string
  userId: string
  status: 'acknowledged' | 'resolved' | 'dismissed'
  note?: string | null
}) {
  if (args.status !== 'acknowledged' && !args.note) {
    throw new HttpError(400, 'A note is required to resolve or dismiss an escalation')
  }
  const res = await dbQuery<{ ticket_id: string | null }>(
    `UPDATE escalations SET status = $3, handled_by = $4, handled_at = now(), resolution_note = COALESCE($5, resolution_note)
     WHERE id = $1 AND organization_id = $2 RETURNING ticket_id`,
    [args.id, args.orgId, args.status, args.userId, args.note ?? null],
  )
  const row = res.rows[0]
  if (!row) throw new HttpError(404, 'Escalation not found')
  if (row.ticket_id) {
    await recordCaseEvent({
      orgId: args.orgId,
      ticketId: row.ticket_id,
      type: `escalation_${args.status}`,
      actorType: 'user',
      actorUserId: args.userId,
      reason: args.note ?? null,
      data: { escalation_id: args.id },
    })
  }
}
