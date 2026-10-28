/**
 * Persistent Guide memory for logged-in citizens.
 * Used to greet returning users with prior problems / area / behavior —
 * without forcing the previous topic when they ask something new.
 */

import { dbQuery } from '@/lib/db.js'
import { recallEchoForCitizen, writeEchoGuideEpisode } from './echoGuideMemory.js'
import { echoMemoryConfigured } from './echoMemoryClient.js'
import { openclawGatewayConfigured, openclawMemoryRemember, openclawMemorySearch } from './openclawClient.js'

export interface MemoryProblem {
  problem_id: string | null
  summary: string
  status: 'open' | 'raised' | 'satisfied'
  count: number
  last_at: string
  area?: string | null
}

export interface CitizenMemoryProfile {
  name?: string
  preferred_language?: string
  phone?: string
  email?: string
  areas: string[]
  problems: MemoryProblem[]
  behavior: {
    turn_count: number
    wants_desk_help_count: number
    self_serve_count: number
    languages: string[]
    /** Soft hint only — never force this topic. */
    likely_next?: string | null
  }
  last_session_id?: string
  openclaw_notes?: string[]
  /** Compact Echo Memory facts (token-efficient context). */
  echo_facts?: string[]
  echo_prompt_block?: string
}

const EMPTY_PROFILE = (): CitizenMemoryProfile => ({
  areas: [],
  problems: [],
  behavior: {
    turn_count: 0,
    wants_desk_help_count: 0,
    self_serve_count: 0,
    languages: [],
    likely_next: null,
  },
})

function asProfile(raw: unknown): CitizenMemoryProfile {
  if (!raw || typeof raw !== 'object') return EMPTY_PROFILE()
  const row = raw as Record<string, unknown>
  const behavior = (row.behavior && typeof row.behavior === 'object' ? row.behavior : {}) as Record<
    string,
    unknown
  >
  const problems: MemoryProblem[] = Array.isArray(row.problems)
    ? row.problems
        .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
        .map((p): MemoryProblem => ({
          problem_id: typeof p.problem_id === 'string' ? p.problem_id : null,
          summary: typeof p.summary === 'string' ? p.summary.slice(0, 200) : '',
          status:
            p.status === 'raised' || p.status === 'satisfied' || p.status === 'open'
              ? p.status
              : 'open',
          count: typeof p.count === 'number' ? p.count : 1,
          last_at: typeof p.last_at === 'string' ? p.last_at : new Date().toISOString(),
          area: typeof p.area === 'string' ? p.area : null,
        }))
        .filter((p) => p.summary)
        .slice(0, 12)
    : []
  const areas = Array.isArray(row.areas)
    ? row.areas.filter((a): a is string => typeof a === 'string').map((a) => a.slice(0, 80)).slice(0, 8)
    : []
  const languages = Array.isArray(behavior.languages)
    ? behavior.languages.filter((l): l is string => typeof l === 'string').slice(0, 5)
    : []
  return {
    name: typeof row.name === 'string' ? row.name.slice(0, 80) : undefined,
    preferred_language: typeof row.preferred_language === 'string' ? row.preferred_language : undefined,
    phone: typeof row.phone === 'string' ? row.phone : undefined,
    email: typeof row.email === 'string' ? row.email : undefined,
    areas,
    problems,
    behavior: {
      turn_count: typeof behavior.turn_count === 'number' ? behavior.turn_count : 0,
      wants_desk_help_count:
        typeof behavior.wants_desk_help_count === 'number' ? behavior.wants_desk_help_count : 0,
      self_serve_count: typeof behavior.self_serve_count === 'number' ? behavior.self_serve_count : 0,
      languages,
      likely_next: typeof behavior.likely_next === 'string' ? behavior.likely_next : null,
    },
    last_session_id: typeof row.last_session_id === 'string' ? row.last_session_id : undefined,
    openclaw_notes: Array.isArray(row.openclaw_notes)
      ? row.openclaw_notes.filter((n): n is string => typeof n === 'string').slice(0, 5)
      : undefined,
    echo_facts: Array.isArray(row.echo_facts)
      ? row.echo_facts.filter((n): n is string => typeof n === 'string').slice(0, 10)
      : undefined,
  }
}

