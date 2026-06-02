/**
 * Shared fields for worker assignment offers (current-offer + offered bucket).
 */

import { createSupabaseServiceClient } from '@/lib/supabase.js'
import { isPostgresMode, dbQuery } from '@/lib/db.js'

export type WorkerOfferCategorySource = 'confirmed' | 'ai_suggestion'

export interface WorkerOfferCategory {
  id: string | null
  name: string
  source: WorkerOfferCategorySource
}

export interface WorkerOfferTicketExtras {
  offered_at?: string
  critical_flag: boolean
  category: WorkerOfferCategory | null
  /** Flat label for UI ("Utilities") — null if unknown. */
  category_name: string | null
}

export async function loadAiSuggestedCategoryLabels(
  ticketIds: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  if (ticketIds.length === 0) return map

  if (isPostgresMode()) {
    const res = await dbQuery<{ ticket_id: string; suggested_category: string }>(
      `SELECT DISTINCT ON (ticket_id) ticket_id, suggested_category
       FROM ai_ticket_suggestions
       WHERE ticket_id = ANY($1::uuid[])
         AND suggested_category IS NOT NULL
         AND trim(suggested_category) <> ''
       ORDER BY ticket_id, created_at DESC`,
      [ticketIds],
    )
    for (const row of res.rows) {
      map.set(row.ticket_id, row.suggested_category.trim())
    }
    return map
  }

  const supabase = createSupabaseServiceClient()
  const { data } = await supabase
    .from('ai_ticket_suggestions')
    .select('ticket_id, suggested_category, created_at')
    .in('ticket_id', ticketIds)
    .not('suggested_category', 'is', null)
    .order('created_at', { ascending: false })

  for (const row of data ?? []) {
    const tid = row.ticket_id as string
    const label = String(row.suggested_category ?? '').trim()
    if (label && !map.has(tid)) map.set(tid, label)
  }
  return map
}

export function resolveOfferCategory(
  ticketId: string,
  confirmedCategoryId: string | null | undefined,
  confirmedCategoryName: string | null | undefined,
  aiLabels: Map<string, string>,
): WorkerOfferCategory | null {
  const confirmedName = confirmedCategoryName?.trim()
  if (confirmedCategoryId && confirmedName) {
    return { id: confirmedCategoryId, name: confirmedName, source: 'confirmed' }
  }
  const aiName = aiLabels.get(ticketId)?.trim()
  if (aiName) {
    return { id: null, name: aiName, source: 'ai_suggestion' }
  }
  return null
}

export function categoryNameFromOfferCategory(category: WorkerOfferCategory | null): string | null {
  return category?.name ?? null
}
