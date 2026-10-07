-- =============================================================================
-- Bharosa Phase 1 (Public action MVP) data model
-- Version: 018
--
-- Extends the existing tickets (= canonical "case") model rather than creating
-- a second one. Adds: citizen OTP + consents, submissions, verification checks,
-- immutable case events, tasks (sub-tasks, many-to-many with cases), resolution
-- plans, communications + delivery events, escalations, AI run traces, a durable
-- job queue, directory jurisdiction/refresh metadata and the political feed.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Channels: email + call intake
-- -----------------------------------------------------------------------------
ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_source_channel_check;
ALTER TABLE tickets ADD CONSTRAINT tickets_source_channel_check
  CHECK (source_channel IN ('telegram','whatsapp','web','manual','email','call'));

ALTER TABLE citizen_channel_identities DROP CONSTRAINT IF EXISTS citizen_channel_identities_channel_check;
ALTER TABLE citizen_channel_identities ADD CONSTRAINT citizen_channel_identities_channel_check
  CHECK (channel IN ('telegram','whatsapp','web','manual','email','call'));

-- -----------------------------------------------------------------------------
-- 2. Citizen profile, OTP and consent
-- -----------------------------------------------------------------------------
ALTER TABLE citizens
  ADD COLUMN IF NOT EXISTS phone_e164 text,
  ADD COLUMN IF NOT EXISTS email text,
  ADD COLUMN IF NOT EXISTS preferred_language text NOT NULL DEFAULT 'te',
  ADD COLUMN IF NOT EXISTS phone_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS whatsapp_opt_in boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS blocked_at timestamptz,
  ADD COLUMN IF NOT EXISTS blocked_reason text;

CREATE UNIQUE INDEX IF NOT EXISTS citizens_org_phone_uidx
  ON citizens(organization_id, phone_e164) WHERE phone_e164 IS NOT NULL;

