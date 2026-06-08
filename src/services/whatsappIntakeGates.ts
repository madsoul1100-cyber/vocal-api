/**
 * WhatsApp intake gates — do not file too early (vague location, no photo ask).
 */

import { intakeCopy, type WhatsAppLang } from './whatsappLocale.js'

export interface IntakeDraftForGates {
  issue_text?: string | null
  issue_text_native?: string | null
  location_text?: string | null
  category?: string | null
  media?: unknown[]
  photo_skipped?: boolean
  photo_requested?: boolean
  location_confirmed?: boolean
}

const VISUAL_ISSUE =
  /\b(road|sadak|sarak|pothole|drainage|nala|garbage|kachra|water|paani|streetlight|footpath|construction|damage|kharab|broken|leak|overflow)\b/i

const ANIMAL_SANITATION_ISSUE =
  /\b(dog|dogs|kutta|kutte|kukka|kukkalu|stray|animal|vaccinat|rabies|bite|pig|pigs|mosquito|dengue|sanitation|cleanliness)\b/i

/** Purely informational — no photo needed. */
const NON_PHOTO_ISSUE =
  /\b(only status|ticket status|what is my ticket|mera ticket|status check)\b/i

const SPECIFIC_LOCATION_MARKERS =
  /\b(\d{6}|pin\s*code|pincode|h\.?\s*no|house|flat|plot|shop|gali|galii|lane|street|road|ward|colony|nagar|mohalla|beside|near|opposite|adjacent|landmark|building|apartment|society|mandal|village|panchayat|door|no\.?\s*\d)\b/i

/** City-only or landmark-only — not enough for ground team. */
export function isVagueLocation(location: string | null | undefined): boolean {
  const t = (location ?? '').trim()
  if (!t) return true
  if (t.length < 10) return true
  if (/\b\d{6}\b/.test(t)) return false
  if (SPECIFIC_LOCATION_MARKERS.test(t)) return false
  const tokens = t.toLowerCase().split(/[\s,]+/).filter(Boolean)
  if (tokens.length <= 2) return true
  if (
    tokens.length <= 3 &&
    /^(hyderabad|secunderabad|kanpur|delhi|mumbai|chennai|bangalore|bengaluru|charminar|lucknow|pune|kolkata)$/.test(
      tokens[0] ?? '',
    )
  ) {
    return true
  }
  return t.length < 28 && !SPECIFIC_LOCATION_MARKERS.test(t)
}

export function issueLikelyNeedsPhoto(issue: string | null | undefined, category?: string | null): boolean {
  const text = issue ?? ''
  if (!text.trim()) return false
  if (NON_PHOTO_ISSUE.test(text)) return false
  if (category && /road|drainage|garbage|water|street|construction|animal|sanitation/i.test(category)) {
    return true
  }
  if (VISUAL_ISSUE.test(text) || ANIMAL_SANITATION_ISSUE.test(text)) return true
  // Most civic complaints benefit from on-ground photo evidence
  return text.trim().length >= 12
}

