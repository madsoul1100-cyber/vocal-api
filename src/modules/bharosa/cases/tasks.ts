import { dbQuery } from '@/lib/db.js'
import { HttpError, isGro, type StaffUser } from '../common.js'
import { recordCaseEvent } from './events.js'

export const TASK_STATUSES = [
  'unassigned', 'assigned', 'picked_up', 'in_progress', 'on_hold', 'waiting_for_reply', 'cancelled', 'closed',
] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

export const TASK_TYPES = [
  'general', 'verification', 'field_visit', 'contact_authority', 'follow_up', 'document', 'citizen_contact', 'escalation',
] as const
export type TaskType = (typeof TASK_TYPES)[number]

const TERMINAL: TaskStatus[] = ['cancelled', 'closed']

/** Allowed transitions. GRO can additionally reopen terminal tasks. */
const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  unassigned: ['assigned', 'cancelled'],
  assigned: ['picked_up', 'unassigned', 'on_hold', 'cancelled'],
  picked_up: ['in_progress', 'on_hold', 'waiting_for_reply', 'cancelled', 'closed'],
  in_progress: ['on_hold', 'waiting_for_reply', 'cancelled', 'closed'],
  on_hold: ['in_progress', 'picked_up', 'cancelled'],
  waiting_for_reply: ['in_progress', 'on_hold', 'cancelled', 'closed'],
  cancelled: [],
  closed: [],
}

export interface TaskRow {
  id: string
  organization_id: string
  title: string
  description: string | null
  task_type: TaskType
  status: TaskStatus
  owner_user_id: string | null
  owner_name?: string | null
  suggested_role: string | null
  due_at: string | null
  effective_due_at?: string | null
  sla_paused_at: string | null
  sla_paused_seconds: number
  hold_reason: string | null
  depends_on_task_id: string | null
  plan_id: string | null
  authority_contact_id: string | null
  evidence_required_json: unknown
  sort_order: number
  created_by: string | null
  created_by_agent: string | null
  cancel_reason: string | null
  closed_at: string | null
  closure_note: string | null
  created_at: string
  updated_at: string
  ticket_ids?: string[]
  ticket_numbers?: string[]
}

const TASK_SELECT = `t.*, u.full_name AS owner_name,
  CASE WHEN t.due_at IS NULL THEN NULL
       ELSE t.due_at + make_interval(secs => t.sla_paused_seconds
            + CASE WHEN t.sla_paused_at IS NOT NULL THEN EXTRACT(EPOCH FROM now() - t.sla_paused_at) ELSE 0 END)
  END AS effective_due_at,
  COALESCE((SELECT array_agg(tt.ticket_id) FROM task_tickets tt WHERE tt.task_id = t.id), '{}') AS ticket_ids,
  COALESCE((SELECT array_agg(tk.ticket_number) FROM task_tickets tt JOIN tickets tk ON tk.id = tt.ticket_id WHERE tt.task_id = t.id), '{}') AS ticket_numbers`

async function ticketIdsFor(taskId: string): Promise<string[]> {
  const res = await dbQuery<{ ticket_id: string }>(`SELECT ticket_id FROM task_tickets WHERE task_id = $1`, [taskId])
  return res.rows.map((r) => r.ticket_id)
}

async function eventForAllCases(orgId: string, taskId: string, e: { type: string; actorType: 'user' | 'system' | 'ai_agent'; actorUserId?: string | null; reason?: string | null; data?: Record<string, unknown>; visibility?: 'internal' | 'citizen'; summary?: string | null }) {
  for (const ticketId of await ticketIdsFor(taskId)) {
    await recordCaseEvent({ orgId, ticketId, taskId, ...e })
  }
}

export async function getTask(orgId: string, id: string): Promise<TaskRow> {
  const res = await dbQuery<TaskRow>(`SELECT ${TASK_SELECT} FROM tasks t LEFT JOIN users u ON u.id = t.owner_user_id WHERE t.id = $1 AND t.organization_id = $2`, [id, orgId])
  if (!res.rows[0]) throw new HttpError(404, 'Task not found')
  return res.rows[0]
}

export async function assertTicketInOrg(orgId: string, ticketId: string): Promise<void> {
  const res = await dbQuery(`SELECT 1 FROM tickets WHERE id = $1 AND organization_id = $2`, [ticketId, orgId])
  if (!res.rowCount) throw new HttpError(404, 'Case not found')
}

