import { dbQuery } from '@/lib/db.js'

/**
 * Tenant-configurable Bharosa policy. Stored under
 * organization_settings.settings_json -> 'bharosa' and merged over defaults,
 * so tenants differ by configuration rather than code.
 */
export interface BharosaSettings {
  languages: string[]
  defaultLanguage: string
  otp: {
    ttlMinutes: number
    maxVerifyAttempts: number
    resendCooldownSeconds: number
    maxSendsPerPhonePerHour: number
    maxSendsPerIpPerHour: number
  }
  verification: {
    /** Start an automated or assisted verification call right after a case is created. */
    callAfterCreate: boolean
    /** 'manual' = assisted queue with AI script; 'automated' = voice provider places the call. */
    callMode: 'manual' | 'automated'
    /** Categories that always need a field visit before routing. */
    fieldVisitCategories: string[]
  }
  routing: {
    /** Minimum confidence for an authority to be shown as "suggested" rather than "uncertain". */
    minConfidence: number
    maxCandidates: number
  }
  followUp: {
    /** Hours after send for each follow-up. Length = max follow-ups. */
    intervalsHours: number[]
    /** Escalate to the next authority level after the last follow-up gets no reply. */
    escalateAfterLastFollowUp: boolean
  }
  escalation: {
    /** Open tasks with no status change for this many hours are flagged to the GRO. */
    taskInactivityHours: number
    /** Cases still unverified after this many hours are flagged to the GRO. */
    unverifiedCaseHours: number
  }
  email: {
    senderMode: 'platform' | 'organization' | 'citizen_name'
    footer: { en: string; te: string }
  }
  notifications: {
    whatsappEnabled: boolean
    smsFallback: boolean
  }
}

export const DEFAULT_SETTINGS: BharosaSettings = {
  languages: ['te', 'en'],
  defaultLanguage: 'te',
  otp: {
    ttlMinutes: 10,
    maxVerifyAttempts: 5,
    resendCooldownSeconds: 45,
    maxSendsPerPhonePerHour: 5,
    maxSendsPerIpPerHour: 20,
  },
  verification: {
    callAfterCreate: true,
    callMode: 'manual',
    fieldVisitCategories: [],
  },
  routing: {
    minConfidence: 0.6,
    maxCandidates: 5,
  },
  followUp: {
    intervalsHours: [72, 168, 336],
    escalateAfterLastFollowUp: true,
  },
  escalation: {
    taskInactivityHours: 72,
    unverifiedCaseHours: 24,
  },
  email: {
    senderMode: 'platform',
    footer: {
      en: 'This grievance was submitted by a verified citizen through Bharosa. Please reply to this email to respond; your reply is recorded against the case.',
      te: 'ఈ ఫిర్యాదును ధృవీకరించబడిన పౌరుడు భరోసా ద్వారా సమర్పించారు. స్పందించడానికి దయచేసి ఈ ఇమెయిల్‌కు ప్రత్యుత్తరం ఇవ్వండి; మీ ప్రత్యుత్తరం కేసులో నమోదు చేయబడుతుంది.',
    },
  },
  notifications: {
    whatsappEnabled: true,
    smsFallback: false,
  },
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(patch) || !isPlainObject(base)) return (patch as T) ?? base
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v
  }
  return out as T
}

const cache = new Map<string, { value: BharosaSettings; expires: number }>()

export async function getBharosaSettings(orgId: string): Promise<BharosaSettings> {
  const hit = cache.get(orgId)
  if (hit && hit.expires > Date.now()) return hit.value
  const res = await dbQuery<{ s: unknown }>(
    `SELECT settings_json->'bharosa' AS s FROM organization_settings WHERE organization_id = $1`,
    [orgId],
  )
  const value = deepMerge(DEFAULT_SETTINGS, res.rows[0]?.s ?? {})
  cache.set(orgId, { value, expires: Date.now() + 60_000 })
  return value
}

export async function updateBharosaSettings(
  orgId: string,
  patch: Record<string, unknown>,
): Promise<BharosaSettings> {
  const current = await getBharosaSettings(orgId)
  const next = deepMerge(current, patch)
  await dbQuery(
    `INSERT INTO organization_settings (organization_id, settings_json)
     VALUES ($1, jsonb_build_object('bharosa', $2::jsonb))
     ON CONFLICT (organization_id) DO UPDATE
       SET settings_json = COALESCE(organization_settings.settings_json, '{}'::jsonb)
                           || jsonb_build_object('bharosa', $2::jsonb),
           updated_at = now()`,
    [orgId, JSON.stringify(next)],
  )
  cache.delete(orgId)
  return next
}
