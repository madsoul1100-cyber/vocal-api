-- Enforce unique staff email (global, case-insensitive) and phone (per organization).
-- Matches vocal-api auth lookups and workersManagementService contact checks.
--
-- If this migration fails, resolve duplicate rows first, then re-run:
--   select lower(trim(email)), count(*) from users where email is not null group by 1 having count(*) > 1;
--   select organization_id, phone, count(*) from users where phone is not null group by 1,2 having count(*) > 1;

update users
set email = lower(trim(email))
where email is not null
  and email <> lower(trim(email));

create unique index if not exists users_email_lower_unique_idx
  on users (lower(trim(email)))
  where email is not null and trim(email) <> '';

create unique index if not exists users_org_phone_unique_idx
  on users (organization_id, phone)
  where phone is not null and trim(phone) <> '';

comment on index users_email_lower_unique_idx is
  'Staff email globally unique (case-insensitive) for OTP and password login.';

comment on index users_org_phone_unique_idx is
  'Staff phone unique within each organization.';
