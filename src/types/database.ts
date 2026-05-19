// =============================================================================
// Vocal – Database Type Definitions
// Generated from schema: 001_initial_schema.sql
// =============================================================================

export type TicketStage = 'to_do' | 'in_progress' | 'on_hold' | 'closed'

export type TicketSubStatus =
  // To Do
  | 'new_awaiting_triage'
  | 'incomplete_information'
  | 'needs_location_validation'
  | 'ready_for_assignment'
  | 'critical_immediate_attention'
  // In Progress
  | 'assigned_awaiting_acceptance'
  | 'accepted_by_worker'
  | 'citizen_contacted'
  | 'field_verification_in_progress'
  | 'action_plan_created'
  | 'escalated_to_authority'
  | 'escalated_to_internal_leadership'
  | 'escalated_to_media_support'
  | 'support_required_from_specialist'
  | 'waiting_on_external_action'
  // On Hold
  | 'awaiting_citizen_response'
  | 'awaiting_documents_evidence'
  | 'unsafe_to_intervene'
  | 'outside_jurisdiction_review'
  | 'suspected_fake_spam_review'
  | 'reassignment_pending'
  | 'sla_breach_escalation_queue'
  // Closed
  | 'resolved_by_organization'
  | 'resolved_by_external_party'
  | 'unable_to_support'
  | 'duplicate_merged_manually'
  | 'fake_invalid'
  | 'citizen_unresponsive_closed'
  | 'closed_by_central_support'
  | 'closed_with_advice_only'

export type TicketOutcome =
  | 'resolved_by_org'
  | 'resolved_external'
  | 'unable_to_support'
  | 'duplicate_merged'
  | 'fake_invalid'
  | 'citizen_unresponsive'
  | 'closed_by_central'
  | 'closed_with_advice'

export type Severity = 'critical' | 'high' | 'medium' | 'low'

export type RoleName =
  | 'super_admin'
  | 'central_support'
  | 'state_leader'
  | 'district_leader'
  | 'ground_worker'
  | 'media_volunteer'
  | 'legal_support'

export type Channel = 'telegram' | 'whatsapp' | 'web' | 'manual'

export type AssignmentStatus = 'offered' | 'accepted' | 'rejected' | 'expired' | 'force_assigned'

export type RejectionReason =
  | 'too_far'
  | 'irrelevant'
  | 'conflict_of_interest'
  | 'safety_concern'
  | 'outside_jurisdiction'
  | 'fake_spam'

export type NoteType = 'general' | 'worker_update' | 'escalation' | 'system' | 'closure'

export type AmplifyOutputFormat =
  | 'tweet'
  | 'instagram_caption'
  | 'facebook_post'
  | 'whatsapp_broadcast'
  | 'formal_complaint'
  | 'letter_to_authority'
  | 'news_article'
  | 'press_release'
  | 'public_summary'

export type AmplifyTone =
  | 'informative'
  | 'urgent'
  | 'formal'
  | 'empathetic'
  | 'neutral'

// =============================================================================
// Table types
// =============================================================================

export interface Organization {
  id: string
  name: string
  slug: string
  active: boolean
  metadata: Record<string, unknown> | null
  created_at: string
  updated_at: string
}

export interface Role {
  id: string
  name: RoleName
  display_name: string
  description: string | null
  active: boolean
}

export interface User {
  id: string
  clerk_user_id: string | null
  organization_id: string
  full_name: string
  phone: string | null
  email: string | null
  role_id: string
  active: boolean
  approved_by: string | null
  approved_at: string | null
  created_at: string
  updated_at: string
  last_login_at: string | null
  metadata_json: Record<string, unknown> | null
}

export interface UserWithRole extends User {
  roles: Role
}

export interface Territory {
  id: string
  organization_id: string
  name: string
  code: string | null
  level_definition_id: string
  parent_territory_id: string | null
  centroid_lat: number | null
  centroid_lng: number | null
  active: boolean
  metadata_json: Record<string, unknown> | null
  created_at: string
  updated_at: string
}

