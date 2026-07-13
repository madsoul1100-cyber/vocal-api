/**
 * Re-resolve tickets.territory_id using the current territory mapper (rules + AI + GPS).
 * Use after improving territory resolution so heat maps and routing reflect correct districts.
 *
 * Usage:
 *   ORG_ID=<uuid> DRY_RUN=1 npm run backfill:ticket-territories
 *   ORG_ID=<uuid> npm run backfill:ticket-territories
 *   ORG_ID=<uuid> LIMIT=50 npm run backfill:ticket-territories
 *   ORG_ID=<uuid> ONLY_NULL=1 npm run backfill:ticket-territories   # skip tickets that already have territory_id
 *
 * Env:
 *   DRY_RUN=1          Preview changes only (no DB writes)
 *   ORG_ID             Required organization UUID
 *   LIMIT              Max tickets to process (default 200)
 *   ONLY_NULL=1        Only tickets with territory_id IS NULL
 *   DELAY_MS           Pause between tickets when calling AI (default 300)
 */
import '../src/loadEnv.js'
import { dbQuery, isPostgresMode } from '../src/lib/db.js'
import { createSupabaseServiceClient } from '../src/lib/supabase.js'
import { getDistrictAncestor } from '../src/services/territoryCandidateService.js'
import {
  resolveAndApplyTicketTerritory,
  resolveTicketTerritory,
} from '../src/services/territoryResolveService.js'
import { loadOrgTerritoryRowsCached } from '../src/services/territoryService.js'

const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true'
const ORG_ID = process.env.ORG_ID?.trim()
const LIMIT = Math.max(1, parseInt(process.env.LIMIT ?? '200', 10) || 200)
const ONLY_NULL = process.env.ONLY_NULL === '1' || process.env.ONLY_NULL === 'true'
const DELAY_MS = Math.max(0, parseInt(process.env.DELAY_MS ?? '300', 10) || 300)

interface TicketRow {
  id: string
  ticket_number: string
  organization_id: string
  territory_id: string | null
  territory_name: string | null
  location_text: string | null
  original_issue_text: string | null
  latitude: number | null
  longitude: number | null
  created_at: string
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function districtLabel(
  territoryId: string | null | undefined,
  byId: Map<string, Awaited<ReturnType<typeof loadOrgTerritoryRowsCached>>[number]>,
): string {
  if (!territoryId) return '(none)'
  const node = byId.get(territoryId)
  if (!node) return territoryId.slice(0, 8)
  const district = getDistrictAncestor(territoryId, byId)
  return district ? `${node.name} → ${district.name}` : node.name
}

async function loadTickets(organizationId: string): Promise<TicketRow[]> {
  const nullFilter = ONLY_NULL ? 'AND t.territory_id IS NULL' : ''

  if (isPostgresMode()) {
    const res = await dbQuery<TicketRow>(
      `SELECT
         t.id,
         t.ticket_number,
         t.organization_id,
         t.territory_id,
         tr.name AS territory_name,
         t.location_text,
         t.original_issue_text,
         t.latitude,
         t.longitude,
         t.created_at::text
       FROM tickets t
       LEFT JOIN territories tr ON tr.id = t.territory_id
       WHERE t.organization_id = $1
         ${nullFilter}
         AND (
           (t.location_text IS NOT NULL AND btrim(t.location_text) <> '')
           OR (t.original_issue_text IS NOT NULL AND btrim(t.original_issue_text) <> '')
           OR (t.latitude IS NOT NULL AND t.longitude IS NOT NULL)
         )
       ORDER BY t.created_at DESC
       LIMIT $2`,
      [organizationId, LIMIT],
    )
    return res.rows
  }

  const supabase = createSupabaseServiceClient()
  let query = supabase
    .from('tickets')
    .select(
      'id, ticket_number, organization_id, territory_id, location_text, original_issue_text, latitude, longitude, created_at',
    )
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false })
    .limit(LIMIT)

  if (ONLY_NULL) {
    query = query.is('territory_id', null)
  }

  const { data, error } = await query
  if (error) throw new Error(error.message)

  const rows = (data ?? []).filter(
    (t) =>
      (t.location_text && String(t.location_text).trim()) ||
      (t.original_issue_text && String(t.original_issue_text).trim()) ||
      (t.latitude != null && t.longitude != null),
  )

  const territoryIds = [...new Set(rows.map((r) => r.territory_id).filter(Boolean))] as string[]
  const nameById = new Map<string, string>()
  if (territoryIds.length > 0) {
    const { data: territories } = await supabase
      .from('territories')
      .select('id, name')
      .in('id', territoryIds)
    for (const tr of territories ?? []) {
      nameById.set(tr.id as string, tr.name as string)
    }
  }

  return rows.map((t) => ({
    id: t.id as string,
    ticket_number: t.ticket_number as string,
    organization_id: t.organization_id as string,
    territory_id: (t.territory_id as string | null) ?? null,
    territory_name: t.territory_id ? (nameById.get(t.territory_id as string) ?? null) : null,
    location_text: (t.location_text as string | null) ?? null,
    original_issue_text: (t.original_issue_text as string | null) ?? null,
    latitude: t.latitude as number | null,
    longitude: t.longitude as number | null,
    created_at: t.created_at as string,
  }))
}

