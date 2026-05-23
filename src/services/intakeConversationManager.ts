/**
 * Intake Conversation Manager
 * ===========================
 *
 * Replaces the rigid Telegram state machine in `services/telegramFlow.ts`
 * with a Gemini-driven, multilingual, scope-aware conversation manager.
 *
 * On each inbound citizen message, calls the LLM with:
 *   - the tenant's civic-scope policy (from TENANT_CONFIG)
 *   - the language guidance (always reply in the citizen's language/script)
 *   - the conversation history so far
 *   - any preprocessed multimodal content (transcribed voice / image
 *     description) — future, not in this initial version
 *   - the new inbound message
 *
 * Returns a structured response telling the caller:
 *   - what language the citizen used
 *   - what intent the message had (civic / out of scope / status check)
 *   - what new facts to merge into the draft ticket
 *   - what's still missing
 *   - whether we're ready to file the ticket
 *   - the reply text to send back (in the citizen's language)
 *
 * This service is intentionally pure — no DB writes. The caller decides
 * what to persist. Makes it cheap to test in the admin lab without
 * polluting the channel_conversations / tickets tables.
 *
 * Fail-soft: if OpenRouter is down or returns garbage, we return an
 * `unclear` intent with a fallback reply so the citizen still gets
 * SOMETHING. The caller can decide whether to retry or fall back to the
 * old state machine.
 */

import { tenantApp, tenantParty, tenantGeography, tenantLanguage, tenantCivicScope } from '@/config/tenant.config.js'

const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1'
const OPENROUTER_API_KEY  = process.env.OPENROUTER_API_KEY ?? ''
const RAW_OPENROUTER_MODEL = process.env.OPENROUTER_MODEL ?? 'google/gemini-2.5-flash'
/** Invalid preview slug returns OpenRouter 400 — normalize so WhatsApp/Telegram intake does not loop. */
const OPENROUTER_MODEL =
  RAW_OPENROUTER_MODEL.includes('flash-preview') || RAW_OPENROUTER_MODEL.includes('gemini-2.5-flash-preview')
    ? 'google/gemini-2.5-flash'
    : RAW_OPENROUTER_MODEL

// ── Types ────────────────────────────────────────────────────────────────────

/** Where the message came from in the conversation history. */
export type Role = 'user' | 'assistant'

export interface ConversationTurn {
  role: Role
  content: string
}

/** Multimodal content already preprocessed into text. */
export interface PreprocessedMedia {
  /** Transcription of a voice note (in the source language). */
  voice_transcript?: string
  /** What's in the image (English description + any extracted text). */
  image_description?: string
  /** Image URL if the model is going to look at it directly (Phase 2). */
  image_url?: string
}

export interface IntakeRequest {
  /** Prior turns in this conversation, oldest first. */
  history: ConversationTurn[]
  /** The brand-new message from the citizen. */
  newMessage: {
    text?: string | null
    media?: PreprocessedMedia
  }
  /** Any draft facts already collected. The LLM can augment but not contradict. */
  existingDraft?: Record<string, unknown>
}

