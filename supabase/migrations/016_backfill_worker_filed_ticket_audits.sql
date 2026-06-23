-- Backfill missing worker_filed_ticket audit rows for historical manual intake.
-- Safe to re-run: skips tickets that already have worker_filed_ticket.

INSERT INTO audit_logs (
  organization_id,
  event_type,
  entity_type,
  entity_id,
  actor_type,
  actor_user_id,
  new_value_json,
  metadata_json,
  created_at
)
SELECT
  src.organization_id,
  'worker_filed_ticket',
  'ticket',
  src.ticket_id,
  'user',
  src.actor_user_id,
  jsonb_build_object(
    'ticket_number', src.ticket_number,
    'citizen_id', src.citizen_id::text,
    'needs_triage', COALESCE(t.needs_triage, true),
    'backfilled', true
  ),
  jsonb_build_object('backfill_source', src.source, 'backfilled_at', now()),
  src.created_at
FROM (
  WITH missing AS (
    SELECT t.id AS ticket_id
    FROM tickets t
    WHERE t.source_channel = 'manual'
      AND NOT EXISTS (
        SELECT 1 FROM audit_logs wft
        WHERE wft.entity_type = 'ticket'
          AND wft.entity_id = t.id
          AND wft.event_type = 'worker_filed_ticket'
      )
  ),
  from_created AS (
    SELECT DISTINCT ON (al.entity_id)
      al.entity_id AS ticket_id,
      al.organization_id,
      al.actor_user_id,
      al.created_at,
      t.ticket_number,
      t.citizen_id,
      'ticket_created'::text AS source
    FROM audit_logs al
    INNER JOIN tickets t ON t.id = al.entity_id
    INNER JOIN missing m ON m.ticket_id = al.entity_id
    WHERE al.event_type = 'ticket_created'
      AND al.entity_type = 'ticket'
      AND al.actor_user_id IS NOT NULL
      AND COALESCE((al.new_value_json->>'filed_by_worker')::boolean, false) = true
    ORDER BY al.entity_id, al.created_at ASC
  ),
  from_history AS (
    SELECT DISTINCT ON (tsh.ticket_id)
      tsh.ticket_id,
      t.organization_id,
      tsh.changed_by AS actor_user_id,
      tsh.created_at,
      t.ticket_number,
      t.citizen_id,
      'stage_history'::text AS source
    FROM ticket_stage_history tsh
    INNER JOIN tickets t ON t.id = tsh.ticket_id
    INNER JOIN missing m ON m.ticket_id = tsh.ticket_id
    WHERE tsh.changed_by IS NOT NULL
      AND (
        tsh.change_reason ILIKE '%filed by worker%'
        OR tsh.change_reason ILIKE '%field intake%'
      )
      AND NOT EXISTS (SELECT 1 FROM from_created fc WHERE fc.ticket_id = tsh.ticket_id)
    ORDER BY tsh.ticket_id, tsh.created_at ASC
  )
  SELECT * FROM from_created
  UNION ALL
  SELECT * FROM from_history
) src
INNER JOIN tickets t ON t.id = src.ticket_id
WHERE NOT EXISTS (
  SELECT 1 FROM audit_logs wft
  WHERE wft.entity_type = 'ticket'
    AND wft.entity_id = src.ticket_id
    AND wft.event_type = 'worker_filed_ticket'
);
