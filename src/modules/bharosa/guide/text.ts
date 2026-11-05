/**
 * Small text helpers for Guide replies.
 * Pure functions only, so they are easy to check without a database or an LLM.
 */

const SENTENCE_END = /[.!?।॥]["')\]”’]*$/

/**
 * Cut text to at most `max` characters WITHOUT breaking a word or leaving a
 * half sentence. Prefers the last full sentence; falls back to the last whole word.
 */
export function clipAtSentence(text: string, max: number): string {
  const clean = text.trim()
  if (clean.length <= max) return clean
  const head = clean.slice(0, max)
  // Last sentence terminator inside the window (keep it if it is past the halfway mark).
  const re = /[.!?।॥]["')\]”’]*(?=\s|$)/g
  let cut = -1
  for (let m = re.exec(head); m; m = re.exec(head)) cut = m.index + m[0].length
  if (cut >= max * 0.5) return head.slice(0, cut).trim()
  const lastSpace = head.search(/\s\S*$/)
  const wordSafe = lastSpace > 0 ? head.slice(0, lastSpace) : head
  return `${wordSafe.replace(/[,;:\-–—\s]+$/, '')}…`
}

/**
 * When a model reply was cut by the token limit it usually ends mid-word.
 * Drop the dangling fragment so the citizen never sees "...as t".
 */
export function dropDanglingTail(text: string): string {
  const clean = text.trim()
  if (!clean || SENTENCE_END.test(clean)) return clean
  const re = /[.!?।॥]["')\]”’]*(?=\s|$)/g
  let cut = -1
  for (let m = re.exec(clean); m; m = re.exec(clean)) cut = m.index + m[0].length
  if (cut > 0) return clean.slice(0, cut).trim()
  return clean
}

/**
 * Group long toll-free numbers so they read and speak well:
 * 180042500333 -> 1800 425 00333, 1800-425-0028 -> 1800 425 0028.
 */
export function groupPhoneNumbers(text: string): string {
  return text.replace(/(?<![\d])1800[\s-]?(\d{3})[\s-]?(\d{4,5})(?!\d)/g, '1800 $1 $2')
}