async function main() {
  if (!ORG_ID) {
    console.error('ORG_ID is required (set in .env.local or env)')
    process.exit(1)
  }

  console.log(
    `Ticket territory backfill — org=${ORG_ID} limit=${LIMIT} only_null=${ONLY_NULL} dry_run=${DRY_RUN}`,
  )

  const tickets = await loadTickets(ORG_ID)
  console.log(`Found ${tickets.length} ticket(s) with location/issue text or GPS`)

  if (tickets.length === 0) {
    console.log('Nothing to do.')
    return
  }

  const territoryRows = await loadOrgTerritoryRowsCached(ORG_ID)
  const byId = new Map(territoryRows.map((r) => [r.id, r]))

  let updated = 0
  let unchanged = 0
  let skippedLowConfidence = 0
  let skippedNoMatch = 0

  for (let i = 0; i < tickets.length; i++) {
    const ticket = tickets[i]!
    const oldLabel = districtLabel(ticket.territory_id, byId)

    if (DRY_RUN) {
      const match = await resolveTicketTerritory({
        organizationId: ORG_ID,
        locationText: ticket.location_text,
        issueText: ticket.original_issue_text,
        latitude: ticket.latitude,
        longitude: ticket.longitude,
        applyConfidenceGate: true,
      })

      const newId = match.territoryId
      const newLabel = districtLabel(newId, byId)

      if (!newId || !match.shouldAutoApply) {
        if (!newId) skippedNoMatch++
        else skippedLowConfidence++
        console.log(
          `[skip] ${ticket.ticket_number} conf=${match.confidence.toFixed(2)} ${match.resolutionNotes ?? ''}`,
        )
      } else if (newId === ticket.territory_id) {
        unchanged++
        console.log(`[same] ${ticket.ticket_number} ${oldLabel}`)
      } else {
        updated++
        console.log(
          `[would update] ${ticket.ticket_number}: ${oldLabel} → ${newLabel} (${match.matchQuality}, conf=${match.confidence.toFixed(2)})`,
        )
      }
    } else {
      const result = await resolveAndApplyTicketTerritory({
        ticketId: ticket.id,
        organizationId: ORG_ID,
        force: !ONLY_NULL,
      })

      const newLabel = districtLabel(result.territoryId, byId)

      if (result.applied) {
        updated++
        console.log(
          `[updated] ${ticket.ticket_number}: ${oldLabel} → ${newLabel} (${result.matchQuality}, conf=${result.confidence.toFixed(2)})`,
        )
      } else if (result.territoryId && result.territoryId === ticket.territory_id) {
        unchanged++
      } else if (!result.territoryId || !result.shouldAutoApply) {
        if (!result.territoryId) skippedNoMatch++
        else skippedLowConfidence++
        console.log(
          `[skip] ${ticket.ticket_number} conf=${result.confidence.toFixed(2)} ${result.resolutionNotes ?? ''}`,
        )
      } else {
        unchanged++
      }
    }

    if (DELAY_MS > 0 && i < tickets.length - 1) {
      await sleep(DELAY_MS)
    }
  }

  console.log('')
  console.log('Summary:')
  console.log(`  ${DRY_RUN ? 'would update' : 'updated'}: ${updated}`)
  console.log(`  unchanged: ${unchanged}`)
  console.log(`  skipped (low confidence): ${skippedLowConfidence}`)
  console.log(`  skipped (no match): ${skippedNoMatch}`)
  if (DRY_RUN) {
    console.log('')
    console.log('Re-run without DRY_RUN=1 to apply changes.')
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
