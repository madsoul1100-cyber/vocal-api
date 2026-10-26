-- Website help-agent conversations. No citizen login: the browser keeps the session id,
-- and name / phone / email are collected inside the chat when a case has to be raised.

CREATE TABLE IF NOT EXISTS guide_sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  language        text NOT NULL DEFAULT 'te',
  status          text NOT NULL DEFAULT 'open',
  problem_id      text,
  contact_json    jsonb NOT NULL DEFAULT '{}'::jsonb,
  draft_json      jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT guide_sessions_language_chk CHECK (language IN ('te', 'en', 'hi')),
  CONSTRAINT guide_sessions_status_chk CHECK (status IN ('open', 'satisfied', 'raised'))
);

CREATE INDEX IF NOT EXISTS guide_sessions_phone_idx
  ON guide_sessions (organization_id, (contact_json->>'phone'), updated_at DESC);

CREATE TABLE IF NOT EXISTS guide_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  uuid NOT NULL REFERENCES guide_sessions(id) ON DELETE CASCADE,
  role        text NOT NULL,
  body        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT guide_messages_role_chk CHECK (role IN ('user', 'assistant'))
);

CREATE INDEX IF NOT EXISTS guide_messages_session_idx
  ON guide_messages (session_id, created_at);
