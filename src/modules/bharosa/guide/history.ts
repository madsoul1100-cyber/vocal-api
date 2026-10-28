/**
 * Returning-citizen history for Guide.
 * Lists distinct ISSUES / queries (water logging, Aadhaar, voter ID) — never every chat turn.
 */

import { dbQuery } from '@/lib/db.js'
import { isShortGreeting, looksLikeProblem } from '@/lib/citizenIntakeLadder.js'
import { loadCitizenMemory, type CitizenMemoryProfile } from '../companion/citizenMemory.js'
import { playbookById, type GuideLang } from './playbooks.js'

export interface GuideHistoryItem {
  key: string
  kind: 'ticket' | 'guide' | 'memory'
  id: string
  title: string
  status: string
  status_label: string
  updated_at: string
  area?: string | null
  detail?: string | null
  /** Dedup key: one row per real issue topic. */
  topic_key?: string
}

export interface GuideCaseChoice {
  key: string
  kind: GuideHistoryItem['kind'] | 'action'
  id: string
  title: string
  status: string
  status_label?: string
  updated_at?: string
}

const WANTS_HISTORY =
  /\b(previous|prior|past|my cases?|my tickets?|my quer(y|ies)|list (them|it|down|my)|show (my |the )?(cases?|tickets?|queries)|case status|ticket status|pending|completed|what (did|have) i (ask|raise)|earlier (chat|issue|problem))\b|మునుపటి|మై కేస్|కేసులు|స్టేటస్|పూర్వ|पिछले|मेरे केस|केस लिस्ट|स्थिति|पुरानी/i

/** Chat control / meta lines — never store or list these as “issues”. */
const META_ISSUE =
  /\b(previous|prior|past|list (them|it|down)|show (my |the )?(cases?|tickets?|queries)|my (cases?|tickets?|quer)|case status|ticket status|know the status|previous ticket|previous quer|what did i|continue that|see more|add more|new (chat|problem|issue)|this helped|anything else)\b|__case:|మునుపటి|కేసులు|స్టేటస్|पिछले|केस|स्थिति/i

export function wantsHistoryList(text: string): boolean {
  return WANTS_HISTORY.test(text)
}

export function wantsSeeMore(text: string): boolean {
  return (
    /^(more|see more|show more|add more|next|ఇంకా|మరిన్ని|और दिखाओ|और)$/i.test(text.trim()) ||
    /\b(see more|show more|add more|list more)\b/i.test(text)
  )
}

/** True if this text is not a real civic/service issue (greeting, list-my-cases, thanks, etc.). */
export function isMetaOrNonIssue(text: string | null | undefined): boolean {
  const t = (text ?? '').trim()
  if (!t) return true
  if (t.length < 6) return true
  if (isShortGreeting(t)) return true
  if (/^(thanks|thank you|thx|ok|okay|yes|no|hi+|hello+)\s*[!.]*$/i.test(t)) return true
  if (META_ISSUE.test(t) && !hasConcreteIssueHint(t)) return true
  if (WANTS_HISTORY.test(t) && !hasConcreteIssueHint(t)) return true
  return false
}

function hasConcreteIssueHint(text: string): boolean {
  return /\b(aadhaar|aadhar|pan\b|voter|ration|electric|power|water|logging|drain|sewer|road|pothole|passport|gas|lpg|birth certificate|income certificate|ఆధార్|పాన్|ఓటరు|కరెంట్|నీటి|आधार|पैन|वोटर|बिजली|पानी|नाली)\b/i.test(
    text,
  )
}

