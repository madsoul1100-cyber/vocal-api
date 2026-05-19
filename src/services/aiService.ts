/**
 * AI Enrichment Service — powered by OpenRouter
 *
 * Used to:
 * - Summarize raw citizen complaint text
 * - Suggest category, severity, department, location
 * - Transcribe voice notes (separate — not yet wired)
 *
 * All outputs are stored as draft suggestions in ai_ticket_suggestions.
 * Central support must confirm before values are applied to the ticket.
 */

import { tenantApp } from '@/config/tenant.config.js'

const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1'
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? ''
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL ?? 'google/gemini-2.5-flash-preview'

const ISSUE_CATEGORIES = [
  'Governance and Administration',
  'Land, Revenue, and Documentation',
  'Police, Law, and Safety',
  'Women, Child, and Vulnerable Group Safety',
  'Municipal and Civic Services',
  'Public Infrastructure',
  'Health and Medical Access',
  'Education and Youth',
  'Employment and Livelihood',
  'Agriculture and Farmer Distress',
  'Welfare, Benefits, and Entitlements',
  'Corruption and Bribery',
  'Community Conflict and Social Harm',
  'Environment and Public Nuisance',
  'Other / Uncategorized',
]

export interface AiSuggestionResult {
  suggested_title: string | null
  suggested_summary: string | null
  suggested_category: string | null
  suggested_severity: 'critical' | 'high' | 'medium' | 'low' | null
  suggested_department: string | null
  suggested_location_text: string | null
  confidence_json: Record<string, number>
  raw_ai_response: unknown
  error?: string
}

// ============================================================================
// INTENT CLASSIFIER — used by the Telegram conversation flow when the bot is
// in an idle state and needs to understand what the user wants.
// Returns one of a small fixed set of intents. Always ships a rule-based
// fallback so the bot still works when OpenRouter is down.
// ============================================================================

export type TelegramIntent =
  | 'greeting'       // "hi", "hello", "namaste"
  | 'report_issue'   // user wants to file a new issue
  | 'status_check'   // user wants to check a ticket
  | 'info_query'     // asking about what Vocal is / what the bot does
  | 'other'          // small talk, unclear, out of scope

export interface IntentResult {
  intent: TelegramIntent
  ticket_number: string | null
  /** true if we fell back to rules because AI was unavailable / failed */
  rule_based: boolean
}

const GREETING_RE = /^(hi|hii+|hello|hey|namaste|namaskar|hola|yo|good (morning|afternoon|evening)|greetings?)\b/i
const REPORT_RE   = /\b(report|file|raise|log|complain(t)?|issue|problem|grievance)\b/i
const STATUS_RE   = /\b(status|track|update|check|progress)\b/i
const INFO_RE     = /^(what|who|how|why|tell me|explain|about)\b/i

function classifyByRules(text: string): IntentResult {
  const raw = text.trim()
  const lower = raw.toLowerCase()

  // ticket number pattern — strong signal for status check
  const tn = raw.toUpperCase().match(/\b([A-Z]{2,}-[A-Z0-9]+-\d{2,})\b/)

  if (STATUS_RE.test(lower) || tn) {
    return { intent: 'status_check', ticket_number: tn ? tn[1] : null, rule_based: true }
  }
  if (REPORT_RE.test(lower)) {
    return { intent: 'report_issue', ticket_number: null, rule_based: true }
  }
  if (GREETING_RE.test(lower)) {
    return { intent: 'greeting', ticket_number: null, rule_based: true }
  }
  if (INFO_RE.test(lower)) {
    return { intent: 'info_query', ticket_number: null, rule_based: true }
  }
  return { intent: 'other', ticket_number: null, rule_based: true }
}

