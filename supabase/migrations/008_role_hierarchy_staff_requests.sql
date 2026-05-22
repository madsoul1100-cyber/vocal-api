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
