import { dbQuery } from '@/lib/db.js'
import {
  SQL_TICKET_DETAIL,
  SQL_TICKET_LIST,
  SQL_TICKET_STAGE_HISTORY,
  SQL_WORKERS_WITH_TERRITORIES,
  sqlForUserWithRelations,
} from '@/lib/postgresCompat/embedSql.js'
import { LocalStorageApi } from '@/lib/postgresCompat/storage.js'

type Filter =
  | { kind: 'eq'; col: string; val: unknown }
  | { kind: 'neq'; col: string; val: unknown }
  | { kind: 'not_is'; col: string; val: unknown }
  | { kind: 'in'; col: string; vals: unknown[] }
  | { kind: 'lt'; col: string; val: unknown }
  | { kind: 'or'; expr: string }

type DbResult<T> = { data: T | null; error: { message: string; code?: string } | null; count?: number | null }

function snakeCols(cols: string): string {
  return cols
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean)
    .join(', ')
}

function buildWhere(filters: Filter[], startIdx = 1): { sql: string; params: unknown[] } {
  const params: unknown[] = []
  const parts: string[] = []
  let i = startIdx

  for (const f of filters) {
    if (f.kind === 'eq') {
      parts.push(`${f.col} = $${i++}`)
      params.push(f.val)
    } else if (f.kind === 'neq') {
      parts.push(`${f.col} <> $${i++}`)
      params.push(f.val)
    } else if (f.kind === 'not_is') {
      if (f.val === null) parts.push(`${f.col} IS NOT NULL`)
      else {
        parts.push(`${f.col} IS DISTINCT FROM $${i++}`)
        params.push(f.val)
      }
    } else if (f.kind === 'in') {
      parts.push(`${f.col} = ANY($${i++})`)
      params.push(f.vals)
    } else if (f.kind === 'lt') {
      parts.push(`${f.col} < $${i++}`)
      params.push(f.val)
    } else if (f.kind === 'or') {
      // PostgREST ilike or: title.ilike.%x%,ticket_number.ilike.%x%
      const clauses = f.expr.split(',').map((part) => {
        const m = part.trim().match(/^(\w+)\.ilike\.%(.+)%$/)
        if (!m) return null
        const clause = `${m[1]} ILIKE $${i++}`
        params.push(`%${m[2]}%`)
        return clause
      })
      const valid = clauses.filter(Boolean) as string[]
      if (valid.length) parts.push(`(${valid.join(' OR ')})`)
    }
  }

  return { sql: parts.length ? parts.join(' AND ') : 'TRUE', params }
}

function matchEmbedSelect(table: string, select: string): string | null {
  const s = select.replace(/\s+/g, ' ')
  if (table === 'users' && s.includes('roles(') && s.includes('organizations(')) {
    return 'USER_RELATIONS'
  }
  if (table === 'tickets' && s.includes('category:issue_categories')) {
    return 'TICKET_DETAIL'
  }
  if (table === 'tickets' && s.includes('territories(id, name)') && s.includes('ticket_number')) {
    return 'TICKET_LIST'
  }
  if (table === 'users' && s.includes('user_territories(')) {
    return 'WORKERS_TERRITORIES'
  }
  if (table === 'users' && s.includes('roles!inner')) {
    return 'USER_ROLES_INNER'
  }
  if (table === 'audit_logs' && s.includes('users:actor_user_id')) {
    return 'AUDIT_LOG_ACTOR'
  }
  if (table === 'ticket_assignments' && s.includes('tickets!inner')) {
    return 'TICKET_ASSIGNMENTS_TICKET_INNER'
  }
  if (
    table === 'ticket_stage_history' &&
    (s.includes('changed_by_user:users') || s.includes('users!ticket_stage_history_changed_by'))
  ) {
    return 'TICKET_STAGE_HISTORY'
  }
  return null
}

function remapTicketAssignmentFilters(filters: Filter[]): Filter[] {
  return filters.map((f) => {
    if ('col' in f && f.col === 'tickets.organization_id') {
      return { ...f, col: 't.organization_id' }
    }
    if ('col' in f && !f.col.includes('.')) {
      return { ...f, col: `ta.${f.col}` }
    }
    return f
  })
}

function remapJoinFilters(filters: Filter[]): Filter[] {
  return filters.map((f) => {
    if ('col' in f && f.col === 'roles.name') {
      return { ...f, col: 'r.name' }
    }
    return f
  })
}

export class PostgresTableQuery<T = Record<string, unknown>> {
  private filters: Filter[] = []
  private orderCol?: string
  private orderAsc = true
  private limitN?: number
  private offsetN?: number
  private wantSingle: 'none' | 'single' | 'maybe' = 'none'
  private countExact = false
  private insertRow?: Record<string, unknown> | Record<string, unknown>[]
  private updateRow?: Record<string, unknown>
  private upsertRow?: Record<string, unknown>
  private upsertConflict?: string

