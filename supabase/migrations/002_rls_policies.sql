-- =============================================================================
-- Vocal - Row Level Security Policies
-- Version: 002
-- =============================================================================
-- Pattern:
--   - All browser-facing tables have RLS enabled
--   - Service role bypasses RLS (used only by backend functions)
--   - Policies use auth.uid() mapped to users.clerk_user_id
-- =============================================================================

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
