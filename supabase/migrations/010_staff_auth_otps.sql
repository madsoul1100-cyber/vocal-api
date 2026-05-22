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
