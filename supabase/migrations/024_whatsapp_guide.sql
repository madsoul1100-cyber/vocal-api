-- WhatsApp (Telinfy) <-> Bharosa guide chatbot.
--  * whatsapp_guide_sessions: which guide session a WhatsApp number is currently chatting in
--  * whatsapp_inbound_dedupe: Telinfy/Meta retry webhooks; each provider message id is handled once

CREATE TABLE IF NOT EXISTS whatsapp_guide_sessions (
  organization_id uuid        NOT NULL,
  wa_id           text        NOT NULL,           -- digits only, e.g. 919876543210
  session_id      uuid        NOT NULL REFERENCES guide_sessions(id) ON DELETE CASCADE,
  last_inbound_at timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, wa_id)
);

CREATE TABLE IF NOT EXISTS whatsapp_inbound_dedupe (
  provider    text        NOT NULL,
  message_id  text        NOT NULL,
  wa_id       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, message_id)
);

CREATE INDEX IF NOT EXISTS whatsapp_inbound_dedupe_created_idx
  ON whatsapp_inbound_dedupe (created_at);
