-- =============================================================================
-- Migration 006: Intake conversation version flag
-- =============================================================================
--
-- Adds a per-org switch to choose which intake engine runs in the citizen
-- Telegram webhook:
--   • 'v1' — the original rigid state machine (telegramFlow.ts).
--           Asks: issue → media → location → confirm → file.
--           Predictable, no LLM dependency.
--   • 'v2' — the new LLM-driven conversation manager
--           (services/intakeConversationManager.ts).
--           Telugu / Tinglish / English fluent, multimodal-aware, civic-scope
--           filter, conversational follow-ups.
--
-- Default 'v1' so existing demo behavior is unchanged. SuperAdmin flips to
-- 'v2' through the /admin/intake-settings UI when ready.
-- =============================================================================

alter table organization_settings
  add column if not exists intake_conversation_version text not null default 'v1';

alter table organization_settings
  drop constraint if exists organization_settings_intake_version_check;

alter table organization_settings
  add constraint organization_settings_intake_version_check
  check (intake_conversation_version in ('v1', 'v2'));

-- Backfill: existing rows get the default ('v1') automatically thanks to the
-- DEFAULT clause above. No explicit UPDATE needed.

comment on column organization_settings.intake_conversation_version is
  'Which citizen-intake engine to run in the Telegram webhook: v1 = rigid state machine, v2 = LLM conversation manager.';