export interface IntakeResponse {
  /**
   * Detected language of the citizen's most recent message. Free-form
   * BCP-47-ish tag — common values: 'te', 'hi', 'en', 'ta', 'mr', 'kn',
   * 'ur', plus mixed/romanised tags like 'te-en' (Tinglish), 'hi-en'
   * (Hinglish), 'te-Latn' (Telugu in roman script). The bot replies in
   * this same language and script.
   */
  language: string
  /** What kind of message this is. */
  intent: 'civic_issue' | 'out_of_scope' | 'status_check' | 'small_talk' | 'unclear'
  /**
   * Tri-state scope assessment — empathy-first, generous about taking
   * borderline cases. The caller decides what to do with each:
   *   • in_scope       → proceed normally; file the ticket once info is sufficient
   *   • needs_review   → file the ticket but flag for human review. Bot tells the
   *                      citizen we're looking into it and will update them.
   *   • out_of_scope   → no ticket. Bot empathetically declines and may suggest
   *                      external resources (women helpline, NALSA legal aid, etc.)
   * Default to needs_review when uncertain rather than denying upfront.
   */
  scopeAssessment: 'in_scope' | 'needs_review' | 'out_of_scope'
  /** Plain-English explanation of the scope decision (for admin diagnostics). */
  scopeReason?: string
  /** New facts to merge into the draft. Caller decides how to persist. */
  draftUpdates: {
    issue_text?: string         // normalized English summary
    issue_text_native?: string  // citizen's own words preserved
    category?: string            // best-guess civic category
    location_text?: string       // free-text location (mandal/ward/landmark)
    severity_hint?: 'critical' | 'high' | 'medium' | 'low'
    timing?: string              // when it happened (e.g. "since 3 days")
    affected?: string            // who/what is affected
    wants_contact?: boolean      // does the citizen want a callback?
  }
  /** Fields the LLM still wants — human-readable list. */
  needsMoreInfo: string[]
  /**
   * True when the LLM thinks we have enough to act on this message.
   *   • in_scope     → readyToFile = true means file a regular ticket
   *   • needs_review → readyToFile = true means file a needs-review ticket
   *   • out_of_scope → readyToFile is always false (no ticket)
   */
  readyToFile: boolean
  /** What to actually say back to the citizen (in their language). */
  replyText: string
  /**
   * DEPRECATED — derived from scopeAssessment. Kept for backward
   * compatibility with the lab UI's first version. Will be removed
   * once all consumers migrate to `scopeAssessment`.
   */
  outOfScope: boolean
  /** DEPRECATED — use `scopeReason`. */
  outOfScopeReason?: string
  /** Raw LLM response metadata, useful for the admin lab UI. */
  _meta?: {
    model: string
    fallback: boolean
    error?: string
    raw_response?: string
  }
}

// ── System prompt ────────────────────────────────────────────────────────────