async function assertOwnerInOrg(orgId: string, userId: string): Promise<void> {
  const res = await dbQuery(`SELECT 1 FROM users WHERE id = $1 AND organization_id = $2 AND active = true`, [userId, orgId])
  if (!res.rowCount) throw new HttpError(400, 'Owner must be an active staff member of this organization')
}

export async function createTask(args: {
  orgId: string
  ticketIds: string[]
  title: string
  description?: string | null
  taskType?: TaskType
  ownerUserId?: string | null
  suggestedRole?: string | null
  dueAt?: string | null
  dependsOnTaskId?: string | null
  planId?: string | null
  authorityContactId?: string | null
  evidenceRequired?: unknown
  sortOrder?: number
  createdBy?: string | null
  createdByAgent?: string | null
}): Promise<TaskRow> {
  if (!args.ticketIds.length) throw new HttpError(400, 'A task must be linked to at least one case')
  for (const t of args.ticketIds) await assertTicketInOrg(args.orgId, t)
  if (args.ownerUserId) await assertOwnerInOrg(args.orgId, args.ownerUserId)

  const res = await dbQuery<{ id: string }>(
    `INSERT INTO tasks (organization_id, title, description, task_type, status, owner_user_id, suggested_role, due_at,
                        depends_on_task_id, plan_id, authority_contact_id, evidence_required_json, sort_order, created_by, created_by_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
    [
      args.orgId, args.title.slice(0, 300), args.description ?? null, args.taskType ?? 'general',
      args.ownerUserId ? 'assigned' : 'unassigned', args.ownerUserId ?? null, args.suggestedRole ?? null, args.dueAt ?? null,
      args.dependsOnTaskId ?? null, args.planId ?? null, args.authorityContactId ?? null,
      args.evidenceRequired ? JSON.stringify(args.evidenceRequired) : null, args.sortOrder ?? 0,
      args.createdBy ?? null, args.createdByAgent ?? null,
    ],
  )
  const id = res.rows[0].id
  for (const t of args.ticketIds) {
    await dbQuery(`INSERT INTO task_tickets (task_id, ticket_id, linked_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [id, t, args.createdBy ?? null])
  }
  await dbQuery(`INSERT INTO task_status_history (task_id, from_status, to_status, changed_by, actor_type, reason) VALUES ($1, NULL, $2, $3, $4, 'created')`, [
    id, args.ownerUserId ? 'assigned' : 'unassigned', args.createdBy ?? null, args.createdByAgent ? 'ai_agent' : 'user',
  ])
  await eventForAllCases(args.orgId, id, {
    type: 'task_created',
    actorType: args.createdByAgent ? 'ai_agent' : 'user',
    actorUserId: args.createdBy,
    data: { title: args.title, owner_user_id: args.ownerUserId ?? null, task_type: args.taskType ?? 'general' },
  })
  return getTask(args.orgId, id)
}

