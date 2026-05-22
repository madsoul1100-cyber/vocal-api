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
