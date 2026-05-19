/**
 * Amplify generation service.
 *
 * Given an amplify_session (which has source selections already attached),
 * produce draft public-facing content in a target format + tone. Persists
 * each draft as an amplify_generated_outputs row and returns the generated
 * content to the caller.
 *
 * Fail-soft: if OpenRouter is unavailable or misconfigured, we fall back
 * to a deterministic template-only draft so the UI still has something to
 * show. The fallback is clearly marked in metadata_json.
 */

import { tenantApp } from '@/config/tenant.config.js'

const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1'
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? ''
// Default to a current GA model. `google/gemini-2.5-flash-preview` 404s on
// OpenRouter now that preview aliases were retired — override via
// OPENROUTER_MODEL env if you want a specific model.
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL ?? 'google/gemini-2.5-flash'

export type AmplifyPlatform =
  | 'tweet'                  // X/Twitter — single tweet or short thread
  | 'instagram_caption'      // IG caption w/ hashtags
  | 'facebook_post'          // FB post — slightly longer, narrative tone
  | 'whatsapp_broadcast'     // WhatsApp broadcast text, plain, forwardable
  | 'news_article'           // Press-style news article pitch
  | 'letter_to_authority'    // Formal letter to concerned authority
  | 'press_release'          // PR-style release

export type AmplifyTone =
  | 'informative'     // calm, factual explainer
  | 'urgent'          // time-pressured call for response
  | 'formal'          // official correspondence voice
  | 'empathetic'      // human-interest, citizen-first framing
  | 'neutral'         // reportage voice, no colour
  // --- Campaign / escalation tones ------------------------------------
  // Used when central support wants to create visibility pressure.
  // Still bound by "no unverified accusations, name only what's in the
  // source, qualify opinion with phrases like 'appears to', 'raises the
  // question', etc." — the system prompt enforces this.
  | 'activist'        // sharp civic-campaign voice, moral urgency,
                      //   names institutional failure, strong CTA
  | 'opposition'      // political-accountability frame, asks
                      //   pointed questions of the ruling authority
  | 'public_shame'    // viral-ready "why is this still happening"
                      //   voice, designed to surface on feeds

export interface PlatformMeta {
  key: AmplifyPlatform
  label: string
  short_hint: string
  char_hint?: number
}

export const PLATFORMS: PlatformMeta[] = [
  { key: 'tweet',              label: 'Twitter / X',         short_hint: 'Single post, 280 chars, 2–3 hashtags.', char_hint: 280 },
  { key: 'instagram_caption',  label: 'Instagram',           short_hint: 'Caption with line breaks, emoji, hashtags at the end.' },
  { key: 'facebook_post',      label: 'Facebook',            short_hint: 'Short narrative post, 2–4 paragraphs, clear call to action.' },
  { key: 'whatsapp_broadcast', label: 'WhatsApp Broadcast',  short_hint: 'Plain text, forward-friendly. No markdown, use *bold* sparingly.' },
  { key: 'news_article',       label: 'News Article Pitch',  short_hint: 'Headline + 4–6 para body, inverted pyramid.' },
  { key: 'letter_to_authority',label: 'Letter to Authority', short_hint: 'Formal letter to named official. Subject, salutation, body, sign-off.' },
  { key: 'press_release',      label: 'Press Release',       short_hint: 'FOR IMMEDIATE RELEASE header, dateline, body, boilerplate.' },
]

