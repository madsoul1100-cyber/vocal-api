-- Round-robin cursor per territory for fair worker distribution.
create table if not exists territory_assignment_cursors (
  organization_id  uuid not null references organizations(id) on delete cascade,
  territory_id     uuid not null references territories(id) on delete cascade,
  last_worker_id   uuid references users(id) on delete set null,
  updated_at       timestamptz not null default now(),
  primary key (organization_id, territory_id)
);

create index if not exists territory_assignment_cursors_org_idx
  on territory_assignment_cursors(organization_id);
