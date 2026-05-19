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