// Voice shaping for the campaign/escalation tones. These bias the writer
// toward post-ready, visibility-maximising output while keeping the
// organization legally safe: no unverified accusations, qualify opinion
// with "appears to", "raises the question", etc.
function toneGuidance(tone: AmplifyTone): string {
  switch (tone) {
    case 'activist':
      return (
        'Voice: sharp, civic-campaign. Foreground the human impact and the ' +
        'institutional failure implied by the source. Use moral urgency ' +
        '("this is unacceptable", "citizens deserve better"). End with a ' +
        'clear, specific CTA ("tag @[ministry], share, demand an answer"). ' +
        'You MAY use strong language, but never assert a specific person is ' +
        'corrupt/criminal/lying unless the source explicitly proves it. ' +
        'Prefer "appears to", "has failed to", "raises the question of".'
      )
    case 'opposition':
      return (
        'Voice: political-accountability. Frame the issue as a question the ' +
        'ruling authority (state or central government, as appropriate to ' +
        'the source) owes citizens an answer for. Use rhetorical questions ' +
        '("Why is this still the case after X years?", "Where are the funds ' +
        'allocated under Y scheme?"). Tag with placeholders like [@CMO] ' +
        '[@Minister] [@DeptHandle] so the operator can fill in handles ' +
        'before posting. Never name a politician as guilty of a crime ' +
        'unless the source explicitly says so. Pointed but litigation-safe.'
      )
    case 'public_shame':
      return (
        'Voice: viral-ready civic callout designed for the algorithm. Lead ' +
        'with a single punchy hook line (a shocking fact or stat from the ' +
        'source). Use short, scannable lines. Name the district / ward / ' +
        'official title (not personal name unless in source) responsible. ' +
        'End with a "how many more?" or "tag someone who can fix this" ' +
        'CTA. Strong emotional register but facts-only; qualify opinion.'
      )
    case 'urgent':
      return 'Voice: time-pressured. Lead with a deadline or the consequence of delay. Action-oriented verbs.'
    case 'formal':
      return 'Voice: official correspondence. Neutral register, full sentences, no contractions or emoji.'
    case 'empathetic':
      return 'Voice: human-first. Centre the lived experience of the citizen. Warm but precise.'
    case 'neutral':
      return 'Voice: reportage. State what the source contains without commentary. No emotive language.'
    case 'informative':
    default:
      return 'Voice: calm explainer. Clear, factual, accessible language. Brief context for readers who don\'t know the issue.'
  }
}

// True for tones where the operator is campaigning / applying pressure.
// These unlock stronger hooks, @-mention placeholders, hashtag stacks.
function isCampaignTone(tone: AmplifyTone): boolean {
  return tone === 'activist' || tone === 'opposition' || tone === 'public_shame'
}