export interface TerritoryLevelDefinition {
  id: string
  organization_id: string
  level_order: number
  label: string
  active: boolean
  created_at: string
}

export interface Citizen {
  id: string
  organization_id: string
  display_name: string | null
  is_anonymous: boolean
  notes: string | null
  created_at: string
  updated_at: string
}

export interface CitizenChannelIdentity {
  id: string
  citizen_id: string
  channel: 'telegram' | 'whatsapp' | 'web'
  channel_user_id: string
  username: string | null
  phone: string | null
  first_seen_at: string
  last_seen_at: string
}

export interface ChannelConversation {
  id: string
  organization_id: string
  channel: 'telegram' | 'whatsapp' | 'web'
  channel_user_id: string
  citizen_id: string | null
  state: 'intake' | 'follow_up' | 'completed' | 'abandoned'
  current_step: string | null
  ticket_id: string | null
  started_at: string
  last_activity_at: string
  completed_at: string | null
  metadata_json: Record<string, unknown> | null
}

export interface ChannelMessage {
  id: string
  conversation_id: string
  organization_id: string
  channel: string
  channel_message_id: string | null
  direction: 'inbound' | 'outbound'
  message_type: 'text' | 'voice' | 'image' | 'video' | 'document' | 'location' | 'system'
  raw_text: string | null
  raw_payload: Record<string, unknown> | null
  attachment_url: string | null
  attachment_mime: string | null
  latitude: number | null
  longitude: number | null
  processed: boolean
  created_at: string
}

export interface IssueCategory {
  id: string
  organization_id: string | null
  parent_id: string | null
  name: string
  level: number
  active: boolean
  sort_order: number
}

export interface Ticket {
  id: string
  organization_id: string
  ticket_number: string
  source_channel: Channel
  source_conversation_id: string | null
  citizen_id: string | null
  anonymous_flag: boolean
  citizen_identity_revealed_at: string | null
  citizen_identity_revealed_by: string | null

  title: string | null
  original_issue_text: string | null
  normalized_summary: string | null
  location_text: string | null
  latitude: number | null
  longitude: number | null
  map_link: string | null
  address_text: string | null

  category_id: string | null
  subcategory_id: string | null
  severity: Severity | null
  department: string | null
  territory_id: string | null

  stage: TicketStage
  sub_status: TicketSubStatus
  outcome: TicketOutcome | null

  owner_user_id: string | null
  assignment_attempt_count: number

  critical_flag: boolean
  incomplete_information_flag: boolean
  needs_location_validation_flag: boolean
  needs_triage: boolean
  public_use_consent_status: 'unknown' | 'granted' | 'denied'

  next_action_due_at: string | null
  accepted_at: string | null
  first_contacted_at: string | null
  resolution_plan_at: string | null
  closed_at: string | null

  ai_suggestions_confirmed: boolean
  ai_confirmed_by: string | null
  ai_confirmed_at: string | null

  created_at: string
  updated_at: string
  created_by_system: boolean
  last_updated_by_user_id: string | null
}

export interface TicketWithRelations extends Ticket {
  territories: Territory | null
  users: User | null                  // owner
  citizens: Citizen | null
  issue_categories: IssueCategory | null
}

export interface TicketNote {
  id: string
  ticket_id: string
  author_user_id: string | null
  note_type: NoteType
  content: string
  is_internal: boolean
  soft_deleted: boolean
  soft_deleted_by: string | null
  soft_deleted_at: string | null
  created_at: string
}

export interface TicketStageHistory {
  id: string
  ticket_id: string
  from_stage: string | null
  to_stage: string
  from_sub_status: string | null
  to_sub_status: string
  changed_by: string | null
  change_reason: string | null
  system_action: boolean
  created_at: string
}

export interface TicketAssignment {
  id: string
  ticket_id: string
  worker_user_id: string
  assigned_by: string | null
  status: AssignmentStatus
  rejection_reason: RejectionReason | null
  offered_at: string
  responded_at: string | null
  expires_at: string | null
  is_current: boolean
}

