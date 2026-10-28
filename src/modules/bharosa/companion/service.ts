import { dbQuery } from '@/lib/db.js'

export async function listOpenCases(orgId: string, limit = 10) {
  const res = await dbQuery<{
    ticket_number: string
    stage: string
    original_issue_text: string | null
    location_text: string | null
    updated_at: string
  }>(
    `SELECT ticket_number, stage, original_issue_text, location_text, updated_at::text AS updated_at
     FROM tickets
     WHERE organization_id = $1
       AND stage IS DISTINCT FROM 'closed'
       AND stage IS DISTINCT FROM 'cancelled'
     ORDER BY updated_at DESC
     LIMIT $2`,
    [orgId, Math.min(Math.max(limit, 1), 25)],
  )
  return res.rows.map((r) => ({
    ticket_number: r.ticket_number,
    stage: r.stage,
    preview: (r.original_issue_text ?? '').replace(/\s+/g, ' ').slice(0, 120),
    location: r.location_text,
    updated_at: r.updated_at.slice(0, 19),
  }))
}

export async function getCase(orgId: string, ticketNumber: string) {
  const res = await dbQuery<{
    ticket_number: string
    stage: string
    sub_status: string | null
    original_issue_text: string | null
    location_text: string | null
    updated_at: string
  }>(
    `SELECT ticket_number, stage, sub_status, original_issue_text, location_text, updated_at::text AS updated_at
     FROM tickets
     WHERE organization_id = $1 AND ticket_number = $2
     LIMIT 1`,
    [orgId, ticketNumber],
  )
  return res.rows[0] ?? null
}

export async function getOpenDraftSummary(orgId: string, phone?: string | null) {
  if (phone) {
    const digits = phone.replace(/\D/g, '').slice(-10)
    const guide = await dbQuery<{
      id: string
      status: string
      problem_id: string | null
      contact_json: unknown
      updated_at: string
    }>(
      `SELECT id, status, problem_id, contact_json, updated_at::text AS updated_at
       FROM guide_sessions
       WHERE organization_id = $1
         AND status = 'open'
         AND contact_json->>'phone' = $2
       ORDER BY updated_at DESC
       LIMIT 5`,
      [orgId, digits],
    )
    return {
      phone: digits,
      guide_open: guide.rows.map((r) => {
        const c = (r.contact_json && typeof r.contact_json === 'object' ? r.contact_json : {}) as Record<
          string,
          unknown
        >
        return {
          session_id: r.id,
          problem_id: r.problem_id,
          name: typeof c.name === 'string' ? c.name : null,
          summary: typeof c.problem_summary === 'string' ? c.problem_summary.slice(0, 120) : null,
          updated_at: r.updated_at.slice(0, 19),
        }
      }),
    }
  }

  const recent = await dbQuery<{ id: string; updated_at: string; contact_json: unknown }>(
    `SELECT id, updated_at::text AS updated_at, contact_json
     FROM guide_sessions
     WHERE organization_id = $1 AND status = 'open'
     ORDER BY updated_at DESC
     LIMIT 5`,
    [orgId],
  )
  return {
    phone: null,
    guide_open: recent.rows.map((r) => {
      const c = (r.contact_json && typeof r.contact_json === 'object' ? r.contact_json : {}) as Record<
        string,
        unknown
      >
      return {
        session_id: r.id,
        name: typeof c.name === 'string' ? c.name : null,
        summary: typeof c.problem_summary === 'string' ? c.problem_summary.slice(0, 120) : null,
        updated_at: r.updated_at.slice(0, 19),
      }
    }),
  }
}

/** Propose nudge copy only — OpenClaw must not send WhatsApp itself. */
export function proposeCitizenNudge(args: {
  language: string
  name?: string | null
  problemPreview?: string | null
}): { text: string; note: string } {
  const name = args.name?.trim() || ''
  const preview = (args.problemPreview ?? 'your earlier request').replace(/\s+/g, ' ').slice(0, 80)
  const lang = args.language.startsWith('te') ? 'te' : args.language.startsWith('hi') ? 'hi' : 'en'

  const text =
    lang === 'te'
      ? `నమస్కారం${name ? ` ${name}` : ''}. "${preview}" గురించి మీ చాట్ అసంపూర్ణంగా ఉంది. కొనసాగించాలంటే ఇక్కడే reply చేయండి.`
      : lang === 'hi'
        ? `नमस्ते${name ? ` ${name}` : ''}। "${preview}" वाली बात अधूरी है। जारी रखने के लिए यहीं जवाब दें।`
        : `Hi${name ? ` ${name}` : ''}. You left an unfinished chat about "${preview}". Reply here if you want to continue.`

  return {
    text,
    note: 'Draft only. Send via vocal-api / Twilio after staff approval — OpenClaw must not message citizens directly.',
  }
}