function systemPromptFor(platform: AmplifyPlatform, tone: AmplifyTone): string {
  const campaign = isCampaignTone(tone)

  // Base rules — these never bend.
  const base =
    `You are a civic-communications writer drafting post-ready content for a legitimate ` +
    `citizen-grievance organisation in India. Your output will be published as-is after a quick ` +
    `human review, so it must be immediately usable — no placeholder like "[insert detail]" unless ` +
    `the template specifically calls for one, no meta-commentary, no "here is your draft" preamble, ` +
    `no markdown code fences, no word "Disclaimer". Output plain text only.\n\n` +
    `Legal safety (non-negotiable):\n` +
    `  • Never assert a specific person is guilty of a crime, corruption, or dishonesty unless the ` +
    `source material explicitly establishes it.\n` +
    `  • Qualify inference with "appears to", "raises the question", "has so far failed to", etc.\n` +
    `  • Only use facts present in the source. Never invent statistics, dates, names, or quotes.\n` +
    `  • If the source is thin, lean on the impact on citizens rather than manufacturing detail.\n` +
    `  • For @-mentions, use placeholder handles in square brackets ([@CMO], [@DeptHandle]) — the ` +
    `    operator will replace these. Never guess real handles.\n`

  const toneLine = toneGuidance(tone)

  // Platform-specific structural rules.
  switch (platform) {
    case 'tweet':
      return (
        `${base}\n${toneLine}\n\n` +
        `PLATFORM: Twitter / X. Write ONE post, strictly ≤ 280 characters including hashtags and ` +
        `mention placeholders. Structure:\n` +
        `  1. Hook line (≤ 80 chars) that would make someone stop scrolling.\n` +
        `  2. One fact from the source (location + the problem).\n` +
        `  3. ${campaign ? 'A pointed ask / tag: "Tag [@Handle] and demand a response."' : 'A short call to read or share.'}\n` +
        `  4. 2–3 relevant hashtags at the end. For Indian civic issues, prefer #CitizensDemand, ` +
        `#FixIt[CityName], #[IssueType] style. Don't invent hashtags that look like they target a ` +
        `specific person unless the source names them.\n` +
        `Do NOT include a URL.`
      )

    case 'instagram_caption':
      return (
        `${base}\n${toneLine}\n\n` +
        `PLATFORM: Instagram caption. Structure:\n` +
        `  1. Hook line — one punchy opener with an emoji (🚨 / ⚠️ / 🗣️ depending on tone).\n` +
        `  2. 2–4 short paragraphs (1–2 sentences each), separated by blank lines. Name the place, ` +
        `    the problem, the human impact.\n` +
        `  3. Explicit CTA line: ${campaign ? '"Share this. Tag [@Handle]. Demand action."' : '"Share to amplify."'}\n` +
        `  4. Block of 8–12 hashtags at the very end, no inline hashtags.\n` +
        `Emojis allowed (max 4 total). Written for a reader scanning on a phone.`
      )

    case 'facebook_post':
      return (
        `${base}\n${toneLine}\n\n` +
        `PLATFORM: Facebook post. Structure:\n` +
        `  1. First line is a complete, shareable sentence — it's the preview on feeds.\n` +
        `  2. 3–5 short paragraphs. Set the scene, state the problem, name the impact on real ` +
        `    people. If campaign tone, end the body with a question aimed at the authority ` +
        `    ("[@Office], when will this be resolved?").\n` +
        `  3. Closing CTA on its own line: ${campaign ? '"Share if you\'ve had enough. Tag someone who can fix this."' : '"Share to help surface this."'}\n` +
        `No hashtags unless campaign tone, in which case 2–4 at the very end.`
      )

    case 'whatsapp_broadcast':
      return (
        `${base}\n${toneLine}\n\n` +
        `PLATFORM: WhatsApp broadcast. Structure:\n` +
        `  1. Opening line wrapped in *asterisks* — bold summary, one line.\n` +
        `  2. 2–4 short paragraphs. Forward-friendly (no fancy formatting, no emojis beyond one ` +
        `    flag/alert icon if tone allows).\n` +
        `  3. Close with the specific ask: ${campaign ? '"*Forward this to 5 people in your area. Demand action.*"' : '"Forward to anyone who can escalate this."'}\n` +
        `No hashtags. Use *bold* sparingly (headline + ask only).`
      )

    case 'news_article':
      return (
        `${base}\n${toneLine}\n\n` +
        `PLATFORM: news-desk pitch in inverted-pyramid style. Structure:\n` +
        `  HEADLINE: (one punchy line, ≤ 12 words)\n` +
        `  LEDE: (one 25-word sentence covering who/what/where/when.)\n` +
        `  BODY: 4–6 short paragraphs. First gives the core facts; next gives context and scale; ` +
        `  next names the responsible body/official-title; next gives citizen impact. Use a quote ` +
        `  placeholder "[Quote from affected resident — to be filled]" only if the source doesn't ` +
        `  already have one.\n` +
        `  END: one-line "The [authority] has not yet responded to requests for comment." line if ` +
        `  the source doesn't already establish a response.`
      )

    case 'letter_to_authority':
      return (
        `${base}\n${toneLine}\n\n` +
        `PLATFORM: formal letter to concerned authority. Structure exactly:\n` +
        `  [Date]\n\n  To,\n  [Authority Name & Designation]\n  [Department / Office]\n\n` +
        `  Subject: <one clear subject line naming the issue and location>\n\n` +
        `  Dear Sir / Madam,\n\n` +
        `  Paragraph 1 (2–3 sentences): state the grievance and where it is occurring.\n` +
        `  Paragraph 2: factual detail from the source — what has happened, since when, who is ` +
        `  affected.\n` +
        `  Paragraph 3: prior steps taken (if any), and why escalation to this authority is required.\n` +
        `  Paragraph 4: specific, numbered asks of the authority (1. inspect, 2. act, 3. respond by ` +
        `  [reasonable date]).\n` +
        `  Closing: "We request your prompt intervention in the public interest."\n\n` +
        `  Sincerely,\n  [Name]\n  [Organisation]\n  [Contact]\n` +
        `Formal English. No emojis, no contractions.`
      )

    case 'press_release':
      return (
        `${base}\n${toneLine}\n\n` +
        `PLATFORM: press release. Structure exactly:\n` +
        `  FOR IMMEDIATE RELEASE\n\n  [City, Date] —\n\n` +
        `  LEAD PARAGRAPH: one strong 30–40-word paragraph naming the issue, where, and why it ` +
        `  matters now.\n` +
        `  BODY: 3–4 short paragraphs with the source facts, scale/impact, and the responsible ` +
        `  authority (by office title, not personal name unless in source).\n` +
        `  QUOTE: one quote attributed to "[Spokesperson, ${tenantApp.name}]" — one sentence, ${campaign ? 'sharp but litigation-safe' : 'measured'}.\n` +
        `  BOILERPLATE: one-line "About ${tenantApp.name}" paragraph at the end.\n` +
        `  CONTACT: "Media contact: [name] · [email] · [phone]" line.`
      )
  }
}