function buildSystemPrompt(): string {
  const included = tenantCivicScope.included.map(s => `  • ${s}`).join('\n')
  const excluded = tenantCivicScope.excluded.map(s => `  • ${s}`).join('\n')

  return `You are the intake assistant for ${tenantApp.name}, a civic grievance platform operated by ${tenantParty.name} in ${tenantGeography.rootName}, India.

PERSONA — READ THIS CAREFULLY
You are a caring friend and community helper. Not a customer-service bot, not a form. You stand in solidarity with the citizen who has come to you. They are often frustrated, scared, tired, or angry — meet them with warmth and patience first, always.

Before deciding what to do with their issue, acknowledge what they're feeling. Mirror their concern. Then, gently, help them. Never lecture. Never moralise. Never refuse abruptly.

LANGUAGES — RESPOND IN WHATEVER THEY USE
Citizens may write in ANY language — pure Telugu (తెలుగు), pure Hindi (हिन्दी), pure Tamil, Kannada, Marathi, Urdu, English, or any code-mixed combination such as Tinglish (Telugu in roman script mixed with English), Hinglish, Tamlish, etc.

DETECT the citizen's language and script on every turn, and ALWAYS reply in the same language and same script they used most recently. If they wrote in Telugu script, reply in Telugu script. If they wrote in roman-script Telugu (Tinglish), reply in Tinglish. If they switched from Hindi to English mid-conversation, switch with them. NEVER translate their words back to them in a different language.

When in doubt about which language to reply in, mirror the LAST message they sent. Their previous turns are context; only the most recent message determines your reply language.

SCOPE — TRI-STATE, EMPATHY FIRST
For every conversation, decide ONE of these three states:

  • in_scope        — clearly a civic, governance, or public-service grievance involving
                      a government body, public service, public official, or public space.
                      → Proceed to collect enough detail to file the ticket.

  • needs_review    — the matter has a possible civic angle but is ambiguous, or it
                      sits on the boundary of personal/civic. EXAMPLES that should
                      default to needs_review (NOT to out_of_scope):
                        - "Family land dispute" → could involve illegal encroachment
                          or land-record manipulation. Look into it.
                        - "Husband is beating me" → women's safety, police inaction
                          if FIR refused. Take it seriously.
                        - "Bank refused to refund my fraud money" → cyber-fraud
                          and bank-regulator angle. Take it.
                        - "My boss isn't paying my wages" → labour rights, possibly
                          ESI/PF, possibly police. Take it.
                        - "My neighbour blocked the street" → encroachment, civic.
                      → Acknowledge with empathy. Tell the citizen we'll look into
                         their situation and update them. Collect basic facts.
                         File the ticket flagged as needs_review.

  • out_of_scope    — clearly a private matter with NO civic angle at all and NO
                      involvement of any government body, official, or public service.
                      EXAMPLES:
                        - "My boyfriend cheated on me" → no civic angle
                        - "I want to start a business" → not a grievance
                        - "Recommend me a good doctor" → information request, not grievance
                      → Empathetically acknowledge the citizen's situation.
                         Briefly explain we focus on civic/governance grievances.
                         Where appropriate, suggest a relevant helpline:
                           - Women's helpline: 181
                           - Child helpline: 1098
                           - NALSA legal aid: 15100
                           - Mental health (iCall): 9152987821
                         No ticket is filed. Do NOT lecture.

DEFAULT TO needs_review WHEN UNCERTAIN. Err on the side of taking the case in.
The ground team can always close it later. We never want to turn away a citizen who needed our help.

DECLARED CIVIC SCOPE (for reference — the team primarily works on these)
${included}

DECLARED OUT-OF-SCOPE EXAMPLES (for reference — purely private matters)
${excluded}

These lists are GUIDANCE, not handcuffs. Use judgment. A matter listed as "excluded" may still warrant needs_review if there's a credible civic angle hidden inside it.

CONVERSATION STYLE
  - Warm, human, conversational. Never corporate, never bureaucratic.
  - Acknowledge feelings first. "I understand", "That sounds frustrating", "I'm sorry you're going through this."
  - Ask ONE focused question at a time. Never a checklist.
  - Never re-ask for something the citizen has already told you.
  - If their FIRST message already has issue + location + when, confirm understanding warmly and move toward filing.
  - Use brief, accessible language. Avoid government jargon and English bureaucratese in non-English replies.
  - Citizens are on WhatsApp/mobile — keep replyText short (2–4 sentences). No numbered menus like "reply 1 or 2" unless they asked what they can do.
  - For greetings ("hi", "hello", "what can you do?") — respond naturally and explain you help report civic problems to their leader; invite them to describe their issue. Do NOT reply with only a rigid menu.
  - Stay on topic: civic grievances, public services, and authority accountability. For unrelated chit-chat, gently redirect.
  - STATUS CHECKS: If intent is status_check, NEVER ask the citizen to type or find their ticket number.
    The app shows their tickets automatically. replyText should be one short line only (e.g. "Let me check that for you.")
    or empty string "".

WHAT TO COLLECT BEFORE readyToFile = true
  1. A clear description of the issue
  2. Location — mandal, ward, village, panchayat, or a clear landmark. REQUIRED for in_scope.
     For needs_review, location is helpful but not required to file.
  3. When it happened or has been happening (best-effort)
  4. Severity hints — urgent? safety risk? many affected? (best-effort)
  5. Whether the citizen wants a callback or to stay anonymous (best-effort)

CATEGORY HINTS (use ONE of these if applicable; otherwise omit)
  drainage, roads, waterlogging, garbage, streetlights, water_supply, tanker_water,
  electricity, traffic, public_transport, autos, land_records, land_grabbing,
  hydraa_demolition, illegal_construction, housing_scheme, ration_card, pension,
  police_inaction, women_safety, cybercrime, stray_dogs, pollution, lake_pollution,
  tgpsc_jobs, unemployment, accountability, corruption, labour_rights, consumer_fraud, other

OUTPUT FORMAT — CRITICAL
Respond with a SINGLE valid JSON object in this exact shape. No markdown fences. No prose outside the JSON.

{
  "language": "<BCP-47-ish tag — 'te' | 'hi' | 'en' | 'ta' | 'mr' | 'kn' | 'ur' | 'te-en' | 'hi-en' | etc. Match the citizen's last message exactly.>",
  "intent": "civic_issue" | "out_of_scope" | "status_check" | "small_talk" | "unclear",
  "scopeAssessment": "in_scope" | "needs_review" | "out_of_scope",
  "scopeReason": "<short English explanation of the scope decision — for admin only, never shown to citizen>",
  "draftUpdates": {
    "issue_text": "<one-sentence English summary OR omit>",
    "issue_text_native": "<citizen's own words, lightly cleaned OR omit>",
    "category": "<one of the categories above OR omit>",
    "location_text": "<location as the citizen described it OR omit>",
    "severity_hint": "critical" | "high" | "medium" | "low" (omit if unsure),
    "timing": "<when, e.g. '3 days ago' OR omit>",
    "affected": "<who/what is affected OR omit>",
    "wants_contact": true | false (omit if unsure)
  },
  "needsMoreInfo": ["<short field labels — empty array when nothing more is needed>"],
  "readyToFile": <boolean — see rules above>,
  "replyText": "<what to actually say to the citizen, in their language and script. 1-3 sentences. Warm, empathetic, focused. NEVER include English explanations or stage directions in a non-English reply.>"
}

The replyText is the ONLY thing the citizen sees. Make every word count. Sound like a friend.`
}

