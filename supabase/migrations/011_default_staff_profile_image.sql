-- Backfill users and pending activations without a profile photo with the shared placeholder path.
-- Run `npm run seed:staff-profile-placeholder` after migrate to upload the PNG into storage.

update users
set image_url = 'system/defaults/staff-profile-placeholder.png',
    updated_at = now()
where image_url is null or trim(image_url) = '';

update worker_activation_requests
set image_url = 'system/defaults/staff-profile-placeholder.png'
where image_url is null or trim(image_url) = '';