export async function classifyIntent(text: string): Promise<IntentResult> {
  const trimmed = (text ?? '').trim()
  if (!trimmed) return { intent: 'other', ticket_number: null, rule_based: true }

  // Obvious wins go through rules — cheaper, faster, no AI risk.
  const ruleHit = classifyByRules(trimmed)
  if (ruleHit.intent !== 'other' && ruleHit.intent !== 'info_query') return ruleHit

  if (!OPENROUTER_API_KEY) return ruleHit

  const systemPrompt = `You classify a single incoming message to a civic-issue reporting chatbot.

Return strict JSON only. Schema:
{
  "intent": "greeting" | "report_issue" | "status_check" | "info_query" | "other",
  "ticket_number": string | null
}

Rules:
- "report_issue" if the user is describing a civic problem, complaint, grievance, or asking to report / file something.
- "status_check" if they want the status of an existing ticket, especially if they mention a ticket number.
- "greeting" for plain greetings with no other content.
- "info_query" if they're asking what this service is, what it does, or how it works.
- "other" for everything else (spam, small talk, offensive content, off-topic).
- ticket_number: extract a pattern like VOC-DEMO-0001 if present, else null.
- Do NOT attempt to answer the user. Only classify.`

  try {
    const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://vocal-app.vercel.app',
        'X-Title': `${tenantApp.name} Civic Platform`,
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: trimmed.slice(0, 1000) },
        ],
        temperature: 0,
        max_tokens: 80,
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(5000),
    })

    if (!response.ok) return ruleHit
    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const content = data.choices?.[0]?.message?.content
    if (!content) return ruleHit
    const parsed = JSON.parse(content)
    const intent: TelegramIntent =
      ['greeting', 'report_issue', 'status_check', 'info_query', 'other'].includes(parsed.intent)
        ? parsed.intent
        : 'other'

    return {
      intent,
      ticket_number: typeof parsed.ticket_number === 'string' ? parsed.ticket_number : null,
      rule_based: false,
    }
  } catch {
    return ruleHit
  }
}

export async function generateTicketSuggestions(
  originalText: string,
  transcript?: string,
): Promise<AiSuggestionResult> {
  if (!OPENROUTER_API_KEY) {
    return {
      suggested_title: null,
      suggested_summary: null,
      suggested_category: null,
      suggested_severity: null,
      suggested_department: null,
      suggested_location_text: null,
      confidence_json: {},
      raw_ai_response: null,
      error: 'OPENROUTER_API_KEY not configured',
    }
  }

  const inputText = transcript ?? originalText

  const systemPrompt = `You are an AI assistant helping triage civic issue reports submitted by citizens.
Analyze the citizen's complaint and extract structured information.
Respond ONLY with valid JSON matching the schema below. No markdown, no explanation.

Schema:
{
  "title": "short one-line title (max 10 words)",
  "summary": "2-3 sentence normalized summary of the issue",
  "category": "one of the provided categories",
  "severity": "critical | high | medium | low",
  "department": "most relevant government department or agency",
  "location_text": "location mentioned in the text, or null if none",
  "confidence": {
    "category": 0.0-1.0,
    "severity": 0.0-1.0,
    "location": 0.0-1.0
  }
}

Severity guide:
- critical: imminent violence, self-harm, child safety, medical emergency, sexual assault
- high: serious ongoing harm, urgent public safety, significant rights violation
- medium: important issue requiring prompt attention, service failure
- low: general complaint, routine service request, administrative issue

Categories: ${ISSUE_CATEGORIES.join(', ')}`

  try {
    const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://vocal-app.vercel.app',
        'X-Title': `${tenantApp.name} Civic Platform`,
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Citizen complaint:\n\n${inputText}` },
        ],
        temperature: 0.2,
        max_tokens: 512,
        response_format: { type: 'json_object' },
      }),
    })

    if (!response.ok) {
      const errText = await response.text()
      throw new Error(`OpenRouter API error ${response.status}: ${errText}`)
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const content = data.choices?.[0]?.message?.content

    if (!content) throw new Error('Empty response from AI')

    const parsed = JSON.parse(content)

    return {
      suggested_title: parsed.title ?? null,
      suggested_summary: parsed.summary ?? null,
      suggested_category: parsed.category ?? null,
      suggested_severity: parsed.severity ?? null,
      suggested_department: parsed.department ?? null,
      suggested_location_text: parsed.location_text ?? null,
      confidence_json: parsed.confidence ?? {},
      raw_ai_response: data,
    }
  } catch (err) {
    return {
      suggested_title: null,
      suggested_summary: null,
      suggested_category: null,
      suggested_severity: null,
      suggested_department: null,
      suggested_location_text: null,
      confidence_json: {},
      raw_ai_response: null,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