export async function loadCitizenMemory(
  orgId: string,
  citizenId: string,
): Promise<{ id: string; profile: CitizenMemoryProfile } | null> {
  const res = await dbQuery<{ id: string; profile_json: unknown }>(
    `SELECT id, profile_json FROM citizen_guide_memory
     WHERE organization_id = $1 AND citizen_id = $2`,
    [orgId, citizenId],
  )
  if (!res.rows[0]) return null
  return { id: res.rows[0].id, profile: asProfile(res.rows[0].profile_json) }
}

export async function ensureCitizenMemory(
  orgId: string,
  citizenId: string,
  seed?: Partial<CitizenMemoryProfile>,
): Promise<{ id: string; profile: CitizenMemoryProfile }> {
  const existing = await loadCitizenMemory(orgId, citizenId)
  if (existing) {
    if (seed) {
      const merged = mergeSeed(existing.profile, seed)
      await saveCitizenMemory(orgId, citizenId, existing.id, merged)
      return { id: existing.id, profile: merged }
    }
    return existing
  }

  const profile = mergeSeed(EMPTY_PROFILE(), seed ?? {})
  // Bootstrap from past guide sessions + tickets when first creating memory
  const bootstrapped = await bootstrapFromHistory(orgId, citizenId, profile)
  const ins = await dbQuery<{ id: string }>(
    `INSERT INTO citizen_guide_memory (organization_id, citizen_id, profile_json)
     VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (organization_id, citizen_id)
     DO UPDATE SET profile_json = EXCLUDED.profile_json, updated_at = now()
     RETURNING id`,
    [orgId, citizenId, JSON.stringify(bootstrapped)],
  )
  return { id: ins.rows[0].id, profile: bootstrapped }
}

async function saveCitizenMemory(
  orgId: string,
  citizenId: string,
  memoryId: string,
  profile: CitizenMemoryProfile,
): Promise<void> {
  await dbQuery(
    `UPDATE citizen_guide_memory
     SET profile_json = $3::jsonb, updated_at = now()
     WHERE id = $1 AND organization_id = $2 AND citizen_id = $4`,
    [memoryId, orgId, JSON.stringify(profile), citizenId],
  )
}

function mergeSeed(
  base: CitizenMemoryProfile,
  seed: Partial<CitizenMemoryProfile>,
): CitizenMemoryProfile {
  return {
    ...base,
    name: seed.name ?? base.name,
    preferred_language: seed.preferred_language ?? base.preferred_language,
    phone: seed.phone ?? base.phone,
    email: seed.email ?? base.email,
    areas: uniqueStrings([...(seed.areas ?? []), ...base.areas]).slice(0, 8),
    problems: seed.problems?.length ? seed.problems : base.problems,
    behavior: {
      ...base.behavior,
      ...(seed.behavior ?? {}),
      languages: uniqueStrings([
        ...(seed.behavior?.languages ?? []),
        ...base.behavior.languages,
      ]).slice(0, 5),
    },
    last_session_id: seed.last_session_id ?? base.last_session_id,
    openclaw_notes: seed.openclaw_notes ?? base.openclaw_notes,
  }
}

