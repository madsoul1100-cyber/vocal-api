/**
 * Phase 2 — HTTP tools for Hermes or OpenClaw (pick ONE companion).
 * Companion calls these with BHAROSA_MCP_TOKEN; it never owns citizen data.
 *
 * Wire to routes when BHAROSA_COMPANION is hermes|openclaw.
 */

import { z } from 'zod'

export const CompanionAuthSchema = z.object({
  token: z.string().min(8),
  orgId: z.string().uuid(),
  /** Staff user the companion is assisting — never a raw citizen session. */
  staffUserId: z.string().uuid().optional(),
})

export function companionConfigured(): boolean {
  const mode = (process.env.BHAROSA_COMPANION ?? 'off').trim().toLowerCase()
  return mode === 'hermes' || mode === 'openclaw'
}

export function companionTokenOk(token: string | undefined): boolean {
  const expected = process.env.BHAROSA_MCP_TOKEN?.trim()
  if (!expected || !token) return false
  return token === expected
}

/** Tool catalogue the companion should register (MCP or OpenClaw skills). */
export const COMPANION_TOOLS = [
  {
    name: 'list_open_cases',
    description: 'List recent open tickets for an org (staff view). Read-only.',
    input: { orgId: 'uuid', limit: 'number optional' },
  },
  {
    name: 'get_case',
    description: 'Get one ticket by ticket_number or id. Read-only.',
    input: { orgId: 'uuid', ticketNumber: 'string' },
  },
  {
    name: 'get_open_draft_summary',
    description: 'Summarize unfinished guide/WhatsApp drafts for a phone if known. Read-only.',
    input: { orgId: 'uuid', phone: 'string optional' },
  },
  {
    name: 'propose_citizen_nudge',
    description:
      'Propose WhatsApp nudge text for an unfinished draft. Does NOT send — vocal-api approval/Twilio sends.',
    input: { orgId: 'uuid', conversationId: 'string', language: 'te|en|hi' },
  },
  {
    name: 'get_citizen_memory',
    description:
      'Read persistent Guide memory for a logged-in citizen (past problems, areas, behavior). Read-only.',
    input: { orgId: 'uuid', citizenId: 'uuid' },
  },
] as const
