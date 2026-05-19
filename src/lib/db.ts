import pg from 'pg'

const { Pool } = pg

let pool: pg.Pool | null = null

export function getDatabaseUrl(): string | undefined {
  return process.env.DATABASE_URL?.trim()
}

export function isPostgresMode(): boolean {
  return Boolean(getDatabaseUrl())
}

export function getPool(): pg.Pool {
  const url = getDatabaseUrl()
  if (!url) {
    throw new Error('DATABASE_URL is not set')
  }
  if (!pool) {
    pool = new Pool({
      connectionString: url,
      ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
      max: Number(process.env.DATABASE_POOL_MAX ?? 10),
    })
  }
  return pool
}

export async function dbQuery<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  return getPool().query<T>(text, params)
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end()
    pool = null
  }
}