async function bootstrapFromHistory(
  orgId: string,
  citizenId: string,
  profile: CitizenMemoryProfile,
): Promise<CitizenMemoryProfile> {
  const guides = await dbQuery<{
    id: string
    problem_id: string | null
    status: string
    contact_json: unknown
    updated_at: string
  }>(
    `SELECT id, problem_id, status, contact_json, updated_at::text AS updated_at
     FROM guide_sessions
     WHERE organization_id = $1 AND citizen_id = $2
     ORDER BY updated_at DESC
     LIMIT 15`,
    [orgId, citizenId],
  )

  // Also match by phone on older sessions without citizen_id
  let phoneGuides: typeof guides.rows = []
  if (profile.phone) {
    const digits = profile.phone.replace(/\D/g, '').slice(-10)
    if (digits.length === 10) {
      const byPhone = await dbQuery<{
        id: string
        problem_id: string | null
        status: string
        contact_json: unknown
        updated_at: string
      }>(
        `SELECT id, problem_id, status, contact_json, updated_at::text AS updated_at
         FROM guide_sessions
         WHERE organization_id = $1
           AND contact_json->>'phone' = $2
           AND (citizen_id IS NULL OR citizen_id = $3)
         ORDER BY updated_at DESC
         LIMIT 10`,
        [orgId, digits, citizenId],
      )
      phoneGuides = byPhone.rows
    }
  }

  const seen = new Set<string>()
  for (const row of [...guides.rows, ...phoneGuides]) {
    if (seen.has(row.id)) continue
    seen.add(row.id)
    const c =
      row.contact_json && typeof row.contact_json === 'object'
        ? (row.contact_json as Record<string, unknown>)
        : {}
    const summary =
      (typeof c.problem_summary === 'string' && c.problem_summary) ||
      row.problem_id ||
      ''
    if (!summary) continue
    upsertProblem(profile, {
      problem_id: row.problem_id,
      summary: String(summary).slice(0, 200),
      status: row.status === 'raised' || row.status === 'satisfied' ? row.status : 'open',
      last_at: row.updated_at,
      area: typeof c.place === 'string' ? c.place : null,
    })
    if (typeof c.place === 'string' && c.place.trim()) {
      profile.areas = uniqueStrings([c.place.trim(), ...profile.areas]).slice(0, 8)
    }
    if (typeof c.name === 'string' && !profile.name) profile.name = c.name
  }

  const tickets = await dbQuery<{
    ticket_number: string
    stage: string
    original_issue_text: string | null
    location_text: string | null
    updated_at: string
  }>(
    `SELECT ticket_number, stage, original_issue_text, location_text, updated_at::text AS updated_at
     FROM tickets
     WHERE organization_id = $1 AND citizen_id = $2
     ORDER BY updated_at DESC
     LIMIT 8`,
    [orgId, citizenId],
  )
  for (const t of tickets.rows) {
    const summary = (t.original_issue_text ?? t.ticket_number).replace(/\s+/g, ' ').slice(0, 200)
    upsertProblem(profile, {
      problem_id: `ticket:${t.ticket_number}`,
      summary,
      status: t.stage === 'closed' ? 'satisfied' : 'raised',
      last_at: t.updated_at,
      area: t.location_text,
    })
    if (t.location_text) {
      profile.areas = uniqueStrings([t.location_text, ...profile.areas]).slice(0, 8)
    }
  }

  profile.behavior.likely_next = profile.problems[0]?.summary?.slice(0, 80) ?? null
  return profile
}

function upsertProblem(
  profile: CitizenMemoryProfile,
  next: {
    problem_id: string | null
    summary: string
    status: MemoryProblem['status']
    last_at: string
    area?: string | null
  },
): void {
  const key = (next.problem_id || next.summary).toLowerCase()
  const idx = profile.problems.findIndex(
    (p) => (p.problem_id || p.summary).toLowerCase() === key ||
      (p.summary && next.summary && p.summary.toLowerCase().includes(next.summary.toLowerCase().slice(0, 40))),
  )
  if (idx >= 0) {
    const cur = profile.problems[idx]!
    profile.problems[idx] = {
      ...cur,
      summary: next.summary || cur.summary,
      status: next.status,
      count: cur.count + 1,
      last_at: next.last_at,
      area: next.area ?? cur.area,
    }
  } else {
    profile.problems.unshift({
      problem_id: next.problem_id,
      summary: next.summary,
      status: next.status,
      count: 1,
      last_at: next.last_at,
      area: next.area ?? null,
    })
  }
  profile.problems = profile.problems.slice(0, 12)
}

export type MemoryTouchEvent =
  | 'problem_mentioned'
  | 'topic_switch'
  | 'raised'
  | 'satisfied'
  | 'wants_desk'
  | 'area_given'
  | 'session_touch'

