/**
 * Generate (or backfill) AI ticket suggestions for an existing ticket.
 *
 *   npm run generate:ai-suggestion -- <ticket-uuid>
 *   npm run generate:ai-suggestion -- <ticket-uuid> --force
 *
 * Requires OPENROUTER_API_KEY (+ optional OPENROUTER_MODEL) in .env.local.
 * Uses the ticket's original_issue_text as input.
 */
import dotenv from 'dotenv'

dotenv.config()
dotenv.config({ path: '.env.local', override: true })

async function main() {
  const { createSupabaseServiceClient } = await import('../src/lib/supabase.js')
  const { generateTicketSuggestions } = await import('../src/services/aiService.js')
  const args = process.argv.slice(2).filter((a) => a !== '--')
  const force = args.includes('--force')
  const ticketId = args.find((a) => !a.startsWith('--'))

  if (!ticketId) {
    console.error('Usage: npm run generate:ai-suggestion -- <ticket-id> [--force]')
    process.exit(1)
  }

  const supabase = createSupabaseServiceClient()

  const { data: ticket, error: ticketErr } = await supabase
    .from('tickets')
    .select('id, ticket_number, original_issue_text, normalized_summary')
    .eq('id', ticketId)
    .maybeSingle()

  if (ticketErr) {
    throw new Error(`Ticket lookup failed: ${ticketErr.message}`)
  }
  if (!ticket) {
    console.error(`Ticket not found: ${ticketId}`)
    process.exit(1)
  }

  const issueText = (ticket.original_issue_text ?? ticket.normalized_summary ?? '').trim()
  if (!issueText) {
    console.error(`Ticket ${ticket.ticket_number} has no original_issue_text — nothing to send to AI`)
    process.exit(1)
  }

  const { data: existing } = await supabase
    .from('ai_ticket_suggestions')
    .select('id, status, confirmed, created_at')
    .eq('ticket_id', ticketId)
    .eq('status', 'completed')
    .eq('confirmed', false)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (existing && !force) {
    console.log(`Pending suggestion already exists (${existing.id}). Use --force to add another row.`)
    process.exit(0)
  }

  console.log(`Generating AI suggestions for ${ticket.ticket_number} (${ticketId})…`)
  const s = await generateTicketSuggestions(issueText)

  if (s.error) {
    console.error(`AI failed: ${s.error}`)
    process.exit(1)
  }

  const { data: row, error: insertErr } = await supabase
    .from('ai_ticket_suggestions')
    .insert({
      ticket_id: ticketId,
      model_used: process.env.OPENROUTER_MODEL ?? 'unknown',
      suggested_title: s.suggested_title,
      suggested_summary: s.suggested_summary,
      suggested_category: s.suggested_category,
      suggested_severity: s.suggested_severity,
      suggested_department: s.suggested_department,
      suggested_location_text: s.suggested_location_text,
      confidence_json: s.confidence_json,
      raw_ai_response: s.raw_ai_response as Record<string, unknown> | null,
      status: 'completed',
    })
    .select('id, suggested_title, suggested_category, suggested_severity, status, confirmed')
    .single()

  if (insertErr) {
    throw new Error(`Insert failed: ${insertErr.message}`)
  }

  console.log('Inserted ai_ticket_suggestions row:')
  console.log(JSON.stringify(row, null, 2))
  console.log(`\nVerify: GET /v2/tickets/${ticketId}/ai-suggestion`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
