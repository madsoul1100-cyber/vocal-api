-- =============================================================================
-- Vocal - Initial Schema Migration
-- Version: 001
-- Scope: Prototype → V1 foundation
-- =============================================================================

-- Enable required extensions
create extension if not exists "uuid-ossp";
create extension if not exists "pg_trgm"; -- for fast text search

-- =============================================================================
-- 1. ORGANIZATION AND CONFIGURATION
-- =============================================================================

create table organizations (
  id          uuid primary key default uuid_generate_v4(),
  name        text not null,
  slug        text not null unique,
  active      boolean not null default true,
  metadata    jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table organization_settings (
  id                       uuid primary key default uuid_generate_v4(),
  organization_id          uuid not null references organizations(id) on delete cascade,
  acceptance_sla_minutes   int not null default 15,
  first_contact_sla_hours  int not null default 1,
  resolution_plan_sla_hours int not null default 24,
  max_assignment_attempts  int not null default 3,
  telegram_bot_username    text,
  settings_json            jsonb,
  updated_at               timestamptz not null default now(),
  unique(organization_id)
);

-- =============================================================================
-- 2. TERRITORY MODEL (configurable hierarchy, not hardcoded)
-- =============================================================================

create table territory_level_definitions (
  id              uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references organizations(id) on delete cascade,
  level_order     int not null,   -- 1 = top (e.g. Country), higher = deeper
  label           text not null,  -- e.g. "State", "District", "Ward"
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  unique(organization_id, level_order)
);

create table territories (
  id                   uuid primary key default uuid_generate_v4(),
  organization_id      uuid not null references organizations(id) on delete cascade,
  name                 text not null,
  code                 text,
  level_definition_id  uuid not null references territory_level_definitions(id),
  parent_territory_id  uuid references territories(id),
  centroid_lat         double precision,
  centroid_lng         double precision,
  active               boolean not null default true,
  metadata_json        jsonb,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index territories_org_idx on territories(organization_id);
create index territories_parent_idx on territories(parent_territory_id);

-- =============================================================================
-- 3. USERS, ROLES, AND ACCESS
-- =============================================================================

-- Role definitions (seeded below)
create table roles (
  id          uuid primary key default uuid_generate_v4(),
  name        text not null unique,  -- 'super_admin', 'central_support', 'state_leader', 'district_leader', 'ground_worker'
  display_name text not null,
  description text,
  active      boolean not null default true
);

-- Internal user profiles (mapped from Clerk user IDs)
create table users (
  id              uuid primary key default uuid_generate_v4(),
  clerk_user_id   text unique,           -- Clerk's user ID
  organization_id uuid not null references organizations(id),
  full_name       text not null,
  phone           text,
  email           text,
  role_id         uuid not null references roles(id),
  active          boolean not null default false, -- requires activation by central support
  approved_by     uuid references users(id),
  approved_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  last_login_at   timestamptz,
  metadata_json   jsonb
);

create index users_org_idx on users(organization_id);
create index users_clerk_idx on users(clerk_user_id);
create index users_role_idx on users(role_id);

-- User territory assignments (many users can cover many territories)
create table user_territories (
  id           uuid primary key default uuid_generate_v4(),
  user_id      uuid not null references users(id) on delete cascade,
  territory_id uuid not null references territories(id) on delete cascade,
  is_primary   boolean not null default false,
  created_at   timestamptz not null default now(),
  unique(user_id, territory_id)
);

-- Worker activation requests (submitted by location leaders, approved by central support)
create table worker_activation_requests (
  id              uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references organizations(id),
  requested_by    uuid not null references users(id),    -- location leader
  full_name       text not null,
  phone           text not null,
  email           text,
  territory_id    uuid references territories(id),
  status          text not null default 'pending'
                  check(status in ('pending','approved','rejected')),
  reviewed_by     uuid references users(id),
  review_note     text,
  reviewed_at     timestamptz,
  created_at      timestamptz not null default now()
);

-- =============================================================================
-- 4. CITIZENS AND CHANNEL IDENTITY
-- =============================================================================

create table citizens (
  id              uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references organizations(id),
  display_name    text,              -- how they want to be called
  is_anonymous    boolean not null default false,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Maps chat channel identity to citizen profile
create table citizen_channel_identities (
  id              uuid primary key default uuid_generate_v4(),
  citizen_id      uuid not null references citizens(id) on delete cascade,
  channel         text not null check(channel in ('telegram','whatsapp','web')),
  channel_user_id text not null,      -- e.g. Telegram user ID
  username        text,               -- e.g. @handle
  phone           text,
  first_seen_at   timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  unique(channel, channel_user_id)
);

create index citizen_channel_idx on citizen_channel_identities(channel, channel_user_id);

-- =============================================================================
-- 5. CHANNEL INTAKE (raw ingestion layer)
-- =============================================================================

-- One conversation = one active issue thread per citizen
create table channel_conversations (
  id                  uuid primary key default uuid_generate_v4(),
  organization_id     uuid not null references organizations(id),
  channel             text not null check(channel in ('telegram','whatsapp','web')),
  channel_user_id     text not null,
  citizen_id          uuid references citizens(id),
  state               text not null default 'intake'
                      check(state in ('intake','follow_up','completed','abandoned')),
  current_step        text,           -- which follow-up question we're on
  ticket_id           uuid,           -- set once ticket is created
  started_at          timestamptz not null default now(),
  last_activity_at    timestamptz not null default now(),
  completed_at        timestamptz,
  metadata_json       jsonb
);

create index conv_channel_user_idx on channel_conversations(channel, channel_user_id);
create index conv_org_idx on channel_conversations(organization_id);

-- Raw messages from any channel
create table channel_messages (
  id                  uuid primary key default uuid_generate_v4(),
  conversation_id     uuid not null references channel_conversations(id),
  organization_id     uuid not null references organizations(id),
  channel             text not null,
  channel_message_id  text,           -- original message ID from channel
  direction           text not null check(direction in ('inbound','outbound')),
  message_type        text not null check(message_type in ('text','voice','image','video','document','location','system')),
  raw_text            text,
  raw_payload         jsonb,          -- full original payload stored
  attachment_url      text,           -- storage path if attachment
  attachment_mime     text,
  latitude            double precision,
  longitude           double precision,
  processed           boolean not null default false,
  created_at          timestamptz not null default now()
);

create index msg_conv_idx on channel_messages(conversation_id);
create index msg_org_idx on channel_messages(organization_id, created_at desc);

-- =============================================================================
-- 6. ISSUE CATEGORIES (hierarchical taxonomy)
-- =============================================================================

create table issue_categories (
  id              uuid primary key default uuid_generate_v4(),
  organization_id uuid references organizations(id), -- null = global default
  parent_id       uuid references issue_categories(id),
  name            text not null,
  level           int not null default 1,
  active          boolean not null default true,
  sort_order      int not null default 0
);

-- =============================================================================
-- 7. TICKETS (core entity)
-- =============================================================================

create table tickets (
  id                          uuid primary key default uuid_generate_v4(),
  organization_id             uuid not null references organizations(id),
  ticket_number               text not null,          -- human-readable, e.g. VCL-2024-00001
  source_channel              text not null check(source_channel in ('telegram','whatsapp','web','manual')),
  source_conversation_id      uuid references channel_conversations(id),
  citizen_id                  uuid references citizens(id),
  anonymous_flag              boolean not null default false,
  citizen_identity_revealed_at timestamptz,
  citizen_identity_revealed_by uuid references users(id),

  -- Content
  title                       text,
  original_issue_text         text,       -- raw citizen message(s)
  normalized_summary          text,       -- human-edited or AI-normalized
  location_text               text,       -- raw location from citizen
  latitude                    double precision,
  longitude                   double precision,
  map_link                    text,
  address_text                text,

  -- Classification (confirmed values, set by central support)
  category_id                 uuid references issue_categories(id),
  subcategory_id              uuid references issue_categories(id),
  severity                    text check(severity in ('critical','high','medium','low')),
  department                  text,
  territory_id                uuid references territories(id),

  -- Stage model
  stage                       text not null default 'to_do'
                              check(stage in ('to_do','in_progress','on_hold','closed')),
  sub_status                  text not null default 'new_awaiting_triage',
  outcome                     text check(outcome in (
                                'resolved_by_org','resolved_external','unable_to_support',
                                'duplicate_merged','fake_invalid','citizen_unresponsive',
                                'closed_by_central','closed_with_advice'
                              )),

  -- Assignment
  owner_user_id               uuid references users(id),
  assignment_attempt_count    int not null default 0,

  -- Flags
  critical_flag               boolean not null default false,
  incomplete_information_flag boolean not null default false,
  needs_location_validation_flag boolean not null default false,
  needs_triage                boolean not null default true,
  public_use_consent_status   text default 'unknown'
                              check(public_use_consent_status in ('unknown','granted','denied')),

  -- SLA timestamps
  next_action_due_at          timestamptz,
  accepted_at                 timestamptz,
  first_contacted_at          timestamptz,
  resolution_plan_at          timestamptz,
  closed_at                   timestamptz,

  -- AI confirmation
  ai_suggestions_confirmed    boolean not null default false,
  ai_confirmed_by             uuid references users(id),
  ai_confirmed_at             timestamptz,

  -- Audit
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  created_by_system           boolean not null default true,
  last_updated_by_user_id     uuid references users(id)
);

create index tickets_org_idx on tickets(organization_id);
create index tickets_org_stage_idx on tickets(organization_id, stage);
create index tickets_owner_idx on tickets(owner_user_id);
create index tickets_territory_idx on tickets(territory_id);
create index tickets_created_idx on tickets(created_at desc);
create index tickets_triage_idx on tickets(organization_id, needs_triage) where needs_triage = true;

-- Auto-increment ticket number per org
create sequence ticket_number_seq start 1;

create or replace function generate_ticket_number(org_slug text)
returns text language plpgsql as $$
declare
  seq_val bigint;
begin
  seq_val := nextval('ticket_number_seq');
  return upper(substring(org_slug, 1, 3)) || '-' || to_char(now(), 'YYYY') || '-' || lpad(seq_val::text, 5, '0');
end;
$$;

-- =============================================================================
-- 8. TICKET HISTORY AND NOTES
-- =============================================================================

-- Append-only stage/substatus change log
create table ticket_stage_history (
  id              uuid primary key default uuid_generate_v4(),
  ticket_id       uuid not null references tickets(id) on delete cascade,
  from_stage      text,
  to_stage        text not null,
  from_sub_status text,
  to_sub_status   text not null,
  changed_by      uuid references users(id),
  change_reason   text,
  system_action   boolean not null default false,
  created_at      timestamptz not null default now()
);

create index stage_history_ticket_idx on ticket_stage_history(ticket_id, created_at desc);

-- Append-only notes
create table ticket_notes (
  id              uuid primary key default uuid_generate_v4(),
  ticket_id       uuid not null references tickets(id) on delete cascade,
  author_user_id  uuid references users(id),
  note_type       text not null default 'general'
                  check(note_type in ('general','worker_update','escalation','system','closure')),
  content         text not null,
  is_internal     boolean not null default true,  -- false = citizen-visible milestone
  soft_deleted    boolean not null default false, -- only central support can soft-delete
  soft_deleted_by uuid references users(id),
  soft_deleted_at timestamptz,
  created_at      timestamptz not null default now()
);

create index notes_ticket_idx on ticket_notes(ticket_id, created_at desc);

-- =============================================================================
-- 9. TICKET ASSIGNMENTS
-- =============================================================================

create table ticket_assignments (
  id              uuid primary key default uuid_generate_v4(),
  ticket_id       uuid not null references tickets(id) on delete cascade,
  worker_user_id  uuid not null references users(id),
  assigned_by     uuid references users(id),
  status          text not null default 'offered'
                  check(status in ('offered','accepted','rejected','expired','force_assigned')),
  rejection_reason text check(rejection_reason in (
                    'too_far','irrelevant','conflict_of_interest',
                    'safety_concern','outside_jurisdiction','fake_spam'
                  )),
  offered_at      timestamptz not null default now(),
  responded_at    timestamptz,
  expires_at      timestamptz,
  is_current      boolean not null default true   -- only one current assignment
);

create index assignments_ticket_idx on ticket_assignments(ticket_id);
create index assignments_worker_idx on ticket_assignments(worker_user_id, is_current);

-- =============================================================================
-- 10. TICKET ATTACHMENTS
-- =============================================================================

create table ticket_attachments (
  id              uuid primary key default uuid_generate_v4(),
  ticket_id       uuid not null references tickets(id) on delete cascade,
  message_id      uuid references channel_messages(id),
  file_name       text not null,
  storage_path    text not null,   -- Supabase storage path
  mime_type       text,
  file_size_bytes bigint,
  attachment_type text check(attachment_type in ('image','video','audio','document','other')),
  uploaded_by     uuid references users(id),
  created_at      timestamptz not null default now()
);

create index attachments_ticket_idx on ticket_attachments(ticket_id);

-- =============================================================================
-- 11. AI SUGGESTIONS
-- =============================================================================

create table ai_ticket_suggestions (
  id                  uuid primary key default uuid_generate_v4(),
  ticket_id           uuid not null references tickets(id) on delete cascade,
  job_id              text,
  model_used          text,
  suggested_title     text,
  suggested_summary   text,
  suggested_category  text,
  suggested_subcategory text,
  suggested_severity  text,
  suggested_department text,
  suggested_location_text text,
  suggested_lat       double precision,
  suggested_lng       double precision,
  transcript          text,         -- voice-to-text output
  confidence_json     jsonb,        -- per-field confidence scores
  raw_ai_response     jsonb,
  status              text not null default 'pending'
                      check(status in ('pending','processing','completed','failed')),
  confirmed           boolean not null default false,
  confirmed_by        uuid references users(id),
  confirmed_at        timestamptz,
  created_at          timestamptz not null default now()
);

create index ai_suggestions_ticket_idx on ai_ticket_suggestions(ticket_id);

-- =============================================================================
-- 12. DIRECTORY
-- =============================================================================

create table directory_contacts (
  id                  uuid primary key default uuid_generate_v4(),
  organization_id     uuid not null references organizations(id),
  contact_name        text not null,
  organization_name   text,
  role_designation    text,
  phone               text,
  phone_alternate     text,
  email               text,
  availability_notes  text,
  internal_notes      text,
  verification_status text not null default 'unverified'
                      check(verification_status in ('unverified','verified','outdated')),
  active              boolean not null default true,
  created_by          uuid not null references users(id),
  updated_by          uuid references users(id),
  archived_by         uuid references users(id),
  archived_at         timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create table directory_contact_territories (
  id              uuid primary key default uuid_generate_v4(),
  contact_id      uuid not null references directory_contacts(id) on delete cascade,
  territory_id    uuid not null references territories(id) on delete cascade,
  unique(contact_id, territory_id)
);

create table directory_contact_tags (
  id         uuid primary key default uuid_generate_v4(),
  contact_id uuid not null references directory_contacts(id) on delete cascade,
  tag_type   text not null check(tag_type in ('category','department','issue_type')),
  tag_value  text not null,
  unique(contact_id, tag_type, tag_value)
);

-- =============================================================================
-- 13. AMPLIFY (draft content generation)
-- =============================================================================

create table amplify_sessions (
  id              uuid primary key default uuid_generate_v4(),
  ticket_id       uuid not null references tickets(id) on delete cascade,
  organization_id uuid not null references organizations(id),
  created_by      uuid not null references users(id),
  status          text not null default 'draft'
                  check(status in ('draft','completed','archived')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table amplify_source_selections (
  id             uuid primary key default uuid_generate_v4(),
  session_id     uuid not null references amplify_sessions(id) on delete cascade,
  source_type    text not null check(source_type in (
                   'complaint_text','normalized_summary','transcript',
                   'field_note','case_metadata','attachment'
                 )),
  source_ref_id  uuid,          -- e.g. attachment ID or note ID
  source_content text,
  pii_warning    boolean not null default false,
  included       boolean not null default true
);

create table amplify_generated_outputs (
  id             uuid primary key default uuid_generate_v4(),
  session_id     uuid not null references amplify_sessions(id) on delete cascade,
  output_format  text not null check(output_format in (
                   'tweet','instagram_caption','formal_complaint',
                   'news_article','public_summary'
                 )),
  content        text not null,  -- generated draft
  model_used     text,
  generated_by   uuid not null references users(id),
  generated_at   timestamptz not null default now(),
  last_edited_by uuid references users(id),
  last_edited_at timestamptz
);

-- =============================================================================
-- 14. AUDIT LOGS
-- =============================================================================

create table audit_logs (
  id              uuid primary key default uuid_generate_v4(),
  organization_id uuid references organizations(id),
  event_type      text not null,
  entity_type     text,
  entity_id       uuid,
  actor_type      text not null check(actor_type in ('user','system','webhook')),
  actor_user_id   uuid references users(id),
  source_ip       text,
  old_value_json  jsonb,
  new_value_json  jsonb,
  metadata_json   jsonb,
  created_at      timestamptz not null default now()
);

create index audit_org_idx on audit_logs(organization_id, created_at desc);
create index audit_entity_idx on audit_logs(entity_type, entity_id);
create index audit_actor_idx on audit_logs(actor_user_id);

-- =============================================================================
-- 15. SEED DATA
-- =============================================================================

-- Roles
insert into roles (id, name, display_name, description) values
  ('00000000-0000-0000-0000-000000000001', 'super_admin',      'Super Admin / Party Head',  'Full system access'),
  ('00000000-0000-0000-0000-000000000002', 'central_support',  'Central Support',           'Triage, assign, amplify, directory, approve workers'),
  ('00000000-0000-0000-0000-000000000003', 'state_leader',     'State Leader',              'State-scoped visibility and oversight'),
  ('00000000-0000-0000-0000-000000000004', 'district_leader',  'District / Location Leader','Territory oversight, worker requests'),
  ('00000000-0000-0000-0000-000000000005', 'ground_worker',    'Ground Worker',             'Accept, work, and close assigned tickets'),
  ('00000000-0000-0000-0000-000000000006', 'media_volunteer',  'Media / Support Volunteer', 'Placeholder - no UI in V1'),
  ('00000000-0000-0000-0000-000000000007', 'legal_support',    'Legal / Support Team',      'Placeholder - no UI in V1')
on conflict (name) do nothing;

-- Default issue categories (Level 1)
insert into issue_categories (id, parent_id, name, level, sort_order) values
  ('10000000-0000-0000-0000-000000000001', null, 'Governance and Administration',            1, 1),
  ('10000000-0000-0000-0000-000000000002', null, 'Land, Revenue, and Documentation',         1, 2),
  ('10000000-0000-0000-0000-000000000003', null, 'Police, Law, and Safety',                  1, 3),
  ('10000000-0000-0000-0000-000000000004', null, 'Women, Child, and Vulnerable Group Safety', 1, 4),
  ('10000000-0000-0000-0000-000000000005', null, 'Municipal and Civic Services',              1, 5),
  ('10000000-0000-0000-0000-000000000006', null, 'Public Infrastructure',                    1, 6),
  ('10000000-0000-0000-0000-000000000007', null, 'Health and Medical Access',                1, 7),
  ('10000000-0000-0000-0000-000000000008', null, 'Education and Youth',                      1, 8),
  ('10000000-0000-0000-0000-000000000009', null, 'Employment and Livelihood',                1, 9),
  ('10000000-0000-0000-0000-000000000010', null, 'Agriculture and Farmer Distress',          1, 10),
  ('10000000-0000-0000-0000-000000000011', null, 'Welfare, Benefits, and Entitlements',      1, 11),
  ('10000000-0000-0000-0000-000000000012', null, 'Corruption and Bribery',                   1, 12),
  ('10000000-0000-0000-0000-000000000013', null, 'Community Conflict and Social Harm',       1, 13),
  ('10000000-0000-0000-0000-000000000014', null, 'Environment and Public Nuisance',          1, 14),
  ('10000000-0000-0000-0000-000000000015', null, 'Other / Uncategorized',                    1, 99)
on conflict do nothing;
