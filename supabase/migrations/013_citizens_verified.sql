-- Citizen phone/channel verification flag (WhatsApp intake = verified).

ALTER TABLE citizens
  ADD COLUMN IF NOT EXISTS verified boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN citizens.verified IS
  'True when identity is verified (e.g. WhatsApp phone from Twilio).';

-- Backfill existing rows.
UPDATE citizens SET verified = true WHERE verified = false;