// ── LLM call ─────────────────────────────────────────────────────────────────

interface OpenRouterChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

async function callOpenRouter(messages: OpenRouterChatMessage[]): Promise<{ content: string; error?: string }> {
  if (!OPENROUTER_API_KEY) {
    return { content: '', error: 'OPENROUTER_API_KEY not configured' }
  }
  try {
    const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'X-Title': `${tenantApp.name} Intake`,
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        messages,
        temperature: 0.5,
        max_tokens: 800,
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(20_000),
    })
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      return { content: '', error: `OpenRouter ${response.status}: ${body.slice(0, 400)}` }
    }
    const json = await response.json() as { choices?: Array<{ message?: { content?: string } }> }
    const content = json.choices?.[0]?.message?.content ?? ''
    return { content }
  } catch (err) {
    return { content: '', error: err instanceof Error ? err.message : String(err) }
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function processInbound(req: IntakeRequest): Promise<IntakeResponse> {
  // Build the user-facing prompt — wrap the new message with any media context.
  const parts: string[] = []
  if (req.newMessage.text) {
    parts.push(req.newMessage.text)
  }
  if (req.newMessage.media?.voice_transcript) {
    parts.push(`[Voice note transcript]: ${req.newMessage.media.voice_transcript}`)
  }
  if (req.newMessage.media?.image_description) {
    parts.push(`[Image content]: ${req.newMessage.media.image_description}`)
  }
  const userContent = parts.join('\n\n') || '[Empty message]'

  const messages: OpenRouterChatMessage[] = [
    { role: 'system', content: buildSystemPrompt() },
    ...req.history.map(t => ({
      role: t.role === 'assistant' ? ('assistant' as const) : ('user' as const),
      content: t.content,
    })),
    { role: 'user', content: userContent },
  ]

  if (req.existingDraft && Object.keys(req.existingDraft).length > 0) {
    messages.push({
      role: 'system',
      content: `Already-collected facts about this issue (do not re-ask for these): ${JSON.stringify(req.existingDraft)}`,
    })
  }

  const { content, error } = await callOpenRouter(messages)

  // ── Fallback path: LLM unavailable or failed ──────────────────────────────
  if (error || !content) {
    return {
      language: 'unknown',
      intent: 'unclear',
      scopeAssessment: 'needs_review',
      draftUpdates: {},
      needsMoreInfo: [],
      readyToFile: false,
      replyText:
        'క్షమించండి, ఇప్పుడు మా సిస్టమ్‌లో సమస్య ఉంది / Sorry, our system is having trouble right now. Please try again in a few minutes.',
      outOfScope: false,
      _meta: { model: OPENROUTER_MODEL, fallback: true, error },
    }
  }

  // ── Parse JSON ─────────────────────────────────────────────────────────────
  // Tolerate occasional ```json fences even though we asked for raw JSON.
  const cleaned = content.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()

  let parsed: any
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    // Final desperate fallback — extract the first {...} block.
    const match = cleaned.match(/\{[\s\S]*\}/)
    if (match) {
      try { parsed = JSON.parse(match[0]) } catch { parsed = null }
    }
  }

  if (!parsed || typeof parsed !== 'object') {
    return {
      language: 'unknown',
      intent: 'unclear',
      scopeAssessment: 'needs_review',
      draftUpdates: {},
      needsMoreInfo: [],
      readyToFile: false,
      replyText: 'Could not understand the response. Please try again.',
      outOfScope: false,
      _meta: {
        model: OPENROUTER_MODEL,
        fallback: true,
        error: 'JSON parse failed',
        raw_response: content,
      },
    }
  }

  // ── Validate + normalize ──────────────────────────────────────────────────
  const scopeAssessment = normaliseScope(parsed.scopeAssessment, parsed.outOfScope)
  const result: IntakeResponse = {
    language: normaliseLanguage(parsed.language),
    intent: normaliseIntent(parsed.intent),
    scopeAssessment,
    scopeReason: typeof parsed.scopeReason === 'string'
      ? parsed.scopeReason
      : (typeof parsed.outOfScopeReason === 'string' ? parsed.outOfScopeReason : undefined),
    draftUpdates: parsed.draftUpdates ?? {},
    needsMoreInfo: Array.isArray(parsed.needsMoreInfo) ? parsed.needsMoreInfo : [],
    readyToFile: Boolean(parsed.readyToFile),
    replyText: typeof parsed.replyText === 'string' ? parsed.replyText : '',
    // Backward-compat alias — derive from the canonical tri-state.
    outOfScope: scopeAssessment === 'out_of_scope',
    outOfScopeReason: scopeAssessment === 'out_of_scope'
      ? (typeof parsed.scopeReason === 'string' ? parsed.scopeReason : parsed.outOfScopeReason)
      : undefined,
    _meta: { model: OPENROUTER_MODEL, fallback: false },
  }
  // Belt-and-braces: if scope is out_of_scope but no reply was generated,
  // fall back to the configured polite decline in a reasonable language.
  if (result.scopeAssessment === 'out_of_scope' && !result.replyText) {
    result.replyText = result.language.startsWith('te')
      ? tenantCivicScope.politeDecline.te
      : tenantCivicScope.politeDecline.en
  }
  // Safety net: never set readyToFile=true for out_of_scope.
  if (result.scopeAssessment === 'out_of_scope') result.readyToFile = false
  return result
}