  constructor(
    private table: string,
    private mode: 'select' | 'insert' | 'update' | 'upsert',
    private selectCols = '*',
  ) {}

  select(cols: string, opts?: { count?: 'exact' }) {
    this.selectCols = cols
    if (opts?.count === 'exact') this.countExact = true
    return this
  }

  insert(row: Record<string, unknown> | Record<string, unknown>[]) {
    this.insertRow = row
    return this
  }

  update(row: Record<string, unknown>) {
    this.updateRow = row
    return this
  }

  upsert(row: Record<string, unknown>, opts?: { onConflict?: string }) {
    this.upsertRow = row
    this.upsertConflict = opts?.onConflict
    return this
  }

  eq(col: string, val: unknown) {
    this.filters.push({ kind: 'eq', col, val })
    return this
  }

  neq(col: string, val: unknown) {
    this.filters.push({ kind: 'neq', col, val })
    return this
  }

  not(col: string, op: string, val: unknown) {
    if (op === 'is') this.filters.push({ kind: 'not_is', col, val })
    return this
  }

  in(col: string, vals: unknown[]) {
    this.filters.push({ kind: 'in', col, vals })
    return this
  }

  lt(col: string, val: unknown) {
    this.filters.push({ kind: 'lt', col, val })
    return this
  }

  or(expr: string) {
    this.filters.push({ kind: 'or', expr })
    return this
  }

  order(col: string, opts?: { ascending?: boolean }) {
    this.orderCol = col
    this.orderAsc = opts?.ascending !== false
    return this
  }

  range(from: number, to: number) {
    this.offsetN = from
    this.limitN = to - from + 1
    return this
  }

  limit(n: number) {
    this.limitN = n
    return this
  }

  single() {
    this.wantSingle = 'single'
    return this
  }

  maybeSingle() {
    this.wantSingle = 'maybe'
    return this
  }

  private prefixWhere(alias?: string): Filter[] {
    if (!alias) return this.filters
    return this.filters.map((f) => {
      if (f.kind === 'or') return f
      return {
        ...f,
        col: f.col.includes('.') ? f.col : `${alias}.${f.col}`,
      }
    })
  }