export async function listTasks(args: {
  orgId: string
  user: StaffUser
  status?: string | null
  ownerId?: string | null
  ticketId?: string | null
  mine?: boolean
  overdue?: boolean
  limit: number
  offset: number
}) {
  const params: unknown[] = [args.orgId]
  let where = 't.organization_id = $1'
  const add = (sql: string, v: unknown) => {
    params.push(v)
    where += ` AND ${sql.replace('?', `$${params.length}`)}`
  }
  if (!isGro(args.user) || args.mine) add('t.owner_user_id = ?', args.user.id)
  else if (args.ownerId) add('t.owner_user_id = ?', args.ownerId)
  if (args.status) add('t.status = ANY(?::text[])', args.status.split(','))
  if (args.ticketId) add('EXISTS (SELECT 1 FROM task_tickets x WHERE x.task_id = t.id AND x.ticket_id = ?)', args.ticketId)
  if (args.overdue) where += ` AND t.due_at IS NOT NULL AND t.sla_paused_at IS NULL AND t.status NOT IN ('closed','cancelled','on_hold')
    AND t.due_at + make_interval(secs => t.sla_paused_seconds) < now()`

  const count = await dbQuery<{ c: string }>(`SELECT COUNT(*)::text AS c FROM tasks t WHERE ${where}`, params)
  params.push(args.limit, args.offset)
  const res = await dbQuery<TaskRow>(
    `SELECT ${TASK_SELECT} FROM tasks t LEFT JOIN users u ON u.id = t.owner_user_id WHERE ${where}
     ORDER BY CASE WHEN t.status IN ('closed','cancelled') THEN 1 ELSE 0 END, t.due_at NULLS LAST, t.sort_order, t.created_at
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  )
  return { tasks: res.rows, count: Number(count.rows[0].c) }
}

export async function summaryCounts(orgId: string, user: StaffUser) {
  const params: unknown[] = [orgId]
  let scope = ''
  if (!isGro(user)) {
    params.push(user.id)
    scope = 'AND owner_user_id = $2'
  }
  const res = await dbQuery<{ status: string; c: string }>(
    `SELECT status, COUNT(*)::text AS c FROM tasks WHERE organization_id = $1 ${scope} GROUP BY status`,
    params,
  )
  return Object.fromEntries(res.rows.map((r) => [r.status, Number(r.c)]))
}

function canEditTask(user: StaffUser, task: TaskRow): boolean {
  return isGro(user) || task.owner_user_id === user.id
}

export async function changeTaskStatus(args: {
  orgId: string
  user: StaffUser
  taskId: string
  status: TaskStatus
  reason?: string | null
}): Promise<TaskRow> {
  const task = await getTask(args.orgId, args.taskId)
  if (!canEditTask(args.user, task)) throw new HttpError(403, 'Only the task owner or a GRO can update this task')
  if (task.status === args.status) return task

  const allowed = TRANSITIONS[task.status]
  const reopen = TERMINAL.includes(task.status) && isGro(args.user) && args.status === 'in_progress'
  if (!allowed.includes(args.status) && !reopen) {
    throw new HttpError(409, `Cannot move a task from ${task.status} to ${args.status}`, 'INVALID_TRANSITION', { allowed })
  }
  if ((args.status === 'cancelled' || args.status === 'on_hold' || reopen) && !args.reason) {
    throw new HttpError(400, 'A reason is required')
  }
  if (args.status === 'assigned' && !task.owner_user_id) throw new HttpError(400, 'Assign an owner first')
  if (args.status === 'closed' && task.depends_on_task_id) {
    const dep = await dbQuery<{ status: string }>(`SELECT status FROM tasks WHERE id = $1`, [task.depends_on_task_id])
    if (dep.rows[0] && !TERMINAL.includes(dep.rows[0].status as TaskStatus)) {
      throw new HttpError(409, 'The task this depends on is still open')
    }
  }

  const pausing = args.status === 'on_hold'
  const resuming = task.status === 'on_hold'
  await dbQuery(
    `UPDATE tasks SET status = $3,
        sla_paused_at = CASE WHEN $4 THEN now() WHEN $5 THEN NULL ELSE sla_paused_at END,
        sla_paused_seconds = sla_paused_seconds + CASE WHEN $5 AND sla_paused_at IS NOT NULL THEN EXTRACT(EPOCH FROM now() - sla_paused_at)::bigint ELSE 0 END,
        hold_reason = CASE WHEN $4 THEN $6 WHEN $5 THEN NULL ELSE hold_reason END,
        cancel_reason = CASE WHEN $3 = 'cancelled' THEN $6 ELSE cancel_reason END,
        closure_note = CASE WHEN $3 = 'closed' THEN $6 ELSE closure_note END,
        closed_at = CASE WHEN $3 IN ('closed','cancelled') THEN now() WHEN $7 THEN NULL ELSE closed_at END,
        updated_at = now()
     WHERE id = $1 AND organization_id = $2`,
    [task.id, args.orgId, args.status, pausing, resuming, args.reason ?? null, reopen],
  )
  await dbQuery(`INSERT INTO task_status_history (task_id, from_status, to_status, changed_by, reason) VALUES ($1,$2,$3,$4,$5)`, [
    task.id, task.status, args.status, args.user.id, args.reason ?? null,
  ])
  await eventForAllCases(args.orgId, task.id, {
    type: 'task_status_changed',
    actorType: 'user',
    actorUserId: args.user.id,
    reason: args.reason ?? null,
    data: { title: task.title, from: task.status, to: args.status },
  })
  return getTask(args.orgId, task.id)
}

export async function updateTask(args: {
  orgId: string
  user: StaffUser
  taskId: string
  patch: { title?: string | null; description?: string | null; ownerUserId?: string | null; dueAt?: string | null; taskType?: TaskType | null; dependsOnTaskId?: string | null }
}): Promise<TaskRow> {
  const task = await getTask(args.orgId, args.taskId)
  if (!canEditTask(args.user, task)) throw new HttpError(403, 'Only the task owner or a GRO can update this task')
  const ownerChange = args.patch.ownerUserId !== undefined && args.patch.ownerUserId !== task.owner_user_id
  if (ownerChange && !isGro(args.user)) throw new HttpError(403, 'Only a GRO can reassign tasks')
  if (ownerChange && args.patch.ownerUserId) await assertOwnerInOrg(args.orgId, args.patch.ownerUserId)

  const newStatus = ownerChange
    ? args.patch.ownerUserId
      ? task.status === 'unassigned' ? 'assigned' : task.status
      : 'unassigned'
    : task.status

  await dbQuery(
    `UPDATE tasks SET title = COALESCE($3, title), description = COALESCE($4, description),
        owner_user_id = CASE WHEN $5 THEN $6::uuid ELSE owner_user_id END,
        due_at = CASE WHEN $7 THEN $8::timestamptz ELSE due_at END,
        task_type = COALESCE($9, task_type),
        depends_on_task_id = CASE WHEN $10 THEN $11::uuid ELSE depends_on_task_id END,
        status = $12, updated_at = now()
     WHERE id = $1 AND organization_id = $2`,
    [
      task.id, args.orgId, args.patch.title ?? null, args.patch.description ?? null,
      ownerChange, args.patch.ownerUserId ?? null,
      args.patch.dueAt !== undefined, args.patch.dueAt ?? null,
      args.patch.taskType ?? null,
      args.patch.dependsOnTaskId !== undefined, args.patch.dependsOnTaskId ?? null,
      newStatus,
    ],
  )
  if (ownerChange) {
    await dbQuery(`INSERT INTO task_status_history (task_id, from_status, to_status, changed_by, reason) VALUES ($1,$2,$3,$4,'owner changed')`, [
      task.id, task.status, newStatus, args.user.id,
    ])
    await eventForAllCases(args.orgId, task.id, {
      type: 'task_reassigned',
      actorType: 'user',
      actorUserId: args.user.id,
      data: { title: task.title, from_owner: task.owner_user_id, to_owner: args.patch.ownerUserId ?? null },
    })
  }
  return getTask(args.orgId, task.id)
}

export async function linkTaskToTickets(args: { orgId: string; user: StaffUser; taskId: string; ticketIds: string[]; unlink?: boolean }) {
  const task = await getTask(args.orgId, args.taskId)
  if (!isGro(args.user)) throw new HttpError(403, 'Only a GRO can link cases to a task')
  for (const ticketId of args.ticketIds) {
    await assertTicketInOrg(args.orgId, ticketId)
    if (args.unlink) {
      const remaining = await ticketIdsFor(task.id)
      if (remaining.length <= 1) throw new HttpError(409, 'A task must stay linked to at least one case')
      await dbQuery(`DELETE FROM task_tickets WHERE task_id = $1 AND ticket_id = $2`, [task.id, ticketId])
    } else {
      await dbQuery(`INSERT INTO task_tickets (task_id, ticket_id, linked_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [task.id, ticketId, args.user.id])
    }
    await recordCaseEvent({
      orgId: args.orgId, ticketId, taskId: task.id, type: args.unlink ? 'task_unlinked' : 'task_linked',
      actorType: 'user', actorUserId: args.user.id, data: { title: task.title },
    })
  }
  return getTask(args.orgId, task.id)
}

export async function taskHistory(orgId: string, taskId: string) {
  await getTask(orgId, taskId)
  const res = await dbQuery(
    `SELECT h.*, u.full_name AS changed_by_name FROM task_status_history h LEFT JOIN users u ON u.id = h.changed_by
     WHERE h.task_id = $1 ORDER BY h.created_at`,
    [taskId],
  )
  return res.rows
}
