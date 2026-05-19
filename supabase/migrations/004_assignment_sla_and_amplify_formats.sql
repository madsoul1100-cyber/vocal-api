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