export async function touchCitizenMemory(args: {
  orgId: string
  citizenId: string
  sessionId: string
  event: MemoryTouchEvent
  language?: string
  name?: string | null
  phone?: string | null
  email?: string | null
  place?: string | null
  problemId?: string | null
  problemSummary?: string | null
  status?: MemoryProblem['status']
}): Promise<CitizenMemoryProfile> {
  const { id, profile } = await ensureCitizenMemory(args.orgId, args.citizenId, {
    name: args.name ?? undefined,
    phone: args.phone ?? undefined,
    email: args.email ?? undefined,
  })

  profile.last_session_id = args.sessionId
  profile.behavior.turn_count += 1
  if (args.language) {
    profile.behavior.languages = uniqueStrings([args.language, ...profile.behavior.languages]).slice(0, 5)
    profile.preferred_language = args.language
  }
  if (args.name) profile.name = args.name.slice(0, 80)
  if (args.phone) profile.phone = args.phone
  if (args.email) profile.email = args.email
  if (args.place?.trim()) {
    profile.areas = uniqueStrings([args.place.trim(), ...profile.areas]).slice(0, 8)
  }

  if (args.event === 'wants_desk') profile.behavior.wants_desk_help_count += 1
  if (
    args.event === 'problem_mentioned' &&
    (args.problemId?.startsWith('aadhaar') || args.problemId?.startsWith('pan'))
  ) {
    profile.behavior.self_serve_count += 1
  }

  if (args.problemSummary || args.problemId) {
    upsertProblem(profile, {
      problem_id: args.problemId ?? null,
      summary: (args.problemSummary || args.problemId || 'issue').slice(0, 200),
      status: args.status ?? (args.event === 'raised' ? 'raised' : args.event === 'satisfied' ? 'satisfied' : 'open'),
      last_at: new Date().toISOString(),
      area: args.place ?? null,
    })
  }

  if (args.event === 'topic_switch') {
    profile.behavior.likely_next = args.problemSummary?.slice(0, 80) ?? profile.behavior.likely_next
  } else if (profile.problems[0]) {
    profile.behavior.likely_next = profile.problems[0].summary.slice(0, 80)
  }

  await saveCitizenMemory(args.orgId, args.citizenId, id, profile)
  await dbQuery(
    `INSERT INTO citizen_guide_memory_events (memory_id, event_type, payload)
     VALUES ($1, $2, $3::jsonb)`,
    [
      id,
      args.event,
      JSON.stringify({
        session_id: args.sessionId,
        problem_id: args.problemId ?? null,
        summary: args.problemSummary?.slice(0, 120) ?? null,
        place: args.place ?? null,
      }),
    ],
  )

  // Best-effort OpenClaw mirror (staff enrichment); never blocks citizen chat
  if (openclawGatewayConfigured() && (args.event === 'problem_mentioned' || args.event === 'raised')) {
    const note = [
      `Citizen ${args.citizenId.slice(0, 8)}`,
      profile.name ? `name=${profile.name}` : null,
      args.problemSummary ? `problem=${args.problemSummary.slice(0, 100)}` : null,
      args.place ? `area=${args.place}` : null,
      `event=${args.event}`,
    ]
      .filter(Boolean)
      .join(' | ')
    void openclawMemoryRemember(note)
  }

  // Echo Memory: write compact graph facts (token-efficient recall later)
  if (
    echoMemoryConfigured() &&
    (args.event === 'problem_mentioned' ||
      args.event === 'raised' ||
      args.event === 'area_given' ||
      args.event === 'topic_switch') &&
    (args.problemId || args.problemSummary)
  ) {
    void writeEchoGuideEpisode({
      sessionId: args.sessionId,
      citizenId: args.citizenId,
      name: profile.name ?? args.name,
      place: args.place ?? profile.areas[0],
      problemId: args.problemId,
      problemSummary: args.problemSummary,
      status: args.status ?? 'open',
      language: args.language,
      assumeNew: profile.behavior.turn_count <= 1,
    })
  }

  return profile
}

/** Enrich with Echo (preferred) + OpenClaw snippets — both optional / soft-fail. */
export async function enrichMemoryWithOpenClaw(
  profile: CitizenMemoryProfile,
  query: string,
  citizenId?: string,
): Promise<CitizenMemoryProfile> {
  let next = { ...profile }

  if (echoMemoryConfigured() && citizenId) {
    const { facts, promptBlock } = await recallEchoForCitizen({
      citizenId,
      name: profile.name,
      query: query || profile.behavior.likely_next || 'citizen help history',
      topK: 8,
    })
    if (promptBlock) {
      next.echo_prompt_block = promptBlock
      next.echo_facts = facts
        .map((f) => (typeof f.fact === 'string' ? f.fact : ''))
        .filter(Boolean)
        .slice(0, 8)
    }
  }

  if (openclawGatewayConfigured()) {
    const q = [profile.name, profile.phone?.slice(-4), query, profile.behavior.likely_next]
      .filter(Boolean)
      .join(' ')
      .slice(0, 300)
    const notes = await openclawMemorySearch(q || 'bharosa citizen')
    if (notes.length) next = { ...next, openclaw_notes: notes.slice(0, 5) }
  }

  return next
}