  async then<TResult1 = DbResult<T>, TResult2 = never>(
    onfulfilled?: ((value: DbResult<T>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    try {
      const result = await this.execute()
      return onfulfilled ? onfulfilled(result) : (result as TResult1)
    } catch (reason) {
      if (onrejected) return onrejected(reason)
      throw reason
    }
  }

  async execute(): Promise<DbResult<T>> {
    try {
      if (this.insertRow) return await this.runInsert()
      if (this.updateRow) return await this.runUpdate()
      if (this.upsertRow) return await this.runUpsert()
      return await this.runSelect()
    } catch (err) {
      return { data: null, error: { message: err instanceof Error ? err.message : String(err) } }
    }
  }

  private async runInsert(): Promise<DbResult<T>> {
    const row = this.insertRow!
    const rows = Array.isArray(row) ? row : [row]
    if (rows.length === 0) return { data: null, error: { message: 'Empty insert' } }

    const cols = Object.keys(rows[0]!)
    const valuesClause: string[] = []
    const params: unknown[] = []
    let p = 1
    for (const r of rows) {
      valuesClause.push(`(${cols.map(() => `$${p++}`).join(', ')})`)
      params.push(...cols.map((c) => r[c]))
    }
    const returning = this.selectCols !== '*' ? ` RETURNING ${snakeCols(this.selectCols)}` : ' RETURNING *'
    const sql = `INSERT INTO ${this.table} (${cols.join(', ')}) VALUES ${valuesClause.join(', ')}${returning}`
    const res = await dbQuery(sql, params)
    const data = (this.wantSingle === 'single' || this.wantSingle === 'maybe'
      ? res.rows[0]
      : res.rows) as T
    if (this.wantSingle === 'single' && !res.rows[0]) {
      return { data: null, error: { message: 'No rows', code: 'PGRST116' } }
    }
    return { data: data ?? null, error: null }
  }

  private async runUpdate(): Promise<DbResult<T>> {
    const row = this.updateRow!
    const cols = Object.keys(row)
    const vals = Object.values(row)
    const set = cols.map((c, i) => `${c} = $${i + 1}`).join(', ')
    const { sql: where, params: wParams } = buildWhere(this.filters, vals.length + 1)
    const sql = `UPDATE ${this.table} SET ${set} WHERE ${where}`
    await dbQuery(sql, [...vals, ...wParams])
    return { data: null, error: null }
  }

  private async runUpsert(): Promise<DbResult<T>> {
    const row = this.upsertRow!
    const conflict = this.upsertConflict ?? 'id'
    const cols = Object.keys(row)
    const vals = Object.values(row)
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ')
    const updates = cols.filter((c) => c !== conflict).map((c) => `${c} = EXCLUDED.${c}`).join(', ')
    const sql = `
      INSERT INTO ${this.table} (${cols.join(', ')})
      VALUES (${placeholders})
      ON CONFLICT (${conflict}) DO UPDATE SET ${updates}
    `
    await dbQuery(sql, vals)
    return { data: null, error: null }
  }

  private async runSelect(): Promise<DbResult<T>> {
    const embed = matchEmbedSelect(this.table, this.selectCols)
    let baseSql: string
    let alias: string | undefined

    if (embed === 'USER_RELATIONS') {
      const { sql: where, params } = buildWhere(this.prefixWhere('u'))
      baseSql = sqlForUserWithRelations(where)
      const res = await dbQuery(baseSql, params)
      return this.finishSelect(res.rows as T[], res.rowCount)
    }

    if (embed === 'TICKET_LIST') {
      alias = 't'
      const { sql: where, params } = buildWhere(this.prefixWhere('t'))
      baseSql = `${SQL_TICKET_LIST} WHERE ${where}`
      if (this.orderCol) {
        baseSql += ` ORDER BY t.${this.orderCol} ${this.orderAsc ? 'ASC' : 'DESC'}`
      }
      if (this.limitN != null) {
        const lim = params.length + 1
        const off = params.length + 2
        baseSql += ` LIMIT $${lim} OFFSET $${off}`
        params.push(this.limitN, this.offsetN ?? 0)
      }
      if (this.countExact) {
        const countRes = await dbQuery<{ c: string }>(
          `SELECT COUNT(*)::text AS c FROM tickets t WHERE ${where}`,
          params.slice(0, params.length - (this.limitN != null ? 2 : 0)),
        )
        const res = await dbQuery(baseSql, params)
        return this.finishSelect(res.rows as T[], Number(countRes.rows[0]?.c ?? 0))
      }
      const res = await dbQuery(baseSql, params)
      return this.finishSelect(res.rows as T[], res.rowCount)
    }

    if (embed === 'TICKET_DETAIL') {
      const { sql: where, params } = buildWhere(this.prefixWhere('t'))
      baseSql = `${SQL_TICKET_DETAIL} WHERE ${where}`
      const res = await dbQuery(baseSql, params)
      return this.finishSelect(res.rows as T[], res.rowCount)
    }

    if (embed === 'WORKERS_TERRITORIES') {
      const { sql: where, params } = buildWhere(this.prefixWhere('u'))
      baseSql = `${SQL_WORKERS_WITH_TERRITORIES} WHERE ${where} GROUP BY u.id, u.full_name`
      const res = await dbQuery(baseSql, params)
      return this.finishSelect(res.rows as T[], res.rowCount)
    }

    if (embed === 'USER_ROLES_INNER') {
      const filters = remapJoinFilters(this.prefixWhere('u'))
      const { sql: where, params } = buildWhere(filters)
      baseSql = `
        SELECT u.id, u.full_name, u.metadata_json, jsonb_build_object('name', r.name) AS roles
        FROM users u
        INNER JOIN roles r ON r.id = u.role_id
        WHERE ${where}
      `
      const res = await dbQuery(baseSql, params)
      return this.finishSelect(res.rows as T[], res.rowCount)
    }

    if (embed === 'AUDIT_LOG_ACTOR') {
      const { sql: where, params } = buildWhere(this.prefixWhere('a'))
      baseSql = `
        SELECT a.id, a.created_at, a.new_value_json,
          CASE WHEN u.id IS NOT NULL THEN jsonb_build_object('full_name', u.full_name) END AS users
        FROM audit_logs a
        LEFT JOIN users u ON u.id = a.actor_user_id
        WHERE ${where}
      `
      if (this.orderCol) {
        baseSql += ` ORDER BY a.${this.orderCol} ${this.orderAsc ? 'ASC' : 'DESC'}`
      }
      if (this.limitN != null) {
        const lim = params.length + 1
        const off = params.length + 2
        baseSql += ` LIMIT $${lim} OFFSET $${off}`
        params.push(this.limitN, this.offsetN ?? 0)
      }
      const res = await dbQuery(baseSql, params)
      return this.finishSelect(res.rows as T[], res.rowCount)
    }

    if (embed === 'TICKET_STAGE_HISTORY') {
      const { sql: where, params } = buildWhere(this.prefixWhere('h'))
      baseSql = `${SQL_TICKET_STAGE_HISTORY} WHERE ${where}`
      if (this.orderCol) {
        baseSql += ` ORDER BY h.${this.orderCol} ${this.orderAsc ? 'ASC' : 'DESC'}`
      }
      if (this.limitN != null) {
        const lim = params.length + 1
        const off = params.length + 2
        baseSql += ` LIMIT $${lim} OFFSET $${off}`
        params.push(this.limitN, this.offsetN ?? 0)
      }
      const res = await dbQuery(baseSql, params)
      return this.finishSelect(res.rows as T[], res.rowCount)
    }

    if (embed === 'TICKET_ASSIGNMENTS_TICKET_INNER') {
      const filters = remapTicketAssignmentFilters(this.filters)
      const { sql: where, params } = buildWhere(filters)
      if (this.countExact) {
        const countRes = await dbQuery<{ c: string }>(
          `SELECT COUNT(*)::text AS c
           FROM ticket_assignments ta
           INNER JOIN tickets t ON t.id = ta.ticket_id
           WHERE ${where}`,
          params,
        )
        return this.finishSelect([] as T[], Number(countRes.rows[0]?.c ?? 0))
      }
      baseSql = `
        SELECT ta.id, jsonb_build_object('organization_id', t.organization_id) AS tickets
        FROM ticket_assignments ta
        INNER JOIN tickets t ON t.id = ta.ticket_id
        WHERE ${where}
      `
      const res = await dbQuery(baseSql, params)
      return this.finishSelect(res.rows as T[], res.rowCount)
    }

    if (/[:!]/.test(this.selectCols)) {
      return {
        data: null,
        error: {
          message: `PostgREST embed select is not supported in postgres mode: ${this.selectCols.replace(/\s+/g, ' ').slice(0, 120)}`,
        },
      }
    }

    const cols = this.selectCols === '*' ? '*' : snakeCols(this.selectCols)
    const { sql: where, params } = buildWhere(this.filters)
    baseSql = `SELECT ${cols} FROM ${this.table} WHERE ${where}`
    if (this.orderCol) {
      baseSql += ` ORDER BY ${this.orderCol} ${this.orderAsc ? 'ASC' : 'DESC'}`
    }
    if (this.limitN != null) {
      const lim = params.length + 1
      baseSql += ` LIMIT $${lim}`
      params.push(this.limitN)
      if (this.offsetN != null) {
        baseSql += ` OFFSET $${params.length + 1}`
        params.push(this.offsetN)
      }
    }

    if (this.countExact) {
      const countRes = await dbQuery<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM ${this.table} WHERE ${where}`,
        [...params].slice(0, params.length - (this.limitN != null ? (this.offsetN != null ? 2 : 1) : 0)),
      )
      const res = await dbQuery(baseSql, params)
      return this.finishSelect(res.rows as T[], Number(countRes.rows[0]?.c ?? 0))
    }

    const res = await dbQuery(baseSql, params)
    return this.finishSelect(res.rows as T[], res.rowCount)
  }

  private finishSelect(rows: T[], count: number | null): DbResult<T> {
    if (this.wantSingle === 'single') {
      if (!rows[0]) return { data: null, error: { message: 'No rows', code: 'PGRST116' }, count }
      return { data: rows[0], error: null, count }
    }
    if (this.wantSingle === 'maybe') {
      return { data: rows[0] ?? null, error: null, count }
    }
    return { data: rows as unknown as T, error: null, count }
  }
}

export class PostgresClient {
  private readonly storageApi = new LocalStorageApi()

  storage = {
    from: (bucket: string) => this.storageApi.from(bucket),
  }

  from(table: string): PostgresTableQuery<Record<string, unknown>> {
    return new PostgresTableQuery(table, 'select')
  }

  async rpc(fn: string, args: Record<string, unknown>): Promise<DbResult<unknown>> {
    try {
      if (fn === 'generate_ticket_number') {
        const orgSlug = args.org_slug as string
        const orgId = (args.org_id as string | undefined) ?? null
        const res = await dbQuery<{ generate_ticket_number: string }>(
          `SELECT generate_ticket_number($1::uuid, $2::text) AS generate_ticket_number`,
          [orgId, orgSlug],
        )
        return { data: res.rows[0]?.generate_ticket_number ?? null, error: null }
      }
      return { data: null, error: { message: `Unknown RPC: ${fn}` } }
    } catch (err) {
      return { data: null, error: { message: err instanceof Error ? err.message : String(err) } }
    }
  }
}

export function createPostgresServiceClient(): PostgresClient {
  return new PostgresClient()
}
