-- Migration 005: Campaign tones for Amplify
--
-- Widens the CHECK constraint on amplify_generated_outputs.tone to include
-- the three campaign/escalation tones added in the Amplify prompt rewrite:
--   activist, opposition, public_shame
--
-- Safe to re-run — drops the old constraint if present before re-adding.

alter table amplify_generated_outputs
  drop constraint if exists amplify_generated_outputs_tone_check;

alter table amplify_generated_outputs
  add constraint amplify_generated_outputs_tone_check
  check (
    tone is null
    or tone in (
      'informative',
      'urgent',
      'formal',
      'empathetic',
      'neutral',
      -- campaign / escalation tones
      'activist',
      'opposition',
      'public_shame'
    )
  );
