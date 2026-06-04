-- Ground-worker filed tickets use citizen_channel_identities.channel = 'manual'
ALTER TABLE citizen_channel_identities
  DROP CONSTRAINT IF EXISTS citizen_channel_identities_channel_check;

ALTER TABLE citizen_channel_identities
  ADD CONSTRAINT citizen_channel_identities_channel_check
  CHECK (channel IN ('telegram', 'whatsapp', 'web', 'manual'));
