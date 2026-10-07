import { dbQuery } from '@/lib/db.js'
import { getBharosaSettings } from '../settings.js'
import { createEscalation } from './escalations.js'
import { createDraftCommunication, resolveRecipients, type CommunicationRow } from '../comms/communications.js'
import { findEscalationContact } from '../directory/routing.js'

async function threadText(threadKey: string | null): Promise<string | null> {
  if (!threadKey) return null
  const res = await dbQuery<{ direction: string; subject: string | null; body: string | null; sent_at: string | null }>(
    `SELECT direction, subject, body, sent_at FROM communications
     WHERE thread_key = $1 AND status NOT IN ('superseded','rejected','draft','pending_approval') ORDER BY created_at`,
    [threadKey],
  )
  return res.rows
    .map((r) => `[${r.direction === 'outbound' ? 'Sent' : 'Reply'} ${r.sent_at ?? ''}] ${r.subject ?? ''}\n${(r.body ?? '').slice(0, 1500)}`)
    .join('\n\n')
    .slice(0, 6000)
}

/**
 * Follow-up agent: for every authority email whose follow-up time has come
 * and no reply was received, draft the next follow-up (for approval), or
 * after the last follow-up escalate to the next authority level / the GRO.
 */
export async function sweepFollowUps(orgId: string): Promise<{ drafted: number; escalated: number }> {
  const settings = await getBharosaSettings(orgId)
  const due = await dbQuery<CommunicationRow>(
    `SELECT * FROM communications
     WHERE organization_id = $1 AND direction = 'outbound' AND channel = 'email'
       AND purpose IN ('authority_complaint','follow_up','escalation')
       AND status IN ('sent','delivered') AND follow_up_stopped_at IS NULL
       AND next_follow_up_at IS NOT NULL AND next_follow_up_at <= now()
     ORDER BY next_follow_up_at LIMIT 50`,
    [orgId],
  )
  let drafted = 0
  let escalated = 0
  for (const comm of due.rows) {
    if (!comm.ticket_id) continue
    await dbQuery(`UPDATE communications SET next_follow_up_at = NULL WHERE id = $1`, [comm.id])

    const closed = await dbQuery(`SELECT 1 FROM tickets WHERE id = $1 AND stage = 'closed'`, [comm.ticket_id])
    if (closed.rowCount) continue
    const prior = await threadText(comm.thread_key)
    const approvalBy = comm.approval_by === 'citizen' ? 'citizen' : 'staff'

    if (comm.follow_up_count < settings.followUp.intervalsHours.length) {
      try {
        await createDraftCommunication({
          orgId, ticketId: comm.ticket_id, taskId: comm.task_id, format: 'follow_up_email',
          recipients: comm.recipients_json, language: comm.language === 'te' ? 'te' : 'en',
          approvalBy, followUpOf: comm, priorThread: prior,
        })
        drafted++
      } catch (err) {
        await createEscalation({
          orgId, ticketId: comm.ticket_id, communicationId: comm.id, target: 'gro', trigger: 'no_reply',
          reason: `No reply from authority; follow-up could not be drafted: ${err instanceof Error ? err.message : String(err)}`,
          createdByAgent: 'follow_up_agent', dedupeKey: `followup_failed:${comm.id}`,
        })
      }
      continue
    }

    // Follow-ups exhausted → escalate up the chain.
    const primary = comm.recipients_json.find((r) => r.kind === 'to' && r.contact_id)
    const higher = primary?.contact_id ? await findEscalationContact(orgId, primary.contact_id) : null
    if (settings.followUp.escalateAfterLastFollowUp && higher?.email) {
      const recipients = await resolveRecipients(orgId, {
        contact_ids: [higher.id],
        cc_contact_ids: comm.recipients_json.filter((r) => r.contact_id).map((r) => r.contact_id),
      })
      const draft = await createDraftCommunication({
        orgId, ticketId: comm.ticket_id, taskId: comm.task_id, format: 'escalation_email', recipients,
        language: comm.language === 'te' ? 'te' : 'en', approvalBy: 'staff',
        escalationLevel: comm.escalation_level + 1, priorThread: prior,
      })
      await createEscalation({
        orgId, ticketId: comm.ticket_id, taskId: comm.task_id, communicationId: draft.id, target: 'authority',
        level: comm.escalation_level + 1, trigger: 'no_reply', targetContactId: higher.id,
        reason: `No reply after ${comm.follow_up_count} follow-ups. Escalation email to ${higher.contact_name} drafted for approval.`,
        createdByAgent: 'escalation_agent', dedupeKey: `authority_escalation:${comm.thread_key ?? comm.id}`,
      })
    } else {
      await createEscalation({
        orgId, ticketId: comm.ticket_id, taskId: comm.task_id, communicationId: comm.id, target: 'gro', trigger: 'no_reply',
        reason: `No reply after ${comm.follow_up_count} follow-ups and no higher authority with email in the directory. GRO decision needed.`,
        createdByAgent: 'escalation_agent', dedupeKey: `no_reply_gro:${comm.thread_key ?? comm.id}`,
      })
    }
    escalated++
  }
  return { drafted, escalated }
}