/**
 * Accept any BCP-47-ish tag. We trust the LLM here — citizens use many
 * languages and we don't want a hardcoded allowlist forcing 'unknown'
 * every time someone writes in Marathi or Urdu.
 */
function normaliseLanguage(v: unknown): string {
  if (typeof v === 'string' && v.length > 0 && v.length < 32) {
    return v.toLowerCase().replace(/[^a-z\-]/g, '') || 'unknown'
  }
  return 'unknown'
}
function normaliseIntent(v: unknown): IntakeResponse['intent'] {
  const allowed: IntakeResponse['intent'][] = ['civic_issue', 'out_of_scope', 'status_check', 'small_talk', 'unclear']
  return (allowed as string[]).includes(v as string) ? (v as IntakeResponse['intent']) : 'unclear'
}
function normaliseScope(
  scope: unknown,
  legacyOutOfScope: unknown,
): IntakeResponse['scopeAssessment'] {
  if (scope === 'in_scope' || scope === 'needs_review' || scope === 'out_of_scope') return scope
  // If the model only set the legacy outOfScope boolean, treat true as
  // out_of_scope and false as needs_review (default to the safer middle).
  if (legacyOutOfScope === true)  return 'out_of_scope'
  if (legacyOutOfScope === false) return 'needs_review'
  return 'needs_review'
}

// Re-exported for tests + the admin lab.
export const _internals = { buildSystemPrompt }
// Silence unused-import warning when language config isn't directly referenced.
void tenantLanguage
