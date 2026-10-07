import crypto from 'node:crypto'
import { z } from 'zod'
import { dbQuery } from '@/lib/db.js'
import { languageName } from '../common.js'
import { llmJson } from './llm.js'

const PROMPT_VERSION = 'translation.v1'
const MAX_BATCH = 30

function hashText(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex')
}

const TELUGU_RE = /[\u0C00-\u0C7F]/

/** Cheap guess so we don't translate text already in the target script. */
export function looksLike(text: string, lang: string): boolean {
  const hasTelugu = TELUGU_RE.test(text)
  return lang === 'te' ? hasTelugu : !hasTelugu
}

/**
 * Translate a batch of strings, cached by (sha256(text), target). Returns the
 * original text for any item the model could not translate.
 */
export async function translateTexts(args: {
  texts: string[]
  target: string
  orgId?: string | null
  ticketId?: string | null
}): Promise<{ translations: string[]; cached: number; translated: number }> {
  const target = args.target === 'en' ? 'en' : 'te'
  const texts = args.texts.slice(0, MAX_BATCH).map((t) => (typeof t === 'string' ? t : ''))
  const out = [...texts]
  const hashes = texts.map(hashText)

  const pending: number[] = []
  const nonEmpty = texts.map((t, i) => ({ t, i })).filter(({ t }) => t.trim() && !looksLike(t, target))
  if (!nonEmpty.length) return { translations: out, cached: 0, translated: 0 }

  const cachedRes = await dbQuery<{ source_hash: string; translated_text: string }>(
    `SELECT source_hash, translated_text FROM translation_cache WHERE target_language = $1 AND source_hash = ANY($2::text[])`,
    [target, nonEmpty.map(({ i }) => hashes[i])],
  )
  const cache = new Map(cachedRes.rows.map((r) => [r.source_hash, r.translated_text]))
  let cachedCount = 0
  for (const { i } of nonEmpty) {
    const hit = cache.get(hashes[i])
    if (hit) {
      out[i] = hit
      cachedCount++
    } else {
      pending.push(i)
    }
  }
  if (!pending.length) return { translations: out, cached: cachedCount, translated: 0 }

  const schema = z.object({ translations: z.array(z.string()) })
  const result = await llmJson({
    agent: 'translation',
    promptVersion: PROMPT_VERSION,
    orgId: args.orgId ?? null,
    ticketId: args.ticketId ?? null,
    language: target,
    inputRefs: { count: pending.length },
    system: `You translate short civic-grievance texts into ${languageName(target)}.
Preserve meaning exactly. Keep names, place names, ticket numbers, dates, numbers and official titles accurate (transliterate names, do not translate them).
Use simple, everyday language a low-literacy reader understands. Return {"translations": [...]} with exactly one output per input, same order.`,
    user: JSON.stringify({ inputs: pending.map((i) => texts[i]) }),
    schema,
    temperature: 0,
    maxTokens: 3000,
  })

  if (!result.ok || result.data.translations.length !== pending.length) {
    return { translations: out, cached: cachedCount, translated: 0 }
  }

  for (let k = 0; k < pending.length; k++) {
    const i = pending[k]
    const translated = result.data.translations[k]?.trim()
    if (!translated) continue
    out[i] = translated
    await dbQuery(
      `INSERT INTO translation_cache (source_hash, target_language, translated_text, model)
       VALUES ($1,$2,$3,$4) ON CONFLICT (source_hash, target_language) DO NOTHING`,
      [hashes[i], target, translated, result.model],
    )
  }
  return { translations: out, cached: cachedCount, translated: pending.length }
}