/** Citizen wants to send or was expecting a photo prompt. */
export function userWantsToSendPhoto(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  if (isPhotoSkipMessage(t)) return false
  return /\b(photo|photos|image|images|picture|pictures|pic|pics|selfie|upload|attachment|attach|foto|tasveer|chitra)\b/i.test(
      t,
    ) ||
    /\b(bhej|bhejna|bhejdo|pamp|pampinch|send).{0,30}(photo|image|pic)/i.test(t) ||
    /\b(want|wanna).{0,20}(upload|send).{0,20}(photo|image|pic)/i.test(t) ||
    /\b(nhi puchi|nahi puchi|didn't ask|did not ask|photo nahi pucha|images nhi|why.*photo)/i.test(t)
}

export function isPhotoSkipMessage(text: string): boolean {
  const t = text.trim().toLowerCase()
  if (/^(skip|pass|none|no|nahi|nahin|ledu|cheyaku)$/.test(t)) return true
  return /\b(no photo|skip photo|photo nahi|photo ledhu|baad mein|later|abhi nahi)\b/i.test(t)
}

export interface IntakeGateResult {
  readyToFile: boolean
  replyOverride?: string
  draftPatch: Partial<IntakeDraftForGates>
}

/** Apply after LLM (or local fallback) — lengthen intake, require pinpoint + photo ask. */
export function applyIntakeGates(args: {
  draft: IntakeDraftForGates
  modelReadyToFile: boolean
  lang: WhatsAppLang
  hasMedia: boolean
  userText: string
}): IntakeGateResult {
  const { draft, modelReadyToFile, lang, hasMedia, userText } = args
  const c = intakeCopy(lang)
  const issue = (draft.issue_text_native ?? draft.issue_text ?? '').trim()
  const location = (draft.location_text ?? '').trim()
  const hasPhoto = hasMedia || (draft.media?.length ?? 0) > 0
  const patch: Partial<IntakeDraftForGates> = {}

  if (isPhotoSkipMessage(userText)) {
    patch.photo_skipped = true
  }

  const merged: IntakeDraftForGates = { ...draft, ...patch }
  const issueEarly = (merged.issue_text_native ?? merged.issue_text ?? '').trim()
  const locationEarly = (merged.location_text ?? '').trim()

  if (
    userWantsToSendPhoto(userText) &&
    !hasPhoto &&
    !merged.photo_skipped &&
    issueEarly &&
    locationEarly &&
    !isVagueLocation(locationEarly)
  ) {
    return {
      readyToFile: false,
      replyOverride: c.askPhotoNow,
      draftPatch: { ...patch, photo_requested: true },
    }
  }

  if (!modelReadyToFile) {
    if (issue && location && isVagueLocation(location)) {
      return {
        readyToFile: false,
        replyOverride: c.askSpecificLocation(location),
        draftPatch: patch,
      }
    }
    if (
      issue &&
      location &&
      !isVagueLocation(location) &&
      issueLikelyNeedsPhoto(issue, merged.category) &&
      !hasPhoto &&
      !merged.photo_skipped
    ) {
      return {
        readyToFile: false,
        replyOverride: merged.photo_requested ? c.askPhotoReminder : c.askPhoto,
        draftPatch: { ...patch, photo_requested: true },
      }
    }
    return { readyToFile: false, draftPatch: patch }
  }

  if (!issue) {
    return { readyToFile: false, replyOverride: c.askIssue, draftPatch: patch }
  }

  if (!location || isVagueLocation(location)) {
    return {
      readyToFile: false,
      replyOverride: c.askSpecificLocation(location || undefined),
      draftPatch: patch,
    }
  }

  const needsPhoto = issueLikelyNeedsPhoto(issue, merged.category)
  if (needsPhoto && !hasPhoto && !merged.photo_skipped) {
    return {
      readyToFile: false,
      replyOverride: merged.photo_requested ? c.askPhotoReminder : c.askPhoto,
      draftPatch: { ...patch, photo_requested: true },
    }
  }

  return {
    readyToFile: false,
    replyOverride: c.confirmSubmit(issue, location),
    draftPatch: { ...patch, location_confirmed: true },
  }
}

/** Citizen said yes — file only when draft passes location + photo rules. */
export function draftReadyForConfirmation(draft: IntakeDraftForGates, hasMedia: boolean): boolean {
  const issue = (draft.issue_text_native ?? draft.issue_text ?? '').trim()
  const location = (draft.location_text ?? '').trim()
  if (!issue || !location || isVagueLocation(location)) return false
  const needsPhoto = issueLikelyNeedsPhoto(issue, draft.category)
  const hasPhoto = hasMedia || (draft.media?.length ?? 0) > 0
  if (needsPhoto && !hasPhoto && !draft.photo_skipped) return false
  return true
}