/** Stable topic so “voter id” asked 5 times → one list row. */
export function issueTopicKey(problemId: string | null | undefined, title: string): string {
  if (problemId?.trim()) return `pb:${problemId.trim().toLowerCase()}`
  const t = title.toLowerCase()
  if (/aadhaar|aadhar|आधार|ఆధార్/.test(t)) return 'topic:aadhaar'
  if (/\bpan\b|पैन|పాన్/.test(t)) return 'topic:pan'
  if (/voter|form\s*6|मतदाता|ఓటరు|election/.test(t)) return 'topic:voter'
  if (/ration|రేషన్|राशन/.test(t)) return 'topic:ration'
  if (/water|logging|flood|drainage|నీటి|पानी|जलभराव/.test(t)) return 'topic:water'
  if (/electric|power|outage|current|కరెంట్|बिजली|TSSPDCL|TGNPDCL/i.test(t)) return 'topic:power'
  if (/drain|sewer|మురుగు|नाली|सीवर/.test(t)) return 'topic:drain'
  if (/road|pothole|రోడ్|सड़क|गड्ढ/.test(t)) return 'topic:road'
  if (/passport|पासपोर्ट|పాస్‌పోర్ట్/.test(t)) return 'topic:passport'
  const cleaned = t
    .replace(/[^a-z0-9\u0c00-\u0c7f\u0900-\u097f\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 48)
  return `raw:${cleaned}`
}

/** Human title for an issue — prefer playbook name over raw chat paste. */
export function issueDisplayTitle(
  problemId: string | null | undefined,
  rawSummary: string | null | undefined,
  lang: GuideLang,
  area?: string | null,
): string | null {
  if (problemId) {
    const pb = playbookById(problemId)
    if (pb) {
      const base = pb.titles[lang] || pb.titles.en
      return area ? `${base} — ${area.slice(0, 40)}` : base
    }
  }
  const raw = (rawSummary ?? '').trim()
  if (!raw || isMetaOrNonIssue(raw)) return null
  if (!looksLikeProblem(raw) && !hasConcreteIssueHint(raw)) return null
  // Shorten chatty sentences to a tight issue label
  let title = raw
    .replace(/^(ok+|okay|so+|um+|please|can you|i (want|need|have) (a |to |one )?)/i, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (title.length > 72) title = `${title.slice(0, 69)}…`
  if (area && !title.toLowerCase().includes(area.toLowerCase().slice(0, 12))) {
    title = `${title} — ${area.slice(0, 36)}`
  }
  return title || null
}

export function parseCaseSelection(
  text: string,
  choices: GuideCaseChoice[],
): GuideCaseChoice | null {
  const raw = text.trim()
  const token = raw.match(/^__case:(ticket|guide|memory):(.+)$/i)
  if (token) {
    const kind = token[1]!.toLowerCase() as GuideHistoryItem['kind']
    const id = token[2]!.trim()
    return (
      choices.find((c) => c.kind === kind && c.id === id) ?? {
        key: 'sel',
        kind,
        id,
        title: id.slice(0, 40),
        status: 'open',
      }
    )
  }
  if (/^[1-9]$/.test(raw)) {
    const hit = choices.find((c) => c.key === raw && c.kind !== 'action')
    if (hit) return hit
  }
  const lower = raw.toLowerCase()
  return (
    choices.find(
      (c) =>
        c.kind !== 'action' &&
        (c.id.toLowerCase() === lower ||
          c.title.toLowerCase() === lower ||
          (c.title.length > 8 && lower.includes(c.title.toLowerCase().slice(0, 24)))),
    ) ?? null
  )
}

export async function listCitizenHistory(args: {
  orgId: string
  citizenId: string
  sessionId: string
  lang: GuideLang
  limit: number
  offset: number
}): Promise<{ items: GuideHistoryItem[]; total: number }> {
  const tickets = await dbQuery<{
    id: string
    ticket_number: string
    title: string
    stage: string
    location_text: string | null
    updated_at: string
  }>(
    `SELECT id, ticket_number, title, stage, location_text, updated_at::text AS updated_at
     FROM tickets
     WHERE organization_id = $1 AND citizen_id = $2
     ORDER BY updated_at DESC
     LIMIT 40`,
    [args.orgId, args.citizenId],
  )

  const guides = await dbQuery<{
    id: string
    problem_id: string | null
    status: string
    contact_json: unknown
    updated_at: string
  }>(
    `SELECT id, problem_id, status, contact_json, updated_at::text AS updated_at
     FROM guide_sessions
     WHERE organization_id = $1 AND citizen_id = $2 AND id <> $3
       AND (
         problem_id IS NOT NULL
         OR coalesce(contact_json->>'problem_summary', '') <> ''
       )
     ORDER BY updated_at DESC
     LIMIT 40`,
    [args.orgId, args.citizenId, args.sessionId],
  )

  const mem = await loadCitizenMemory(args.orgId, args.citizenId)
  const byTopic = new Map<string, GuideHistoryItem>()

  const upsert = (item: GuideHistoryItem) => {
    const key = item.topic_key || issueTopicKey(null, item.title)
    const existing = byTopic.get(key)
    // Prefer ticket > guide > memory; within same kind keep newest
    const rank = (k: string) => (k === 'ticket' ? 3 : k === 'guide' ? 2 : 1)
    if (!existing) {
      byTopic.set(key, { ...item, topic_key: key })
      return
    }
    if (rank(item.kind) > rank(existing.kind)) {
      byTopic.set(key, { ...item, topic_key: key })
      return
    }
    if (rank(item.kind) === rank(existing.kind) && item.updated_at > existing.updated_at) {
      byTopic.set(key, { ...item, topic_key: key })
    }
  }

  for (const t of tickets.rows) {
    const titleBase = (t.title || t.ticket_number || '').trim()
    if (!titleBase || isMetaOrNonIssue(titleBase)) continue
    const title = t.location_text
      ? `${t.ticket_number}: ${titleBase.slice(0, 50)} — ${t.location_text.slice(0, 30)}`
      : `${t.ticket_number}: ${titleBase.slice(0, 70)}`
    upsert({
      key: '',
      kind: 'ticket',
      id: t.id,
      title,
      status: t.stage,
      status_label: statusLabel(t.stage, args.lang),
      updated_at: t.updated_at.slice(0, 10),
      area: t.location_text,
      topic_key: issueTopicKey(null, titleBase),
    })
  }

  for (const g of guides.rows) {
    const c =
      g.contact_json && typeof g.contact_json === 'object'
        ? (g.contact_json as Record<string, unknown>)
        : {}
    const rawSummary = typeof c.problem_summary === 'string' ? c.problem_summary : null
    const area = typeof c.place === 'string' ? c.place : null
    // Skip chats that only captured meta requests
    if (!g.problem_id && isMetaOrNonIssue(rawSummary)) continue
    const title = issueDisplayTitle(g.problem_id, rawSummary, args.lang, area)
    if (!title) continue
    upsert({
      key: '',
      kind: 'guide',
      id: g.id,
      title,
      status: g.status,
      status_label: statusLabel(g.status, args.lang),
      updated_at: g.updated_at.slice(0, 10),
      area,
      topic_key: issueTopicKey(g.problem_id, title),
    })
  }

  if (mem?.profile) {
    mergeMemoryProblems(byTopic, mem.profile, args.lang)
  }

  const items = [...byTopic.values()].sort((a, b) =>
    a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0,
  )

  const total = items.length
  const slice = items.slice(args.offset, args.offset + args.limit).map((item, i) => ({
    ...item,
    key: String(args.offset + i + 1),
  }))
  return { items: slice, total }
}

function mergeMemoryProblems(
  byTopic: Map<string, GuideHistoryItem>,
  profile: CitizenMemoryProfile,
  lang: GuideLang,
): void {
  for (const p of profile.problems) {
    if (isMetaOrNonIssue(p.summary)) continue
    const title = issueDisplayTitle(p.problem_id, p.summary, lang, p.area)
    if (!title) continue
    const key = issueTopicKey(p.problem_id, title)
    if (byTopic.has(key)) continue
    byTopic.set(key, {
      key: '',
      kind: 'memory',
      id: p.problem_id || `mem:${key}`,
      title,
      status: p.status,
      status_label: statusLabel(p.status, lang),
      updated_at: (p.last_at || '').slice(0, 10),
      area: p.area ?? null,
      topic_key: key,
    })
  }
}

function statusLabel(status: string, lang: GuideLang): string {
  const s = status.toLowerCase()
  const pending = /open|to_do|in_progress|raised|pending|triage|assigned/.test(s)
  const done = /closed|satisfied|resolved|cancelled|canceled|completed/.test(s)
  if (lang === 'te') {
    if (done) return 'పూర్తి'
    if (pending) return 'పెండింగ్'
    return status
  }
  if (lang === 'hi') {
    if (done) return 'पूर्ण'
    if (pending) return 'लंबित'
    return status
  }
  if (done) return 'completed'
  if (pending) return 'open / pending'
  return status
}

export function formatHistoryReply(args: {
  lang: GuideLang
  name: string
  items: GuideHistoryItem[]
  total: number
  offset: number
}): { text: string; choices: GuideCaseChoice[] } {
  const { lang, name, items, total, offset } = args
  const choices: GuideCaseChoice[] = items.map((item) => ({
    key: item.key,
    kind: item.kind,
    id: item.id,
    title: item.title,
    status: item.status,
    status_label: item.status_label,
    updated_at: item.updated_at,
  }))

  if (!items.length) {
    const empty =
      lang === 'te'
        ? `సరే${name ? `, ${name}` : ''}. ఇంకా సేవ్ అయిన సమస్యలు లేవు. కొత్త సమస్య చెప్పండి.`
        : lang === 'hi'
          ? `ठीक है${name ? `, ${name}` : ''}। अभी कोई सेव्ड समस्या नहीं। नई समस्या बताइए।`
          : `Okay${name ? `, ${name}` : ''}. No saved issues yet. Tell me the new problem.`
    return { text: empty, choices: [] }
  }

  const lines = items.map(
    (item) =>
      `${item.key}. ${item.title} — ${item.status_label}${item.updated_at ? ` · ${item.updated_at}` : ''}`,
  )
  const hasMore = offset + items.length < total
  if (hasMore) {
    choices.push({
      key: 'more',
      kind: 'action',
      id: 'see_more',
      title: lang === 'te' ? 'ఇంకా చూపించు' : lang === 'hi' ? 'और दिखाएँ' : 'See more',
      status: 'action',
    })
  }
  choices.push({
    key: 'new',
    kind: 'action',
    id: 'new_issue',
    title: lang === 'te' ? 'కొత్త సమస్య' : lang === 'hi' ? 'नई समस्या' : 'New problem',
    status: 'action',
  })

  const intro =
    lang === 'te'
      ? `మళ్లీ స్వాగతం${name ? `, ${name}` : ''}. మీ సమస్యలు / క్వెరీలు (టాప్ ${items.length}${total > items.length ? ` / ${total}` : ''}):\n${lines.join('\n')}\n\nకొనసాగించాలంటే నంబర్ చెప్పండి లేదా బటన్ నొక్కండి.${hasMore ? ' ఇంకా ఉంటే “See more”.' : ''}`
      : lang === 'hi'
        ? `फिर से स्वागत है${name ? `, ${name}` : ''}। आपकी समस्याएँ / क्वेरी (टॉप ${items.length}${total > items.length ? ` / ${total}` : ''}):\n${lines.join('\n')}\n\nजारी रखने के लिए नंबर या बटन.${hasMore ? ' और हैं तो “See more”.' : ''}`
        : `Welcome back${name ? `, ${name}` : ''}. Your issues / queries (top ${items.length}${total > items.length ? ` of ${total}` : ''}):\n${lines.join('\n')}\n\nReply with a number or tap one to continue that issue.${hasMore ? ' Tap “See more” for older ones.' : ''}`

  return { text: intro, choices }
}

export async function loadFocusedCaseDetail(args: {
  orgId: string
  citizenId: string
  choice: GuideCaseChoice
  lang: GuideLang
}): Promise<{ summary: string; title: string; status: string }> {
  if (args.choice.kind === 'ticket') {
    const res = await dbQuery<{
      ticket_number: string
      title: string
      stage: string
      original_issue_text: string | null
      location_text: string | null
      updated_at: string
    }>(
      `SELECT ticket_number, title, stage, original_issue_text, location_text, updated_at::text AS updated_at
       FROM tickets
       WHERE id = $1 AND organization_id = $2 AND citizen_id = $3
       LIMIT 1`,
      [args.choice.id, args.orgId, args.citizenId],
    )
    const t = res.rows[0]
    if (!t) {
      return {
        title: args.choice.title,
        status: args.choice.status,
        summary:
          args.lang === 'te'
            ? 'ఆ సమస్య దొరకలేదు. మరోది ఎంచుకోండి.'
            : args.lang === 'hi'
              ? 'वह समस्या नहीं मिली। कोई और चुनें।'
              : 'That issue was not found. Pick another.',
      }
    }
    const label = statusLabel(t.stage, args.lang)
    const body =
      args.lang === 'te'
        ? `మీరు ఎంచుకున్న సమస్య: ${t.ticket_number} — ${t.title}. స్టేటస్: ${label}.${t.location_text ? ` ప్రాంతం: ${t.location_text}.` : ''} ${t.original_issue_text ? `సారాంశం: ${t.original_issue_text.slice(0, 180)}.` : ''} ఈ సమస్య గురించి ఏమి కావాలి?`
        : args.lang === 'hi'
          ? `आपने चुनी समस्या: ${t.ticket_number} — ${t.title}. स्थिति: ${label}.${t.location_text ? ` जगह: ${t.location_text}.` : ''} ${t.original_issue_text ? `सार: ${t.original_issue_text.slice(0, 180)}.` : ''} इस समस्या पर क्या चाहिए?`
          : `Focused on issue ${t.ticket_number}: ${t.title}. Status: ${label}.${t.location_text ? ` Area: ${t.location_text}.` : ''} ${t.original_issue_text ? `Summary: ${t.original_issue_text.slice(0, 180)}.` : ''} What do you need on this issue?`
    return { title: `${t.ticket_number}: ${t.title}`, status: t.stage, summary: body }
  }

  if (args.choice.kind === 'guide') {
    const res = await dbQuery<{
      problem_id: string | null
      status: string
      contact_json: unknown
      updated_at: string
    }>(
      `SELECT problem_id, status, contact_json, updated_at::text AS updated_at
       FROM guide_sessions WHERE id = $1 AND organization_id = $2 LIMIT 1`,
      [args.choice.id, args.orgId],
    )
    const g = res.rows[0]
    const c =
      g?.contact_json && typeof g.contact_json === 'object'
        ? (g.contact_json as Record<string, unknown>)
        : {}
    const area = typeof c.place === 'string' ? c.place : null
    const raw = typeof c.problem_summary === 'string' ? c.problem_summary : null
    const title =
      issueDisplayTitle(g?.problem_id, raw, args.lang, area) || args.choice.title
    const label = statusLabel(g?.status ?? 'open', args.lang)
    const body =
      args.lang === 'te'
        ? `సమస్య: "${title}". స్టేటస్: ${label}. ఇదే గురించి కొనసాగిద్దాం — ఏమి అడగాలి?`
        : args.lang === 'hi'
          ? `समस्या: "${title}"। स्थिति: ${label}। इसी पर जारी — क्या पूछना है?`
          : `Issue: "${title}". Status: ${label}. Continuing on this — what do you need?`
    return { title: String(title).slice(0, 120), status: g?.status ?? 'open', summary: body }
  }

  const title = args.choice.title
  const body =
    args.lang === 'te'
      ? `సమస్య: "${title}". ఇది గురించి కొనసాగిద్దాం — ఏమి కావాలి?`
      : args.lang === 'hi'
        ? `समस्या: "${title}"। इसी पर चलते हैं — क्या चाहिए?`
        : `Issue: "${title}". Let’s continue on this — what do you need?`
  return { title, status: args.choice.status, summary: body }
}
