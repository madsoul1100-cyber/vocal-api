-- When using S3, default profile paths should include the s3: prefix (see storageRef).
-- Safe to run without S3 too; signing normalizes bare paths on read.

update users
set image_url = 's3:' || image_url,
    updated_at = now()
where image_url = 'system/defaults/staff-profile-placeholder.png';

update worker_activation_requests
set image_url = 's3:' || image_url
where image_url = 'system/defaults/staff-profile-placeholder.png';