/** Compact block for the Guide LLM — past context without forcing the old topic. */
export function memoryContextForPrompt(profile: CitizenMemoryProfile | null | undefined): string {
  if (!profile) return ''
  const lines: string[] = ['RETURNING CITIZEN MEMORY (use for greeting/context only; answer the LATEST message):']
  if (profile.name) lines.push(`- Name: ${profile.name}`)
  if (profile.areas.length) lines.push(`- Known areas: ${profile.areas.slice(0, 3).join('; ')}`)
  if (profile.problems.length) {
    const open = profile.problems.filter((p) => p.status === 'open' || p.status === 'raised').slice(0, 3)
    const done = profile.problems.filter((p) => p.status === 'satisfied').slice(0, 2)
    if (open.length) {
      lines.push(
        `- Open / raised before: ${open.map((p) => `"${p.summary}" (${p.status}${p.area ? `, ${p.area}` : ''})`).join('; ')}`,
      )
    }
    if (done.length) {
      lines.push(`- Previously helped with: ${done.map((p) => `"${p.summary}"`).join('; ')}`)
    }
  }
  if (profile.behavior.wants_desk_help_count >= 2) {
    lines.push('- Behavior: often prefers help-desk escalation over self-service.')
  }
  if (profile.behavior.self_serve_count >= 2) {
    lines.push('- Behavior: often handles Aadhaar/PAN-style steps themselves.')
  }
  if (profile.behavior.likely_next) {
    lines.push(
      `- Soft guess of what they may ask next: "${profile.behavior.likely_next}" — only mention if greeting; never force if they asked something else.`,
    )
  }
  if (profile.openclaw_notes?.length) {
    lines.push(`- Extra notes: ${profile.openclaw_notes.slice(0, 3).join(' | ')}`)
  }
  if (profile.echo_prompt_block) {
    lines.push(profile.echo_prompt_block)
  } else if (profile.echo_facts?.length) {
    lines.push(
      'ECHO MEMORY:',
      ...profile.echo_facts.slice(0, 6).map((f, i) => `${i + 1}. ${f.slice(0, 200)}`),
    )
  }
  lines.push(
    'If they start a NEW problem, ignore old ones. Do not re-ask name/phone/email you already know unless filing.',
  )
  return lines.join('\n')
}

/** One-line welcome for returning users (no dual-path spam). */
export function memoryWelcomeLine(
  profile: CitizenMemoryProfile,
  lang: 'en' | 'te' | 'hi',
): string | null {
  if (!profile.name && !profile.problems.length) return null
  const name = profile.name?.trim() || ''
  const open = profile.problems.find((p) => p.status === 'open' || p.status === 'raised')
  if (lang === 'te') {
    if (open) {
      return `మళ్లీ స్వాగతం${name ? `, ${name}` : ''}. ముందు "${open.summary.slice(0, 50)}" గురించి మాట్లాడాం — అదే కొనసాగాలా, లేక కొత్త సమస్యా?`
    }
    return name ? `మళ్లీ స్వాగతం, ${name}. ఏ సహాయం కావాలి?` : null
  }
  if (lang === 'hi') {
    if (open) {
      return `फिर से स्वागत है${name ? `, ${name}` : ''}। पहले "${open.summary.slice(0, 50)}" की बात हुई थी — वही जारी रखें या नई समस्या बताएँ?`
    }
    return name ? `फिर से स्वागत है, ${name}। किसमें मदद चाहिए?` : null
  }
  if (open) {
    return `Welcome back${name ? `, ${name}` : ''}. Last time we talked about "${open.summary.slice(0, 60)}" — continue that, or a new problem?`
  }
  return name ? `Welcome back, ${name}. What do you need help with?` : null
}

function uniqueStrings(items: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of items) {
    const key = item.trim().toLowerCase()
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(item.trim())
  }
  return out
}

export async function getCitizenMemoryForCompanion(orgId: string, citizenId: string) {
  const row = await loadCitizenMemory(orgId, citizenId)
  if (!row) return null
  return {
    citizen_id: citizenId,
    memory_id: row.id,
    profile: row.profile,
    openclaw_enabled: openclawGatewayConfigured(),
  }
}
