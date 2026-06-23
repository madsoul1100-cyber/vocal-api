/**
 * Backfill missing `worker_filed_ticket` audit rows for historical manual intake.
 *
 * Sources (oldest evidence first):
 *   1. audit_logs `ticket_created` with new_value_json.filed_by_worker = true
 *   2. ticket_stage_history initial row with worker field-intake change_reason
 *
 * Usage:
 *   npm run backfill:worker-filed-tickets
 *   DRY_RUN=1 npm run backfill:worker-filed-tickets   # preview only
 *   ORG_ID=<uuid> npm run backfill:worker-filed-tickets
 */
import dotenv from 'dotenv'
import pg from 'pg'

dotenv.config()
dotenv.config({ path: '.env.local', override: true })

const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true'
const ORG_ID = process.env.ORG_ID?.trim()

interface CandidateRow {
  ticket_id: string
  organization_id: string
  actor_user_id: string
  created_at: string
  ticket_number: string
  citizen_id: string | null
  source: 'ticket_created' | 'stage_history'
}

const CANDIDATES_SQL = `
  WITH missing AS (
    SELECT t.id AS ticket_id
    FROM tickets t
    WHERE t.source_channel = 'manual'
      AND NOT EXISTS (
        SELECT 1 FROM audit_logs wft
        WHERE wft.entity_type = 'ticket'
          AND wft.entity_id = t.id
          AND wft.event_type = 'worker_filed_ticket'
      )
      ${ORG_ID ? 'AND t.organization_id = $1::uuid' : ''}
  ),
  from_created AS (
    SELECT DISTINCT ON (al.entity_id)
      al.entity_id AS ticket_id,
      al.organization_id,
      al.actor_user_id,
      al.created_at,
      t.ticket_number,
      t.citizen_id,
      'ticket_created'::text AS source
    FROM audit_logs al
    INNER JOIN tickets t ON t.id = al.entity_id
    INNER JOIN missing m ON m.ticket_id = al.entity_id
    WHERE al.event_type = 'ticket_created'
      AND al.entity_type = 'ticket'
      AND al.actor_user_id IS NOT NULL
      AND COALESCE((al.new_value_json->>'filed_by_worker')::boolean, false) = true
    ORDER BY al.entity_id, al.created_at ASC
  ),
  from_history AS (
    SELECT DISTINCT ON (tsh.ticket_id)
      tsh.ticket_id,
      t.organization_id,
      tsh.changed_by AS actor_user_id,
      tsh.created_at,
      t.ticket_number,
      t.citizen_id,
      'stage_history'::text AS source
    FROM ticket_stage_history tsh
    INNER JOIN tickets t ON t.id = tsh.ticket_id
    INNER JOIN missing m ON m.ticket_id = tsh.ticket_id
    WHERE tsh.changed_by IS NOT NULL
      AND (
        tsh.change_reason ILIKE '%filed by worker%'
        OR tsh.change_reason ILIKE '%field intake%'
      )
      AND NOT EXISTS (SELECT 1 FROM from_created fc WHERE fc.ticket_id = tsh.ticket_id)
    ORDER BY tsh.ticket_id, tsh.created_at ASC
  )
  SELECT * FROM from_created
  UNION ALL
  SELECT * FROM from_history
  ORDER BY created_at ASC
`

async function main() {
  const url = process.env.DATABASE_URL?.trim()
  if (!url) {
    throw new Error('DATABASE_URL is required in .env.local')
  }

  const pool = new pg.Pool({
    connectionString: url,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  })

  try {
    const params = ORG_ID ? [ORG_ID] : []
    const { rows } = await pool.query<CandidateRow>(CANDIDATES_SQL, params)

    console.log(`Found ${rows.length} ticket(s) missing worker_filed_ticket audit`)
    if (ORG_ID) console.log(`  org filter: ${ORG_ID}`)
    if (DRY_RUN) console.log('  DRY_RUN=1 — no rows will be inserted')

    if (rows.length === 0) {
      return
    }

    let inserted = 0
    const client = await pool.connect()
    try {
      if (!DRY_RUN) await client.query('BEGIN')

      for (const row of rows) {
        if (DRY_RUN) {
          console.log(
            `  would insert: ticket=${row.ticket_number} actor=${row.actor_user_id} source=${row.source}`,
          )
          inserted++
          continue
        }

        const res = await client.query(
          `INSERT INTO audit_logs (
             organization_id, event_type, entity_type, entity_id,
             actor_type, actor_user_id, new_value_json, metadata_json, created_at
           )
           SELECT $1::uuid, 'worker_filed_ticket', 'ticket', $2::uuid,
                  'user', $3::uuid,
                  jsonb_build_object(
                    'ticket_number', $4::text,
                    'citizen_id', $5::text,
                    'needs_triage', COALESCE(t.needs_triage, true),
                    'backfilled', true
                  ),
                  jsonb_build_object('backfill_source', $6::text, 'backfilled_at', now()),
                  $7::timestamptz
           FROM tickets t
           WHERE t.id = $2::uuid
             AND NOT EXISTS (
               SELECT 1 FROM audit_logs wft
               WHERE wft.entity_type = 'ticket'
                 AND wft.entity_id = $2::uuid
                 AND wft.event_type = 'worker_filed_ticket'
             )
           RETURNING id`,
          [
            row.organization_id,
            row.ticket_id,
            row.actor_user_id,
            row.ticket_number,
            row.citizen_id,
            row.source,
            row.created_at,
          ],
        )

        if ((res.rowCount ?? 0) > 0) {
          inserted++
          console.log(`  inserted: ticket=${row.ticket_number} source=${row.source}`)
        }
      }

      if (!DRY_RUN) await client.query('COMMIT')
    } catch (err) {
      if (!DRY_RUN) await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }

    console.log(`Done. ${DRY_RUN ? 'Would insert' : 'Inserted'} ${inserted} worker_filed_ticket row(s).`)
  } finally {
    await pool.end()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