/**
 * Escalation agent: SLA, inactivity and stuck-work rules. Everything here
 * goes to the GRO queue; dedupe keys make the sweep idempotent.
 */
export async function sweepEscalations(orgId: string): Promise<Record<string, number>> {
  const settings = await getBharosaSettings(orgId)
  const counts: Record<string, number> = {}
  const bump = (k: string, id: string | null) => {
    if (id) counts[k] = (counts[k] ?? 0) + 1
  }

  const overdue = await dbQuery<{ id: string; title: string; ticket_id: string | null; owner_name: string | null }>(
    `SELECT t.id, t.title, u.full_name AS owner_name,
            (SELECT tt.ticket_id FROM task_tickets tt WHERE tt.task_id = t.id LIMIT 1) AS ticket_id
     FROM tasks t LEFT JOIN users u ON u.id = t.owner_user_id
     WHERE t.organization_id = $1 AND t.status IN ('unassigned','assigned','picked_up','in_progress') AND t.due_at IS NOT NULL
       AND t.due_at + make_interval(secs => t.sla_paused_seconds) < now()
     LIMIT 200`,
    [orgId],
  )
  for (const t of overdue.rows) {
    bump('task_overdue', await createEscalation({
      orgId, ticketId: t.ticket_id, taskId: t.id, target: 'gro', trigger: 'task_overdue',
      reason: `Task "${t.title}" is past its due time${t.owner_name ? ` (owner: ${t.owner_name})` : ' and has no owner'}.`,
      createdByAgent: 'escalation_agent', dedupeKey: `task_overdue:${t.id}`,
    }))
  }

  const inactive = await dbQuery<{ id: string; title: string; ticket_id: string | null; status: string }>(
    `SELECT t.id, t.title, t.status, (SELECT tt.ticket_id FROM task_tickets tt WHERE tt.task_id = t.id LIMIT 1) AS ticket_id
     FROM tasks t
     WHERE t.organization_id = $1 AND t.status IN ('assigned','picked_up','in_progress')
       AND t.updated_at < now() - make_interval(hours => $2::int)
     LIMIT 200`,
    [orgId, settings.escalation.taskInactivityHours],
  )
  for (const t of inactive.rows) {
    bump('task_inactive', await createEscalation({
      orgId, ticketId: t.ticket_id, taskId: t.id, target: 'gro', trigger: 'sla_breach',
      reason: `Task "${t.title}" has had no update for ${settings.escalation.taskInactivityHours}h (status: ${t.status}).`,
      createdByAgent: 'escalation_agent', dedupeKey: `task_inactive:${t.id}`,
    }))
  }

  const unassigned = await dbQuery<{ id: string; title: string; ticket_id: string | null }>(
    `SELECT t.id, t.title, (SELECT tt.ticket_id FROM task_tickets tt WHERE tt.task_id = t.id LIMIT 1) AS ticket_id
     FROM tasks t WHERE t.organization_id = $1 AND t.status = 'unassigned' AND t.created_at < now() - interval '24 hours' LIMIT 200`,
    [orgId],
  )
  for (const t of unassigned.rows) {
    bump('task_unassigned', await createEscalation({
      orgId, ticketId: t.ticket_id, taskId: t.id, target: 'gro', trigger: 'sla_breach',
      reason: `Task "${t.title}" has been unassigned for over 24h.`,
      createdByAgent: 'escalation_agent', dedupeKey: `task_unassigned:${t.id}`,
    }))
  }

  const unverified = await dbQuery<{ id: string; ticket_number: string }>(
    `SELECT id, ticket_number FROM tickets
     WHERE organization_id = $1 AND stage <> 'closed' AND verification_status IN ('unverified','in_verification')
       AND source_channel IN ('web','email','call') AND created_at < now() - make_interval(hours => $2::int)
     LIMIT 200`,
    [orgId, settings.escalation.unverifiedCaseHours],
  )
  for (const t of unverified.rows) {
    bump('case_unverified', await createEscalation({
      orgId, ticketId: t.id, target: 'gro', trigger: 'sla_breach',
      reason: `Case ${t.ticket_number} is still unverified after ${settings.escalation.unverifiedCaseHours}h.`,
      createdByAgent: 'escalation_agent', dedupeKey: `case_unverified:${t.id}`,
    }))
  }

  const stalePlans = await dbQuery<{ id: string; ticket_id: string }>(
    `SELECT id, ticket_id FROM resolution_plans WHERE organization_id = $1 AND status = 'pending_approval'
       AND created_at < now() - interval '24 hours' LIMIT 200`,
    [orgId],
  )
  for (const p of stalePlans.rows) {
    bump('plan_pending', await createEscalation({
      orgId, ticketId: p.ticket_id, target: 'gro', trigger: 'sla_breach',
      reason: 'Resolution plan has been waiting for GRO approval for over 24h.',
      createdByAgent: 'escalation_agent', dedupeKey: `plan_pending:${p.id}`,
    }))
  }

  const staleApprovals = await dbQuery<{ id: string; ticket_id: string | null; approval_by: string; purpose: string }>(
    `SELECT id, ticket_id, approval_by, purpose FROM communications WHERE organization_id = $1 AND status = 'pending_approval'
       AND created_at < now() - interval '48 hours' LIMIT 200`,
    [orgId],
  )
  for (const c of staleApprovals.rows) {
    bump('approval_pending', await createEscalation({
      orgId, ticketId: c.ticket_id, communicationId: c.id, target: 'gro', trigger: 'sla_breach',
      reason: `A ${c.purpose.replace(/_/g, ' ')} draft has waited 48h for ${c.approval_by === 'citizen' ? 'the citizen' : 'staff'} approval.`,
      createdByAgent: 'escalation_agent', dedupeKey: `approval_pending:${c.id}`,
    }))
  }

  const failedRouting = await dbQuery<{ id: string; ticket_number: string; routing_status: string }>(
    `SELECT id, ticket_number, routing_status FROM tickets WHERE organization_id = $1 AND stage <> 'closed'
       AND routing_status = 'uncertain' AND verification_status = 'verified' AND verified_at < now() - interval '24 hours' LIMIT 200`,
    [orgId],
  )
  for (const t of failedRouting.rows) {
    bump('routing_uncertain', await createEscalation({
      orgId, ticketId: t.id, target: 'gro', trigger: 'ai_uncertain',
      reason: `Case ${t.ticket_number}: responsible authority still unclear 24h after verification.`,
      createdByAgent: 'escalation_agent', dedupeKey: `routing_uncertain:${t.id}`,
    }))
  }

  return counts
}