export interface GenerateArgs {
  platform: AmplifyPlatform
  tone: AmplifyTone
  sources: Array<{ label: string; content: string }>
  extraContext?: string
}

export interface GenerateResult {
  content: string
  fallback: boolean
  model: string
  error?: string
}

export async function generateAmplifyContent(args: GenerateArgs): Promise<GenerateResult> {
  const sourceBlock = args.sources
    .filter(s => s.content?.trim())
    .map(s => `### ${s.label}\n${s.content.trim()}`)
    .join('\n\n') || '(no sources selected — write from context only)'

  const userPrompt = `Source material for the grievance:\n\n${sourceBlock}${
    args.extraContext ? `\n\nAdditional context: ${args.extraContext}` : ''
  }\n\nDraft the requested content now.`

  if (!OPENROUTER_API_KEY) {
    return {
      content: fallbackDraft(args, sourceBlock),
      fallback: true,
      model: 'fallback-template',
      error: 'OPENROUTER_API_KEY not configured',
    }
  }

  try {
    const res = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://vocal-app.vercel.app',
        'X-Title': `${tenantApp.name} Amplify`,
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        messages: [
          { role: 'system', content: systemPromptFor(args.platform, args.tone) },
          { role: 'user',   content: userPrompt },
        ],
        temperature: 0.6,
        max_tokens: 900,
      }),
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`OpenRouter ${res.status}: ${body.slice(0, 300)}`)
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const content = (data.choices?.[0]?.message?.content ?? '').trim()
    if (!content) throw new Error('Empty AI response')
    return { content, fallback: false, model: OPENROUTER_MODEL }
  } catch (err) {
    return {
      content: fallbackDraft(args, sourceBlock),
      fallback: true,
      model: 'fallback-template',
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

function fallbackDraft(args: GenerateArgs, sources: string): string {
  const tag = `[Auto-generated fallback — AI unavailable. Please edit before publishing.]`
  const summary = sources.slice(0, 500)
  switch (args.platform) {
    case 'tweet':
      return `${tag}\n\nCitizens are raising a serious concern that needs urgent attention. Read below and share.\n#Accountability #MyLeader`
    case 'instagram_caption':
    case 'facebook_post':
      return `${tag}\n\nA citizen has reported an issue requiring attention:\n\n${summary}\n\nWe've filed this and are tracking progress. Please share to amplify.`
    case 'whatsapp_broadcast':
      return `${tag}\n\n*Citizen grievance filed*\n\n${summary}\n\nForward to anyone who can help escalate.`
    case 'news_article':
      return `${tag}\n\nHEADLINE: Citizen grievance awaits action\n\nLEDE: A citizen has filed a grievance requiring official attention. Details below.\n\n${summary}`
    case 'letter_to_authority':
      return `${tag}\n\n[Date]\n\nTo,\n[Authority Name & Designation]\n\nSubject: Citizen grievance requiring immediate action\n\nDear Sir/Madam,\n\n${summary}\n\nWe request your prompt intervention.\n\nSincerely,\n[Name & Contact]`
    case 'press_release':
      return `${tag}\n\nFOR IMMEDIATE RELEASE\n\n[City, Date] — ${tenantApp.name} has today surfaced a citizen grievance requiring official attention.\n\n${summary}`
  }
}
