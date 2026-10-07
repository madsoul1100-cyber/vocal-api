-- =============================================================================
-- Bharosa: email + assisted-call intake
-- Version: 019
--
-- Email intake: a complaint emailed to the intake address becomes a draft
-- submission. The citizen gets a one-time link, verifies their mobile by OTP,
-- reviews the AI summary and confirms — only then does it become a case.
-- Assisted call intake reuses created_by_user_id (staff who logged the call).
-- =============================================================================

ALTER TABLE submissions
  ADD COLUMN IF NOT EXISTS contact_email     text,
  ADD COLUMN IF NOT EXISTS contact_name      text,
  ADD COLUMN IF NOT EXISTS contact_phone     text,
  ADD COLUMN IF NOT EXISTS subject           text,
  ADD COLUMN IF NOT EXISTS inbound_message_id text,
  ADD COLUMN IF NOT EXISTS claim_token_hash  text,
  ADD COLUMN IF NOT EXISTS claim_expires_at  timestamptz,
  ADD COLUMN IF NOT EXISTS claimed_at        timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS submissions_claim_token_uidx
  ON submissions(claim_token_hash) WHERE claim_token_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS submissions_inbound_msg_uidx
  ON submissions(organization_id, inbound_message_id) WHERE inbound_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS submissions_contact_email_idx
  ON submissions(organization_id, lower(contact_email), created_at DESC) WHERE contact_email IS NOT NULL;
CREATE INDEX IF NOT EXISTS submissions_staff_idx
  ON submissions(organization_id, created_by_user_id, created_at DESC) WHERE created_by_user_id IS NOT NULL;
