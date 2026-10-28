-- Persistent Guide memory for logged-in citizens + optional OpenClaw sync.
-- Source of truth stays in vocal-api; OpenClaw may mirror notes for staff enrichment.

ALTER TABLE guide_sessions
  ADD COLUMN IF NOT EXISTS citizen_id uuid REFERENCES citizens(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS guide_sessions_citizen_idx
  ON guide_sessions (organization_id, citizen_id, updated_at DESC)
  WHERE citizen_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS citizen_guide_memory (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  citizen_id      uuid NOT NULL REFERENCES citizens(id) ON DELETE CASCADE,
  profile_json    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT citizen_guide_memory_org_citizen_uq UNIQUE (organization_id, citizen_id)
);

CREATE INDEX IF NOT EXISTS citizen_guide_memory_updated_idx
  ON citizen_guide_memory (organization_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS citizen_guide_memory_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id   uuid NOT NULL REFERENCES citizen_guide_memory(id) ON DELETE CASCADE,
  event_type  text NOT NULL,
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT citizen_guide_memory_events_type_chk CHECK (
    event_type IN (
      'problem_mentioned',
      'topic_switch',
      'raised',
      'satisfied',
      'wants_desk',
      'area_given',
      'session_touch'
    )
  )
);

CREATE INDEX IF NOT EXISTS citizen_guide_memory_events_mem_idx
  ON citizen_guide_memory_events (memory_id, created_at DESC);
