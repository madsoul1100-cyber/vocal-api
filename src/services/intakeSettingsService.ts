/**
 * Intake settings — read/write the `intake_conversation_version` flag.
 *
 * Used by:
 *   • The Telegram webhook (read) — to pick V1 state machine vs V2 LLM.
 *   • The SuperAdmin settings UI (read + write) — to flip the flag.
 *
 * Default is 'v1' for safety. If the org has no `organization_settings`
 * row yet, getIntakeVersion returns 'v1' and the caller can decide
 * whether to lazily create the row.
 */

import { createSupabaseServiceClient } from '@/lib/supabase.js'

export type IntakeVersion = 'v1' | 'v2'

export async function getIntakeVersion(organizationId: string): Promise<IntakeVersion> {
  const supabase = createSupabaseServiceClient()
  const { data } = await supabase
    .from('organization_settings')
    .select('intake_conversation_version')
    .eq('organization_id', organizationId)
    .maybeSingle()
  const v = (data as { intake_conversation_version?: string } | null)?.intake_conversation_version
  return v === 'v2' ? 'v2' : 'v1'
}

export async function setIntakeVersion(
  organizationId: string,
  version: IntakeVersion,
): Promise<{ ok: boolean; error?: string }> {
  if (version !== 'v1' && version !== 'v2') {
    return { ok: false, error: `Invalid version: ${version}` }
  }
  const supabase = createSupabaseServiceClient()

  // Upsert by organization_id (unique constraint exists on that column).
  const { error } = await supabase
    .from('organization_settings')
    .upsert(
      { organization_id: organizationId, intake_conversation_version: version, updated_at: new Date().toISOString() },
      { onConflict: 'organization_id' },
    )
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}
