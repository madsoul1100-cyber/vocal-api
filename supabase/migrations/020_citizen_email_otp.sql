-- Citizen login can prove either a mobile number (SMS) or an email (SES).

ALTER TABLE citizen_otps ALTER COLUMN phone_e164 DROP NOT NULL;
ALTER TABLE citizen_otps ADD COLUMN IF NOT EXISTS email text;

ALTER TABLE citizen_otps DROP CONSTRAINT IF EXISTS citizen_otps_destination_chk;
ALTER TABLE citizen_otps ADD CONSTRAINT citizen_otps_destination_chk
  CHECK (phone_e164 IS NOT NULL OR email IS NOT NULL);

CREATE INDEX IF NOT EXISTS citizen_otps_email_idx
  ON citizen_otps (organization_id, lower(email), created_at DESC)
  WHERE email IS NOT NULL;

ALTER TABLE citizens ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS citizens_org_email_uidx
  ON citizens (organization_id, lower(email))
  WHERE email IS NOT NULL;