CREATE TABLE IF NOT EXISTS citizen_otps (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  phone_e164      text NOT NULL,
  code_hash       text NOT NULL,
  provider        text,
  provider_ref    text,
  attempt_count   int NOT NULL DEFAULT 0,
  expires_at      timestamptz NOT NULL,
  consumed_at     timestamptz,
  request_ip      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS citizen_otps_phone_idx ON citizen_otps(organization_id, phone_e164, created_at DESC);
CREATE INDEX IF NOT EXISTS citizen_otps_ip_idx ON citizen_otps(request_ip, created_at DESC);

CREATE TABLE IF NOT EXISTS citizen_consents (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  citizen_id      uuid NOT NULL REFERENCES citizens(id) ON DELETE CASCADE,
  ticket_id       uuid REFERENCES tickets(id) ON DELETE CASCADE,
  consent_type    text NOT NULL CHECK (consent_type IN (
                    'terms','privacy','share_with_authority','contact_by_phone',
                    'whatsapp_updates','public_status','location_exact','media_use')),
  granted         boolean NOT NULL,
  text_version    text NOT NULL DEFAULT 'v1',
  language        text,
  channel         text,
  source_ip       text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS citizen_consents_citizen_idx ON citizen_consents(citizen_id, consent_type, created_at DESC);

-- -----------------------------------------------------------------------------
-- 3. Case (ticket) extensions: two locations, verification, tracker, language
-- -----------------------------------------------------------------------------
ALTER TABLE tickets
  ADD COLUMN IF NOT EXISTS language                  text,
  ADD COLUMN IF NOT EXISTS issue_location_source     text,
  ADD COLUMN IF NOT EXISTS issue_location_precision_m double precision,
  ADD COLUMN IF NOT EXISTS reporter_location_text    text,
  ADD COLUMN IF NOT EXISTS reporter_latitude         double precision,
  ADD COLUMN IF NOT EXISTS reporter_longitude        double precision,
  ADD COLUMN IF NOT EXISTS reporter_location_source  text,
  ADD COLUMN IF NOT EXISTS reporter_location_precision_m double precision,
  ADD COLUMN IF NOT EXISTS verification_status       text NOT NULL DEFAULT 'unverified'
                            CHECK (verification_status IN ('unverified','in_verification','verified','failed')),
  ADD COLUMN IF NOT EXISTS verified_at               timestamptz,
  ADD COLUMN IF NOT EXISTS tracking_token_hash       text,
  ADD COLUMN IF NOT EXISTS public_status_enabled     boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS structured_facts_json     jsonb,
  ADD COLUMN IF NOT EXISTS citizen_confirmed_at      timestamptz,
  ADD COLUMN IF NOT EXISTS routing_status            text NOT NULL DEFAULT 'unrouted'
                            CHECK (routing_status IN ('unrouted','suggested','confirmed','uncertain','delivered','bounced')),
  ADD COLUMN IF NOT EXISTS reopened_count            int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS citizen_feedback_json     jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS tickets_tracking_token_uidx
  ON tickets(tracking_token_hash) WHERE tracking_token_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS tickets_org_number_idx ON tickets(organization_id, ticket_number);

-- -----------------------------------------------------------------------------
-- 4. Submissions (raw citizen input before it becomes a case)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS submissions (
  id                     uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  citizen_id             uuid REFERENCES citizens(id),
  channel                text NOT NULL DEFAULT 'web'
                         CHECK (channel IN ('web','whatsapp','telegram','email','call','manual')),
  status                 text NOT NULL DEFAULT 'draft'
                         CHECK (status IN ('draft','structured','confirmed','converted','rejected','abandoned')),
  language               text NOT NULL DEFAULT 'te',
  raw_text               text,
  category_hint          text,
  issue_location_text    text,
  issue_latitude         double precision,
  issue_longitude        double precision,
  issue_location_source  text,
  issue_location_precision_m double precision,
  reporter_location_text text,
  reporter_latitude      double precision,
  reporter_longitude     double precision,
  reporter_location_source text,
  reporter_location_precision_m double precision,
  structured_json        jsonb,
  citizen_answers_json   jsonb,
  ai_run_id              uuid,
  ticket_id              uuid REFERENCES tickets(id),
  rejection_reason       text,
  idempotency_key        text,
  confirmed_at           timestamptz,
  created_by_user_id     uuid REFERENCES users(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS submissions_idem_uidx
  ON submissions(organization_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS submissions_citizen_idx ON submissions(citizen_id, created_at DESC);

CREATE TABLE IF NOT EXISTS submission_evidence (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  submission_id   uuid NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  file_name       text NOT NULL,
  storage_path    text NOT NULL,
  mime_type       text,
  file_size_bytes bigint,
  sha256          text,
  captured_at     timestamptz,
  latitude        double precision,
  longitude       double precision,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS submission_evidence_sub_idx ON submission_evidence(submission_id);

ALTER TABLE ticket_attachments
  ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'internal'
    CHECK (visibility IN ('internal','citizen','authority','public')),
  ADD COLUMN IF NOT EXISTS sha256 text,
  ADD COLUMN IF NOT EXISTS provenance text;

-- -----------------------------------------------------------------------------
-- 5. Verification checks (OTP, call, media, field, document)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS verification_checks (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  ticket_id        uuid REFERENCES tickets(id) ON DELETE CASCADE,
  citizen_id       uuid REFERENCES citizens(id),
  method           text NOT NULL CHECK (method IN ('otp','call','media','field','document')),
  status           text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','in_progress','passed','failed','inconclusive','cancelled')),
  mode             text NOT NULL DEFAULT 'manual' CHECK (mode IN ('manual','automated')),
  provider         text,
  provider_ref     text,
  attempt_count    int NOT NULL DEFAULT 0,
  script_json      jsonb,
  checklist_json   jsonb,
  result_json      jsonb,
  transcript       text,
  notes            text,
  assigned_user_id uuid REFERENCES users(id),
  performed_by     uuid REFERENCES users(id),
  ai_run_id        uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz
);
CREATE INDEX IF NOT EXISTS verification_checks_ticket_idx ON verification_checks(ticket_id, created_at DESC);
CREATE INDEX IF NOT EXISTS verification_checks_queue_idx
  ON verification_checks(organization_id, status) WHERE status IN ('pending','in_progress');

-- -----------------------------------------------------------------------------
-- 6. Case events — immutable timeline with visibility
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS case_events (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  ticket_id       uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  task_id         uuid,
  communication_id uuid,
  event_type      text NOT NULL,
  actor_type      text NOT NULL CHECK (actor_type IN ('user','citizen','system','ai_agent','authority','webhook')),
  actor_user_id   uuid REFERENCES users(id),
  actor_citizen_id uuid REFERENCES citizens(id),
  actor_label     text,
  visibility      text NOT NULL DEFAULT 'internal' CHECK (visibility IN ('internal','citizen','public')),
  summary         text,
  language        text NOT NULL DEFAULT 'en',
  reason          text,
  data_json       jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS case_events_ticket_idx ON case_events(ticket_id, created_at);
CREATE INDEX IF NOT EXISTS case_events_org_idx ON case_events(organization_id, created_at DESC);

CREATE OR REPLACE FUNCTION case_events_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'case_events is append-only';
END;
$$;
DROP TRIGGER IF EXISTS case_events_no_update ON case_events;
CREATE TRIGGER case_events_no_update BEFORE UPDATE OR DELETE ON case_events
  FOR EACH ROW EXECUTE FUNCTION case_events_immutable();

-- -----------------------------------------------------------------------------
-- 7. Durable job queue
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS jobs (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  job_type        text NOT NULL,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  status          text NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued','running','succeeded','failed','dead','cancelled')),
  run_at          timestamptz NOT NULL DEFAULT now(),
  attempts        int NOT NULL DEFAULT 0,
  max_attempts    int NOT NULL DEFAULT 5,
  last_error      text,
  result_json     jsonb,
  locked_at       timestamptz,
  locked_by       text,
  idempotency_key text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS jobs_idem_uidx ON jobs(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS jobs_ready_idx ON jobs(run_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS jobs_type_idx ON jobs(job_type, created_at DESC);

-- Stage changes (from any code path) become citizen-visible case events.
CREATE OR REPLACE FUNCTION ticket_stage_history_to_case_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_org uuid;
BEGIN
  SELECT organization_id INTO v_org FROM tickets WHERE id = NEW.ticket_id;
  IF v_org IS NULL THEN RETURN NEW; END IF;
  INSERT INTO case_events (organization_id, ticket_id, event_type, actor_type, actor_user_id,
                           visibility, summary, reason, data_json, created_at)
  VALUES (v_org, NEW.ticket_id, 'status_changed',
          CASE WHEN NEW.system_action OR NEW.changed_by IS NULL THEN 'system' ELSE 'user' END,
          NEW.changed_by, 'citizen', NULL, NEW.change_reason,
          jsonb_build_object('from_stage', NEW.from_stage, 'to_stage', NEW.to_stage,
                             'from_sub_status', NEW.from_sub_status, 'to_sub_status', NEW.to_sub_status),
          NEW.created_at);
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS ticket_stage_history_case_event ON ticket_stage_history;
CREATE TRIGGER ticket_stage_history_case_event AFTER INSERT ON ticket_stage_history
  FOR EACH ROW EXECUTE FUNCTION ticket_stage_history_to_case_event();

-- Citizen-visible events enqueue a notification job (web/email/call cases;
-- telegram/whatsapp tickets keep using the existing citizenNotifier).
CREATE OR REPLACE FUNCTION case_event_enqueue_citizen_notify() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_channel text;
BEGIN
  IF NEW.visibility = 'internal' THEN RETURN NEW; END IF;
  SELECT source_channel INTO v_channel FROM tickets WHERE id = NEW.ticket_id;
  IF v_channel NOT IN ('web','email','call') THEN RETURN NEW; END IF;
  -- Short delay lets related events from the same action land first so the
  -- notifier can collapse them into one message.
  INSERT INTO jobs (organization_id, job_type, payload, idempotency_key, run_at)
  VALUES (NEW.organization_id, 'notify_citizen',
          jsonb_build_object('case_event_id', NEW.id, 'ticket_id', NEW.ticket_id),
          'notify_citizen:' || NEW.id::text, now() + interval '10 seconds')
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS case_event_notify ON case_events;
CREATE TRIGGER case_event_notify AFTER INSERT ON case_events
  FOR EACH ROW EXECUTE FUNCTION case_event_enqueue_citizen_notify();

-- -----------------------------------------------------------------------------
-- 8. AI run traces (AI control plane)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_runs (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  ticket_id       uuid REFERENCES tickets(id) ON DELETE SET NULL,
  submission_id   uuid REFERENCES submissions(id) ON DELETE SET NULL,
  agent           text NOT NULL CHECK (agent IN (
                    'structuring','verification_call','resolution','content','follow_up',
                    'escalation','translation','response_summary','routing')),
  model           text,
  prompt_version  text NOT NULL,
  language        text,
  input_refs_json jsonb,
  output_json     jsonb,
  status          text NOT NULL CHECK (status IN ('succeeded','failed','fallback','invalid_output')),
  confidence      double precision,
  latency_ms      int,
  error           text,
  review_decision text CHECK (review_decision IN ('accepted','edited','rejected')),
  reviewed_by     uuid REFERENCES users(id),
  reviewed_at     timestamptz,
  review_notes    text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_runs_ticket_idx ON ai_runs(ticket_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_runs_agent_idx ON ai_runs(organization_id, agent, created_at DESC);

-- -----------------------------------------------------------------------------
-- 9. Resolution plans + tasks (sub-tasks; one task can serve many cases)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS resolution_plans (
  id                    uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  ticket_id             uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  status                text NOT NULL DEFAULT 'pending_approval'
                        CHECK (status IN ('pending_approval','approved','rejected','superseded')),
  issue_type            text,
  category              text,
  summary               text,
  plan_json             jsonb NOT NULL,
  authority_candidates_json jsonb,
  questions_for_gro_json jsonb,
  ai_run_id             uuid REFERENCES ai_runs(id),
  decided_by            uuid REFERENCES users(id),
  decided_at            timestamptz,
  decision_reason       text,
  created_by            uuid REFERENCES users(id),
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS resolution_plans_ticket_idx ON resolution_plans(ticket_id, created_at DESC);

CREATE TABLE IF NOT EXISTS tasks (
  id                      uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title                   text NOT NULL,
  description             text,
  task_type               text NOT NULL DEFAULT 'general'
                          CHECK (task_type IN ('general','verification','field_visit','contact_authority',
                                               'follow_up','document','citizen_contact','escalation')),
  status                  text NOT NULL DEFAULT 'unassigned'
                          CHECK (status IN ('unassigned','assigned','picked_up','in_progress','on_hold',
                                            'waiting_for_reply','cancelled','closed')),
  owner_user_id           uuid REFERENCES users(id),
  suggested_role          text,
  due_at                  timestamptz,
  sla_paused_at           timestamptz,
  sla_paused_seconds      bigint NOT NULL DEFAULT 0,
  hold_reason             text,
  depends_on_task_id      uuid REFERENCES tasks(id),
  plan_id                 uuid REFERENCES resolution_plans(id),
  authority_contact_id    uuid REFERENCES directory_contacts(id),
  evidence_required_json  jsonb,
  sort_order              int NOT NULL DEFAULT 0,
  created_by              uuid REFERENCES users(id),
  created_by_agent        text,
  cancel_reason           text,
  closed_at               timestamptz,
  closure_note            text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tasks_org_status_idx ON tasks(organization_id, status);
CREATE INDEX IF NOT EXISTS tasks_owner_idx ON tasks(owner_user_id, status);

CREATE TABLE IF NOT EXISTS task_tickets (
  task_id    uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  ticket_id  uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  linked_by  uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, ticket_id)
);
CREATE INDEX IF NOT EXISTS task_tickets_ticket_idx ON task_tickets(ticket_id);

CREATE TABLE IF NOT EXISTS task_status_history (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  task_id     uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  from_status text,
  to_status   text NOT NULL,
  changed_by  uuid REFERENCES users(id),
  actor_type  text NOT NULL DEFAULT 'user',
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS task_status_history_task_idx ON task_status_history(task_id, created_at);

-- -----------------------------------------------------------------------------
-- 10. Authority directory: jurisdiction, escalation chain, freshness
-- -----------------------------------------------------------------------------
ALTER TABLE directory_contacts
  ADD COLUMN IF NOT EXISTS department         text,
  ADD COLUMN IF NOT EXISTS jurisdiction_level text,
  ADD COLUMN IF NOT EXISTS escalation_level   int NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS parent_contact_id  uuid REFERENCES directory_contacts(id),
  ADD COLUMN IF NOT EXISTS whatsapp           text,
  ADD COLUMN IF NOT EXISTS is_public_authority boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS source_id          uuid,
  ADD COLUMN IF NOT EXISTS source_url         text,
  ADD COLUMN IF NOT EXISTS external_ref       text,
  ADD COLUMN IF NOT EXISTS last_verified_at   timestamptz,
  ADD COLUMN IF NOT EXISTS valid_until        timestamptz,
  ADD COLUMN IF NOT EXISTS bounce_count       int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_bounced_at    timestamptz;

ALTER TABLE directory_contacts ALTER COLUMN created_by DROP NOT NULL;

CREATE TABLE IF NOT EXISTS directory_sources (
  id                     uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name                   text NOT NULL,
  url                    text NOT NULL,
  format                 text NOT NULL DEFAULT 'json' CHECK (format IN ('json','csv')),
  field_map_json         jsonb,
  refresh_interval_hours int NOT NULL DEFAULT 168,
  active                 boolean NOT NULL DEFAULT true,
  last_fetched_at        timestamptz,
  last_status            text,
  last_error             text,
  last_stats_json        jsonb,
  created_by             uuid REFERENCES users(id),
  created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS directory_contacts_source_ref_uidx
  ON directory_contacts(source_id, external_ref) WHERE source_id IS NOT NULL AND external_ref IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 11. Communications (drafts, approvals, send, delivery, replies)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS communications (
  id                     uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  ticket_id              uuid REFERENCES tickets(id) ON DELETE CASCADE,
  task_id                uuid REFERENCES tasks(id) ON DELETE SET NULL,
  channel                text NOT NULL CHECK (channel IN ('email','whatsapp','sms','letter','social_post')),
  direction              text NOT NULL DEFAULT 'outbound' CHECK (direction IN ('outbound','inbound')),
  purpose                text NOT NULL DEFAULT 'authority_complaint'
                         CHECK (purpose IN ('authority_complaint','follow_up','escalation','citizen_update',
                                            'information_request','public_post','authority_reply','other')),
  status                 text NOT NULL DEFAULT 'draft'
                         CHECK (status IN ('draft','pending_approval','approved','rejected','queued','sent',
                                           'delivered','bounced','failed','received','superseded')),
  approval_by            text NOT NULL DEFAULT 'staff' CHECK (approval_by IN ('citizen','staff','none')),
  language               text NOT NULL DEFAULT 'en',
  subject                text,
  body                   text,
  translations_json      jsonb,
  recipients_json        jsonb NOT NULL DEFAULT '[]'::jsonb,
  from_address           text,
  reply_to_address       text,
  thread_key             text,
  version                int NOT NULL DEFAULT 1,
  previous_version_id    uuid REFERENCES communications(id),
  in_reply_to_id         uuid REFERENCES communications(id),
  follow_up_of_id        uuid REFERENCES communications(id),
  follow_up_count        int NOT NULL DEFAULT 0,
  next_follow_up_at      timestamptz,
  follow_up_stopped_at   timestamptz,
  escalation_level       int NOT NULL DEFAULT 1,
  ai_run_id              uuid REFERENCES ai_runs(id),
  approved_by_user_id    uuid REFERENCES users(id),
  approved_by_citizen_id uuid REFERENCES citizens(id),
  approved_at            timestamptz,
  rejected_reason        text,
  sent_at                timestamptz,
  delivered_at           timestamptz,
  provider               text,
  provider_message_id    text,
  raw_inbound_json       jsonb,
  summary_json           jsonb,
  created_by_user_id     uuid REFERENCES users(id),
  created_by_citizen_id  uuid REFERENCES citizens(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS communications_ticket_idx ON communications(ticket_id, created_at DESC);
CREATE INDEX IF NOT EXISTS communications_thread_idx ON communications(thread_key);
CREATE INDEX IF NOT EXISTS communications_provider_idx ON communications(provider_message_id);
CREATE INDEX IF NOT EXISTS communications_followup_idx
  ON communications(next_follow_up_at) WHERE next_follow_up_at IS NOT NULL AND follow_up_stopped_at IS NULL;
CREATE INDEX IF NOT EXISTS communications_approval_idx
  ON communications(organization_id, status) WHERE status = 'pending_approval';

CREATE TABLE IF NOT EXISTS communication_events (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  communication_id  uuid NOT NULL REFERENCES communications(id) ON DELETE CASCADE,
  event_type        text NOT NULL CHECK (event_type IN ('created','edited','submitted','approved','rejected',
                       'queued','sent','delivered','bounced','complaint','failed','reply_received')),
  provider          text,
  provider_event_id text,
  actor_user_id     uuid REFERENCES users(id),
  actor_citizen_id  uuid REFERENCES citizens(id),
  data_json         jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS communication_events_comm_idx ON communication_events(communication_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS communication_events_provider_uidx
  ON communication_events(provider, provider_event_id) WHERE provider_event_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 12. Escalations (to GRO internally, or to higher authority externally)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS escalations (
  id                 uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  ticket_id          uuid REFERENCES tickets(id) ON DELETE CASCADE,
  task_id            uuid REFERENCES tasks(id) ON DELETE SET NULL,
  communication_id   uuid REFERENCES communications(id) ON DELETE SET NULL,
  target             text NOT NULL CHECK (target IN ('gro','authority')),
  level              int NOT NULL DEFAULT 1,
  trigger_type       text NOT NULL CHECK (trigger_type IN ('sla_breach','no_reply','bounce','ai_uncertain',
                                                            'citizen_reopen','manual','task_overdue')),
  reason             text NOT NULL,
  target_contact_id  uuid REFERENCES directory_contacts(id),
  status             text NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','resolved','dismissed')),
  created_by_agent   text,
  created_by         uuid REFERENCES users(id),
  handled_by         uuid REFERENCES users(id),
  handled_at         timestamptz,
  resolution_note    text,
  dedupe_key         text,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS escalations_dedupe_uidx
  ON escalations(dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('open','acknowledged');
CREATE INDEX IF NOT EXISTS escalations_open_idx ON escalations(organization_id, status, created_at DESC);

-- -----------------------------------------------------------------------------
-- 13. Translation cache (instant vernacular switching on dynamic content)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS translation_cache (
  source_hash     text NOT NULL,
  target_language text NOT NULL,
  translated_text text NOT NULL,
  model           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_hash, target_language)
);

-- -----------------------------------------------------------------------------
-- 14. Political feed
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS feed_sources (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name             text NOT NULL,
  url              text NOT NULL,
  kind             text NOT NULL DEFAULT 'rss' CHECK (kind IN ('rss','atom','json','link')),
  language         text,
  active           boolean NOT NULL DEFAULT true,
  refresh_minutes  int NOT NULL DEFAULT 30,
  last_fetched_at  timestamptz,
  last_status      text,
  last_error       text,
  created_by       uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, url)
);

CREATE TABLE IF NOT EXISTS feed_items (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source_id       uuid REFERENCES feed_sources(id) ON DELETE CASCADE,
  guid            text NOT NULL,
  title           text NOT NULL,
  link            text,
  summary         text,
  image_url       text,
  language        text,
  published_at    timestamptz,
  pinned          boolean NOT NULL DEFAULT false,
  hidden          boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, guid)
);
CREATE INDEX IF NOT EXISTS feed_items_org_idx ON feed_items(organization_id, published_at DESC);
