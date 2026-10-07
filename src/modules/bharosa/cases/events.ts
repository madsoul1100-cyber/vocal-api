import { dbQuery } from '@/lib/db.js'

export type Visibility = 'internal' | 'citizen' | 'public'
export type ActorType = 'user' | 'citizen' | 'system' | 'ai_agent' | 'authority' | 'webhook'

export interface CaseEventInput {
  orgId: string
  ticketId: string
  type: string
  actorType: ActorType
  actorUserId?: string | null
  actorCitizenId?: string | null
  actorLabel?: string | null
  visibility?: Visibility
  summary?: string | null
  language?: string
  reason?: string | null
  data?: Record<string, unknown> | null
  taskId?: string | null
  communicationId?: string | null
}

export async function recordCaseEvent(e: CaseEventInput): Promise<string> {
  const res = await dbQuery<{ id: string }>(
    `INSERT INTO case_events (organization_id, ticket_id, task_id, communication_id, event_type, actor_type,
                              actor_user_id, actor_citizen_id, actor_label, visibility, summary, language,
                              reason, data_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
    [
      e.orgId,
      e.ticketId,
      e.taskId ?? null,
      e.communicationId ?? null,
      e.type,
      e.actorType,
      e.actorUserId ?? null,
      e.actorCitizenId ?? null,
      e.actorLabel ?? null,
      e.visibility ?? 'internal',
      e.summary ?? null,
      e.language ?? 'en',
      e.reason ?? null,
      e.data ? JSON.stringify(e.data) : null,
    ],
  )
  return res.rows[0].id
}

export interface CaseEventRow {
  id: string
  event_type: string
  actor_type: ActorType
  actor_label: string | null
  actor_name: string | null
  visibility: Visibility
  summary: string | null
  language: string
  reason: string | null
  data_json: Record<string, unknown> | null
  task_id: string | null
  communication_id: string | null
  created_at: string
}

export async function listCaseEvents(ticketId: string, visibilities: Visibility[]): Promise<CaseEventRow[]> {
  const res = await dbQuery<CaseEventRow>(
    `SELECT e.id, e.event_type, e.actor_type, e.actor_label, u.full_name AS actor_name, e.visibility,
            e.summary, e.language, e.reason, e.data_json, e.task_id, e.communication_id, e.created_at
     FROM case_events e
     LEFT JOIN users u ON u.id = e.actor_user_id
     WHERE e.ticket_id = $1 AND e.visibility = ANY($2::text[])
     ORDER BY e.created_at ASC`,
    [ticketId, visibilities],
  )
  return res.rows
}

// ---------------------------------------------------------------------------
// Citizen-facing lifecycle projection
// Create → In verification → In progress ⇄ On hold → Resolved | Cancelled
// ---------------------------------------------------------------------------

export type CitizenStatus = 'created' | 'in_verification' | 'in_progress' | 'on_hold' | 'resolved' | 'cancelled'

export const CITIZEN_STATUS_ORDER: CitizenStatus[] = ['created', 'in_verification', 'in_progress', 'resolved']

export const CITIZEN_STATUS_LABELS: Record<CitizenStatus, { en: string; te: string }> = {
  created: { en: 'Received', te: 'స్వీకరించబడింది' },
  in_verification: { en: 'Being verified', te: 'ధృవీకరణలో ఉంది' },
  in_progress: { en: 'In progress', te: 'పురోగతిలో ఉంది' },
  on_hold: { en: 'On hold', te: 'నిలిపివేయబడింది' },
  resolved: { en: 'Resolved', te: 'పరిష్కరించబడింది' },
  cancelled: { en: 'Closed without resolution', te: 'పరిష్కారం లేకుండా మూసివేయబడింది' },
}

const RESOLVED_SUB_STATUSES = new Set(['resolved_by_organization', 'resolved_by_external_party', 'closed_with_advice_only'])
const RESOLVED_OUTCOMES = new Set(['resolved_by_org', 'resolved_external', 'closed_with_advice'])

export function projectCitizenStatus(t: {
  stage: string
  sub_status: string
  outcome?: string | null
  verification_status?: string | null
}): CitizenStatus {
  if (t.stage === 'closed') {
    return RESOLVED_SUB_STATUSES.has(t.sub_status) || (t.outcome && RESOLVED_OUTCOMES.has(t.outcome))
      ? 'resolved'
      : 'cancelled'
  }
  if (t.stage === 'on_hold') {
    return t.sub_status === 'pending_closure_approval' ? 'in_progress' : 'on_hold'
  }
  if (t.stage === 'in_progress') return 'in_progress'
  return (t.verification_status ?? 'unverified') === 'unverified' ? 'created' : 'in_verification'
}

/** Short citizen-safe explanation for sub-statuses worth surfacing. Internal ones map to null. */
export const CITIZEN_SUB_STATUS_HINTS: Record<string, { en: string; te: string }> = {
  incomplete_information: { en: 'We need a few more details from you.', te: 'మీ నుండి మరికొన్ని వివరాలు అవసరం.' },
  needs_location_validation: { en: 'We are confirming the location.', te: 'స్థలాన్ని నిర్ధారిస్తున్నాం.' },
  accepted_by_worker: { en: 'A team member has taken up your case.', te: 'ఒక బృంద సభ్యుడు మీ కేసును స్వీకరించారు.' },
  citizen_contacted: { en: 'Our team has contacted you.', te: 'మా బృందం మిమ్మల్ని సంప్రదించింది.' },
  field_verification_in_progress: { en: 'A field visit is in progress.', te: 'క్షేత్ర పరిశీలన జరుగుతోంది.' },
  action_plan_created: { en: 'An action plan has been prepared.', te: 'కార్యాచరణ ప్రణాళిక సిద్ధమైంది.' },
  escalated_to_authority: { en: 'Sent to the responsible authority.', te: 'సంబంధిత అధికారికి పంపబడింది.' },
  waiting_on_external_action: { en: 'Waiting for the authority to act.', te: 'అధికారుల చర్య కోసం వేచి ఉన్నాం.' },
  awaiting_citizen_response: { en: 'Waiting for your reply.', te: 'మీ స్పందన కోసం వేచి ఉన్నాం.' },
  awaiting_documents_evidence: { en: 'Please share the requested documents or photos.', te: 'అడిగిన పత్రాలు లేదా ఫోటోలు పంపండి.' },
  outside_jurisdiction_review: { en: 'We are checking which office is responsible.', te: 'ఏ కార్యాలయం బాధ్యత వహిస్తుందో పరిశీలిస్తున్నాం.' },
  pending_closure_approval: { en: 'Work is complete and under final review.', te: 'పని పూర్తయింది, తుది సమీక్షలో ఉంది.' },
}

export const CITIZEN_EVENT_LABELS: Record<string, { en: string; te: string }> = {
  case_created: { en: 'Your complaint was registered.', te: 'మీ ఫిర్యాదు నమోదైంది.' },
  verification_started: { en: 'We are verifying your complaint. You may receive a call.', te: 'మీ ఫిర్యాదును ధృవీకరిస్తున్నాం. మీకు కాల్ రావచ్చు.' },
  verified: { en: 'Your complaint has been verified.', te: 'మీ ఫిర్యాదు ధృవీకరించబడింది.' },
  authority_email_draft_ready: { en: 'A draft email to the authority is ready for your approval.', te: 'అధికారికి పంపే ఇమెయిల్ ముసాయిదా మీ ఆమోదం కోసం సిద్ధంగా ఉంది.' },
  authority_email_sent: { en: 'Your complaint was emailed to the responsible authority.', te: 'మీ ఫిర్యాదు సంబంధిత అధికారికి ఇమెయిల్ ద్వారా పంపబడింది.' },
  authority_follow_up_sent: { en: 'We followed up with the authority.', te: 'అధికారిని మళ్లీ సంప్రదించాం.' },
  authority_escalation_sent: { en: 'Your complaint was escalated to a senior officer.', te: 'మీ ఫిర్యాదు ఉన్నతాధికారికి పంపబడింది.' },
  authority_replied: { en: 'The authority has responded.', te: 'అధికారులు స్పందించారు.' },
  citizen_response_requested: { en: 'We need a response from you.', te: 'మీ నుండి స్పందన అవసరం.' },
  citizen_responded: { en: 'You replied to our request.', te: 'మీరు మా అభ్యర్థనకు స్పందించారు.' },
  case_reopened: { en: 'Your case was reopened.', te: 'మీ కేసు మళ్లీ తెరవబడింది.' },
  feedback_received: { en: 'Thank you for your feedback.', te: 'మీ అభిప్రాయానికి ధన్యవాదాలు.' },
}

export function citizenSummaryForEvent(e: CaseEventRow, lang: 'en' | 'te'): string | null {
  if (e.summary && e.language === lang) return e.summary
  const label = CITIZEN_EVENT_LABELS[e.event_type]
  if (label) return label[lang]
  if (e.summary) return e.summary
  if (e.event_type === 'status_changed') {
    const d = (e.data_json ?? {}) as Record<string, string | null>
    const hint = d.to_sub_status ? CITIZEN_SUB_STATUS_HINTS[d.to_sub_status] : undefined
    if (hint) return hint[lang]
    const status = projectCitizenStatus({ stage: d.to_stage ?? 'to_do', sub_status: d.to_sub_status ?? '', verification_status: 'in_verification' })
    return CITIZEN_STATUS_LABELS[status][lang]
  }
  return null
}
