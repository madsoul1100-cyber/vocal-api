-- =============================================================================
-- Vocal - Full database schema (auto-generated)
-- Generated: 2026-06-08T16:18:26.527Z
-- Source: supabase/migrations/*.sql (14 files)
--
-- Run this ENTIRE file in one go (pgAdmin Query Tool → Execute/▶).
-- Do NOT run migration files one by one.
-- =============================================================================

-- Required on plain Postgres (RDS / pgAdmin). Supabase provides this natively.
create schema if not exists auth;

create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;


-- >>> 001_initial_schema.sql

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


-- >>> 002_rls_policies.sql

-- =============================================================================
-- Vocal - Row Level Security Policies
-- Version: 002
-- =============================================================================
-- Pattern:
--   - All browser-facing tables have RLS enabled
--   - Service role bypasses RLS (used only by backend functions)
--   - Policies use auth.uid() mapped to users.clerk_user_id
-- =============================================================================

-- Supabase ships auth.uid(); plain Postgres (RDS / pgAdmin) needs this stub.
-- vocal-api connects as the DB owner and bypasses RLS; policies matter only for
-- direct Supabase client access.
create schema if not exists auth;

create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

-- Helper function: get current user's internal record
create or replace function current_user_record()
returns users language sql security definer stable as $$
  select * from users
  where clerk_user_id = auth.uid()::text
  limit 1;
$$;

-- Helper function: get current user's role name
create or replace function current_user_role()
returns text language sql security definer stable as $$
  select r.name from users u
  join roles r on r.id = u.role_id
  where u.clerk_user_id = auth.uid()::text
  and u.active = true
  limit 1;
$$;

-- Helper function: get current user's organization
create or replace function current_user_org()
returns uuid language sql security definer stable as $$
  select organization_id from users
  where clerk_user_id = auth.uid()::text
  and active = true
  limit 1;
$$;

-- Helper function: check if current user has one of the given roles
create or replace function has_role(role_names text[])
returns boolean language sql security definer stable as $$
  select exists (
    select 1 from users u
    join roles r on r.id = u.role_id
    where u.clerk_user_id = auth.uid()::text
    and u.active = true
    and r.name = any(role_names)
  );
$$;

-- Helper function: can user access territory (user's territory or ancestor)
create or replace function can_access_territory(t_id uuid)
returns boolean language sql security definer stable as $$
  select exists (
    select 1 from user_territories ut
    join users u on u.id = ut.user_id
    where u.clerk_user_id = auth.uid()::text
    and u.active = true
    and (
      ut.territory_id = t_id
      -- TODO: add ancestor check for hierarchical access
    )
  );
$$;

-- =============================================================================
-- Enable RLS on all user-facing tables
-- =============================================================================

alter table organizations           enable row level security;
alter table organization_settings   enable row level security;
alter table territory_level_definitions enable row level security;
alter table territories             enable row level security;
alter table users                   enable row level security;
alter table user_territories        enable row level security;
alter table worker_activation_requests enable row level security;
alter table citizens                enable row level security;
alter table citizen_channel_identities enable row level security;
alter table channel_conversations   enable row level security;
alter table channel_messages        enable row level security;
alter table tickets                 enable row level security;
alter table ticket_stage_history    enable row level security;
alter table ticket_notes            enable row level security;
alter table ticket_assignments      enable row level security;
alter table ticket_attachments      enable row level security;
alter table ai_ticket_suggestions   enable row level security;
alter table directory_contacts      enable row level security;
alter table directory_contact_territories enable row level security;
alter table directory_contact_tags  enable row level security;
alter table amplify_sessions        enable row level security;
alter table amplify_source_selections enable row level security;
alter table amplify_generated_outputs enable row level security;
alter table audit_logs              enable row level security;

-- =============================================================================
-- ORGANIZATIONS: all active users can read their own org
-- =============================================================================

create policy "users_read_own_org"
  on organizations for select
  using (id = current_user_org());

-- =============================================================================
-- TERRITORIES: all active users in org can read territories
-- =============================================================================

create policy "users_read_org_territories"
  on territories for select
  using (organization_id = current_user_org());

create policy "users_read_territory_levels"
  on territory_level_definitions for select
  using (organization_id = current_user_org());

-- =============================================================================
-- USERS: users can read others in same org (for assignment lists etc.)
-- Names/roles visible; PII fields protected at application layer
-- =============================================================================

create policy "users_read_same_org"
  on users for select
  using (organization_id = current_user_org());

create policy "users_read_own_record"
  on users for update
  using (clerk_user_id = auth.uid()::text);

-- =============================================================================
-- TICKETS: access depends on role + territory
-- =============================================================================

-- Super admin and central support: see all org tickets
create policy "superadmin_central_read_all_tickets"
  on tickets for select
  using (
    organization_id = current_user_org()
    and has_role(array['super_admin','central_support'])
  );

-- Ground worker: see tickets assigned to them or in their territory queue
create policy "worker_read_own_tickets"
  on tickets for select
  using (
    organization_id = current_user_org()
    and has_role(array['ground_worker'])
    and (
      owner_user_id = (select id from users where clerk_user_id = auth.uid()::text limit 1)
      or exists (
        select 1 from ticket_assignments ta
        join users u on u.id = ta.worker_user_id
        where ta.ticket_id = tickets.id
        and u.clerk_user_id = auth.uid()::text
        and ta.status in ('offered','accepted')
      )
    )
  );

-- District/state leaders: see tickets in their territory scope
create policy "leader_read_territory_tickets"
  on tickets for select
  using (
    organization_id = current_user_org()
    and has_role(array['district_leader','state_leader'])
    and (
      territory_id is null
      or can_access_territory(territory_id)
    )
  );

-- All roles can update tickets through service (direct write blocked via app layer)
-- Workers can only write through API routes that enforce rules
create policy "worker_update_own_ticket"
  on tickets for update
  using (
    organization_id = current_user_org()
    and (
      has_role(array['super_admin','central_support'])
      or (
        has_role(array['ground_worker'])
        and owner_user_id = (select id from users where clerk_user_id = auth.uid()::text limit 1)
      )
    )
  );

-- =============================================================================
-- TICKET NOTES: append-only enforced at application layer; RLS scopes reads
-- =============================================================================

create policy "read_ticket_notes"
  on ticket_notes for select
  using (
    exists (
      select 1 from tickets t
      where t.id = ticket_notes.ticket_id
      and t.organization_id = current_user_org()
    )
  );

create policy "insert_ticket_notes"
  on ticket_notes for insert
  with check (
    exists (
      select 1 from tickets t
      where t.id = ticket_notes.ticket_id
      and t.organization_id = current_user_org()
    )
    and author_user_id = (select id from users where clerk_user_id = auth.uid()::text limit 1)
  );

-- =============================================================================
-- TICKET STAGE HISTORY: read scoped to org
-- =============================================================================

create policy "read_stage_history"
  on ticket_stage_history for select
  using (
    exists (
      select 1 from tickets t
      where t.id = ticket_stage_history.ticket_id
      and t.organization_id = current_user_org()
    )
  );

-- =============================================================================
-- CITIZENS: PII restricted to super_admin and central_support
-- =============================================================================

create policy "privileged_read_citizens"
  on citizens for select
  using (
    organization_id = current_user_org()
    and has_role(array['super_admin','central_support'])
  );

-- Workers see citizen after acceptance
create policy "worker_read_citizen_after_accept"
  on citizens for select
  using (
    organization_id = current_user_org()
    and has_role(array['ground_worker'])
    and exists (
      select 1 from tickets t
      join ticket_assignments ta on ta.ticket_id = t.id
      join users u on u.id = ta.worker_user_id
      where t.citizen_id = citizens.id
      and u.clerk_user_id = auth.uid()::text
      and ta.status = 'accepted'
      and t.anonymous_flag = false
    )
  );

-- =============================================================================
-- DIRECTORY: scoped reads; write restricted to central_support/super_admin
-- =============================================================================

create policy "read_directory_contacts"
  on directory_contacts for select
  using (
    organization_id = current_user_org()
    and active = true
  );

create policy "manage_directory_contacts"
  on directory_contacts for all
  using (
    organization_id = current_user_org()
    and has_role(array['super_admin','central_support'])
  );

-- =============================================================================
-- AMPLIFY: central support and super admin only
-- =============================================================================

create policy "amplify_access"
  on amplify_sessions for all
  using (
    organization_id = current_user_org()
    and has_role(array['super_admin','central_support'])
  );

create policy "amplify_outputs_access"
  on amplify_generated_outputs for all
  using (
    exists (
      select 1 from amplify_sessions s
      where s.id = amplify_generated_outputs.session_id
      and s.organization_id = current_user_org()
      and has_role(array['super_admin','central_support'])
    )
  );

-- =============================================================================
-- AUDIT LOGS: read-only for super_admin and central_support
-- =============================================================================

create policy "read_audit_logs"
  on audit_logs for select
  using (
    organization_id = current_user_org()
    and has_role(array['super_admin','central_support'])
  );

-- Audit log inserts only allowed via service role (no client insert policy)

-- =============================================================================
-- AI SUGGESTIONS: central support and super_admin
-- =============================================================================

create policy "read_ai_suggestions"
  on ai_ticket_suggestions for select
  using (
    exists (
      select 1 from tickets t
      where t.id = ai_ticket_suggestions.ticket_id
      and t.organization_id = current_user_org()
      and has_role(array['super_admin','central_support'])
    )
  );


-- >>> 003_org_scoped_ticket_numbers.sql

-- =============================================================================
-- Vocal - Org-scoped ticket numbering
-- Version: 003
-- =============================================================================
-- Problem: ticket_number_seq is a single global sequence. Org A creates ticket
--   VCL-2024-00001, Org B's first ticket then becomes ORG-2024-00002. This leaks
--   cross-tenant volume info and makes ticket numbers surprising to users.
--
-- Fix: per-org counter table, rotated yearly. Function signature changes to
--   take the org id (the caller already has it).
-- =============================================================================

create table if not exists organization_ticket_counters (
  organization_id uuid primary key references organizations(id) on delete cascade,
  year            int not null,
  counter         bigint not null default 0,
  updated_at      timestamptz not null default now()
);

alter table organization_ticket_counters enable row level security;
-- No client policies — this table is only written by the security-definer function.

-- Drop old global-sequence function signature if present
drop function if exists generate_ticket_number(text);

create or replace function generate_ticket_number(org_id uuid, org_slug text)
returns text
language plpgsql
security definer
as $$
declare
  current_year int := extract(year from now())::int;
  seq_val bigint;
begin
  insert into organization_ticket_counters as c (organization_id, year, counter)
    values (org_id, current_year, 1)
  on conflict (organization_id) do update
    set counter = case
          when c.year = current_year then c.counter + 1
          else 1
        end,
        year = current_year,
        updated_at = now()
  returning c.counter into seq_val;

  return upper(substring(org_slug, 1, 3))
         || '-' || current_year::text
         || '-' || lpad(seq_val::text, 5, '0');
end;
$$;

-- Seed the counter table from existing ticket counts so legacy numbers don't
-- collide with new ones. For each org, set counter = max seq across tickets
-- created this calendar year (best-effort; falls back to 0 if no matches).
insert into organization_ticket_counters (organization_id, year, counter)
select
  organization_id,
  extract(year from now())::int as year,
  coalesce(
    max(
      nullif(
        regexp_replace(ticket_number, '^.*-(\d+)$', '\1'),
        ''
      )::bigint
    ),
    0
  ) as counter
from tickets
where extract(year from created_at) = extract(year from now())
group by organization_id
on conflict (organization_id) do update
  set counter = greatest(organization_ticket_counters.counter, excluded.counter),
      year    = excluded.year;

-- The old global sequence is no longer used. Keep it around in case anything
-- external depends on it; drop in a later migration once confirmed unused.
-- drop sequence ticket_number_seq;


-- >>> 004_assignment_sla_and_amplify_formats.sql

-- =============================================================================
-- Vocal - Migration 004
-- Scope:
--   1. Relax amplify_generated_outputs output_format CHECK to include
--      whatsapp_broadcast, facebook_post, letter_to_authority, press_release.
--   2. Add amplify_generated_outputs.tone + platform-aware metadata_json.
--   3. Add SLA columns on tickets (sla_first_contact_due_at, sla_resolution_due_at).
--   4. Cut default acceptance_sla_minutes from 15 → 2 (demo/testing default).
--   5. Add an explicit `offered_to_user_ids[]` memo on tickets so the reoffer
--      service can skip workers who already saw and rejected/expired.
--   6. Flip default generate_ticket_number to a function signature compatible
--      with both the old (org_slug) and the pending 003 (org_id, org_slug)
--      callers — by making org_id optional (default null). This lets the
--      caller keep working either way.
-- =============================================================================

-- 1. Extend amplify output format check constraint --------------------------
alter table amplify_generated_outputs
  drop constraint if exists amplify_generated_outputs_output_format_check;

alter table amplify_generated_outputs
  add constraint amplify_generated_outputs_output_format_check
  check (output_format in (
    'tweet',
    'instagram_caption',
    'facebook_post',
    'whatsapp_broadcast',
    'formal_complaint',
    'letter_to_authority',
    'news_article',
    'press_release',
    'public_summary'
  ));

-- 2. Optional tone + metadata on generated outputs --------------------------
alter table amplify_generated_outputs
  add column if not exists tone text check (tone in ('informative','urgent','formal','empathetic','neutral')),
  add column if not exists metadata_json jsonb;

-- 3. Ticket SLA columns -----------------------------------------------------
alter table tickets
  add column if not exists sla_first_contact_due_at timestamptz,
  add column if not exists sla_resolution_due_at    timestamptz,
  add column if not exists sla_breached_flag        boolean not null default false;

create index if not exists tickets_sla_breach_idx
  on tickets(organization_id, sla_breached_flag) where sla_breached_flag = true;

-- 4. Flip org default acceptance window for testing -------------------------
-- (Existing rows aren't touched; only the column default changes. Seed new
-- orgs with 2 for fast testing. Production deployments should override.)
alter table organization_settings
  alter column acceptance_sla_minutes set default 2;

update organization_settings
  set acceptance_sla_minutes = 2
  where acceptance_sla_minutes = 15;

-- 5. Track which workers have already been offered this ticket --------------
alter table tickets
  add column if not exists offered_worker_ids uuid[] not null default '{}';

-- 6. Robust ticket-number generator -----------------------------------------
-- Old signature (single-arg, global seq) and the pending 003 (org_id + slug)
-- both work. We keep the two-arg variant and add a single-arg shim that
-- forwards to it for callers that haven't upgraded yet.
create or replace function generate_ticket_number(org_id uuid, org_slug text)
returns text language plpgsql as $$
declare
  seq_val bigint;
begin
  seq_val := nextval('ticket_number_seq');
  return upper(substring(coalesce(org_slug, 'VOC'), 1, 3))
         || '-' || to_char(now(), 'YYYY')
         || '-' || lpad(seq_val::text, 5, '0');
end;
$$;

-- Single-arg shim so services/ticketService.ts keeps working even before
-- the call site is upgraded.
create or replace function generate_ticket_number(org_slug text)
returns text language plpgsql as $$
begin
  return generate_ticket_number(null::uuid, org_slug);
end;
$$;


-- >>> 005_amplify_campaign_tones.sql

-- Migration 005: Campaign tones for Amplify
--
-- Widens the CHECK constraint on amplify_generated_outputs.tone to include
-- the three campaign/escalation tones added in the Amplify prompt rewrite:
--   activist, opposition, public_shame
--
-- Safe to re-run — drops the old constraint if present before re-adding.

alter table amplify_generated_outputs
  drop constraint if exists amplify_generated_outputs_tone_check;

alter table amplify_generated_outputs
  add constraint amplify_generated_outputs_tone_check
  check (
    tone is null
    or tone in (
      'informative',
      'urgent',
      'formal',
      'empathetic',
      'neutral',
      -- campaign / escalation tones
      'activist',
      'opposition',
      'public_shame'
    )
  );


-- >>> 006_intake_conversation_version.sql

-- =============================================================================
-- Migration 006: Intake conversation version flag
-- =============================================================================
--
-- Adds a per-org switch to choose which intake engine runs in the citizen
-- Telegram webhook:
--   • 'v1' — the original rigid state machine (telegramFlow.ts).
--           Asks: issue → media → location → confirm → file.
--           Predictable, no LLM dependency.
--   • 'v2' — the new LLM-driven conversation manager
--           (services/intakeConversationManager.ts).
--           Telugu / Tinglish / English fluent, multimodal-aware, civic-scope
--           filter, conversational follow-ups.
--
-- Default 'v1' so existing demo behavior is unchanged. SuperAdmin flips to
-- 'v2' through the /admin/intake-settings UI when ready.
-- =============================================================================

alter table organization_settings
  add column if not exists intake_conversation_version text not null default 'v1';

alter table organization_settings
  drop constraint if exists organization_settings_intake_version_check;

alter table organization_settings
  add constraint organization_settings_intake_version_check
  check (intake_conversation_version in ('v1', 'v2'));

-- Backfill: existing rows get the default ('v1') automatically thanks to the
-- DEFAULT clause above. No explicit UPDATE needed.

comment on column organization_settings.intake_conversation_version is
  'Which citizen-intake engine to run in the Telegram webhook: v1 = rigid state machine, v2 = LLM conversation manager.';


-- >>> 007_user_password_auth.sql

-- Backend-owned auth: email + password on users table (replaces Clerk for vocal-api / vocal-web)

alter table users
  add column if not exists password_hash text;

comment on column users.password_hash is
  'bcrypt hash for staff login via vocal-api; null until set by admin/seed';

alter table users alter column clerk_user_id drop not null;


-- >>> 008_role_hierarchy_staff_requests.sql

-- Role hierarchy for staff creation (lower number = higher privilege).
-- Users may only create/assign roles strictly below their own level.
-- Staff created by district leaders (etc.) goes through worker_activation_requests
-- until super_admin or central_support approves.

alter table roles
  add column if not exists hierarchy_level int;

update roles set hierarchy_level = case name
  when 'super_admin'     then 1
  when 'central_support' then 2
  when 'state_leader'    then 3
  when 'district_leader' then 4
  when 'ground_worker'   then 5
  when 'media_volunteer' then 6
  when 'legal_support'   then 7
  else 99
end
where hierarchy_level is null;

alter table roles
  alter column hierarchy_level set not null;

create unique index if not exists roles_hierarchy_level_idx on roles (hierarchy_level);

comment on column roles.hierarchy_level is
  'Lower value = higher privilege. Staff may only be assigned roles with a higher hierarchy_level than their own.';

-- Full staff onboarding payload for approval queue
alter table worker_activation_requests
  add column if not exists role_id uuid references roles(id),
  add column if not exists password_hash text,
  add column if not exists metadata_json jsonb,
  add column if not exists active_requested boolean not null default true;

-- Email-only requests (phone was required historically)
alter table worker_activation_requests
  alter column phone drop not null;

comment on column worker_activation_requests.role_id is
  'Target role for the new staff member (must be below requester hierarchy).';
comment on column worker_activation_requests.password_hash is
  'Bcrypt hash for sign-in; applied when request is approved.';
comment on column worker_activation_requests.active_requested is
  'Whether the account should be active immediately after approval.';


-- >>> 009_staff_notes_image_kyc.sql

-- Staff profile fields: notes, profile image, KYC documents (S3/storage paths).

alter table users
  add column if not exists notes text,
  add column if not exists image_url text,
  add column if not exists kyc_documents jsonb not null default '[]'::jsonb;

alter table worker_activation_requests
  add column if not exists notes text,
  add column if not exists image_url text,
  add column if not exists kyc_documents jsonb not null default '[]'::jsonb;

comment on column users.notes is 'Free-text notes about this staff member.';
comment on column users.image_url is 'Storage path (S3 or bucket) for profile photo.';
comment on column users.kyc_documents is
  'Array of { storage_path, file_name, mime_type, size_bytes, uploaded_at }.';

comment on column worker_activation_requests.kyc_documents is
  'KYC uploads pending approval; copied to users on approve.';


-- >>> 010_staff_auth_otps.sql

-- OTP-based staff sign-in and password setup (no password required at worker creation).
-- gen_random_uuid() is built into PostgreSQL 13+ (no uuid-ossp extension needed).
-- If you only ran later migrations on a fresh DB, enable uuid-ossp once:
--   create extension if not exists "uuid-ossp";

create table if not exists staff_auth_otps (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references users(id) on delete cascade,
  purpose         text not null check (purpose in ('login', 'forgot_password')),
  channel         text not null check (channel in ('sms', 'email')),
  destination     text not null,
  code_hash       text not null,
  expires_at      timestamptz not null,
  consumed_at     timestamptz,
  attempt_count   int not null default 0,
  created_at      timestamptz not null default now()
);

create index if not exists staff_auth_otps_user_idx on staff_auth_otps(user_id, purpose);
create index if not exists staff_auth_otps_expires_idx on staff_auth_otps(expires_at);

comment on table staff_auth_otps is
  'One-time codes for staff login and password reset. Password optional until first OTP login.';


-- >>> 011_default_staff_profile_image.sql

-- Backfill users and pending activations without a profile photo with the shared placeholder path.
-- Run `npm run seed:staff-profile-placeholder` after migrate to upload the PNG into storage.

update users
set image_url = 'system/defaults/staff-profile-placeholder.png',
    updated_at = now()
where image_url is null or trim(image_url) = '';

update worker_activation_requests
set image_url = 'system/defaults/staff-profile-placeholder.png'
where image_url is null or trim(image_url) = '';


-- >>> 012_ticket_closure_review.sql

-- Worker soft-close queue flag (CS reviews before stage = closed)
alter table tickets
  add column if not exists needs_closure_review boolean not null default false;

create index if not exists tickets_closure_review_idx
  on tickets (organization_id, needs_closure_review)
  where needs_closure_review = true;


-- >>> 013_citizens_verified.sql

-- Citizen phone/channel verification flag (WhatsApp intake = verified).

ALTER TABLE citizens
  ADD COLUMN IF NOT EXISTS verified boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN citizens.verified IS
  'True when identity is verified (e.g. WhatsApp phone from Twilio).';

-- Backfill existing rows.
UPDATE citizens SET verified = true WHERE verified = false;


-- >>> 014_citizen_channel_manual.sql

-- Ground-worker filed tickets use citizen_channel_identities.channel = 'manual'
ALTER TABLE citizen_channel_identities
  DROP CONSTRAINT IF EXISTS citizen_channel_identities_channel_check;

ALTER TABLE citizen_channel_identities
  ADD CONSTRAINT citizen_channel_identities_channel_check
  CHECK (channel IN ('telegram', 'whatsapp', 'web', 'manual'));
