-- Backend-owned auth: email + password on users table (replaces Clerk for vocal-api / vocal-web)

alter table users
  add column if not exists password_hash text;

comment on column users.password_hash is
  'bcrypt hash for staff login via vocal-api; null until set by admin/seed';

alter table users alter column clerk_user_id drop not null;