export interface TicketAttachment {
  id: string
  ticket_id: string
  message_id: string | null
  file_name: string
  storage_path: string
  mime_type: string | null
  file_size_bytes: number | null
  attachment_type: 'image' | 'video' | 'audio' | 'document' | 'other' | null
  uploaded_by: string | null
  created_at: string
}

export interface AiTicketSuggestion {
  id: string
  ticket_id: string
  job_id: string | null
  model_used: string | null
  suggested_title: string | null
  suggested_summary: string | null
  suggested_category: string | null
  suggested_subcategory: string | null
  suggested_severity: string | null
  suggested_department: string | null
  suggested_location_text: string | null
  suggested_lat: number | null
  suggested_lng: number | null
  transcript: string | null
  confidence_json: Record<string, number> | null
  raw_ai_response: Record<string, unknown> | null
  status: 'pending' | 'processing' | 'completed' | 'failed'
  confirmed: boolean
  confirmed_by: string | null
  confirmed_at: string | null
  created_at: string
}

export interface DirectoryContact {
  id: string
  organization_id: string
  contact_name: string
  organization_name: string | null
  role_designation: string | null
  phone: string | null
  phone_alternate: string | null
  email: string | null
  availability_notes: string | null
  internal_notes: string | null
  verification_status: 'unverified' | 'verified' | 'outdated'
  active: boolean
  created_by: string
  updated_by: string | null
  archived_by: string | null
  archived_at: string | null
  created_at: string
  updated_at: string
}

export interface AuditLog {
  id: string
  organization_id: string | null
  event_type: string
  entity_type: string | null
  entity_id: string | null
  actor_type: 'user' | 'system' | 'webhook'
  actor_user_id: string | null
  source_ip: string | null
  old_value_json: Record<string, unknown> | null
  new_value_json: Record<string, unknown> | null
  metadata_json: Record<string, unknown> | null
  created_at: string
}

// =============================================================================
// Sub-status display labels (for UI rendering)
// =============================================================================

export const SUB_STATUS_LABELS: Record<TicketSubStatus, string> = {
  new_awaiting_triage: 'New – Awaiting Triage',
  incomplete_information: 'Incomplete Information',
  needs_location_validation: 'Needs Location Validation',
  ready_for_assignment: 'Ready for Assignment',
  critical_immediate_attention: 'Critical – Immediate Attention',
  assigned_awaiting_acceptance: 'Assigned – Awaiting Acceptance',
  accepted_by_worker: 'Accepted by Worker',
  citizen_contacted: 'Citizen Contacted',
  field_verification_in_progress: 'Field Verification in Progress',
  action_plan_created: 'Action Plan Created',
  escalated_to_authority: 'Escalated to Authority',
  escalated_to_internal_leadership: 'Escalated to Internal Leadership',
  escalated_to_media_support: 'Escalated to Media Support',
  support_required_from_specialist: 'Support Required from Specialist',
  waiting_on_external_action: 'Waiting on External Action',
  awaiting_citizen_response: 'Awaiting Citizen Response',
  awaiting_documents_evidence: 'Awaiting Documents / Evidence',
  unsafe_to_intervene: 'Unsafe to Intervene',
  outside_jurisdiction_review: 'Outside Jurisdiction Review',
  suspected_fake_spam_review: 'Suspected Fake / Spam Review',
  reassignment_pending: 'Reassignment Pending',
  sla_breach_escalation_queue: 'SLA Breach – Escalation Queue',
  resolved_by_organization: 'Resolved by Organization',
  resolved_by_external_party: 'Resolved by External Party',
  unable_to_support: 'Unable to Support',
  duplicate_merged_manually: 'Duplicate / Merged Manually',
  fake_invalid: 'Fake / Invalid',
  citizen_unresponsive_closed: 'Citizen Unresponsive – Closed',
  closed_by_central_support: 'Closed by Central Support',
  closed_with_advice_only: 'Closed with Advice Only',
}

export const STAGE_LABELS: Record<TicketStage, string> = {
  to_do: 'To Do',
  in_progress: 'In Progress',
  on_hold: 'On Hold',
  closed: 'Closed',
}

export const SEVERITY_LABELS: Record<Severity, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
}
