/**
 * Hand-written SQL for PostgREST-style embedded selects used in vocal-api.
 */

export function sqlForUserWithRelations(whereSql: string): string {
  return `
    SELECT
      u.*,
      to_jsonb(r) AS roles,
      jsonb_build_object('name', o.name) AS organizations
    FROM users u
    INNER JOIN roles r ON r.id = u.role_id
    INNER JOIN organizations o ON o.id = u.organization_id
    WHERE ${whereSql}
  `
}

export const SQL_TICKET_LIST = `
  SELECT
    t.id, t.ticket_number, t.title, t.original_issue_text, t.stage, t.sub_status, t.severity,
    t.critical_flag, t.needs_triage, t.anonymous_flag, t.location_text, t.latitude, t.longitude,
    t.created_at, t.updated_at, t.accepted_at,
    t.sla_first_contact_due_at, t.sla_resolution_due_at, t.sla_breached_flag,
    CASE WHEN tr.id IS NOT NULL THEN jsonb_build_object('id', tr.id, 'name', tr.name) END AS territories,
    CASE WHEN ow.id IS NOT NULL THEN jsonb_build_object('id', ow.id, 'full_name', ow.full_name) END AS users,
    CASE WHEN ic.id IS NOT NULL THEN jsonb_build_object('id', ic.id, 'name', ic.name) END AS issue_categories
  FROM tickets t
  LEFT JOIN territories tr ON tr.id = t.territory_id
  LEFT JOIN users ow ON ow.id = t.owner_user_id
  LEFT JOIN issue_categories ic ON ic.id = t.category_id
`

export const SQL_TICKET_DETAIL = `
  SELECT
    t.*,
    CASE WHEN cat.id IS NOT NULL THEN jsonb_build_object('id', cat.id, 'name', cat.name) END AS category,
    CASE WHEN sub.id IS NOT NULL THEN jsonb_build_object('id', sub.id, 'name', sub.name) END AS subcategory,
    CASE WHEN ow.id IS NOT NULL THEN jsonb_build_object('id', ow.id, 'full_name', ow.full_name) END AS owner,
    CASE WHEN tr.id IS NOT NULL THEN jsonb_build_object('id', tr.id, 'name', tr.name) END AS territories
  FROM tickets t
  LEFT JOIN issue_categories cat ON cat.id = t.category_id
  LEFT JOIN issue_categories sub ON sub.id = t.subcategory_id
  LEFT JOIN users ow ON ow.id = t.owner_user_id
  LEFT JOIN territories tr ON tr.id = t.territory_id
`

export const SQL_TICKET_STAGE_HISTORY = `
  SELECT
    h.id, h.ticket_id, h.from_stage, h.to_stage, h.from_sub_status, h.to_sub_status,
    h.changed_by, h.change_reason, h.system_action, h.created_at,
    CASE WHEN u.id IS NOT NULL THEN jsonb_build_object('id', u.id, 'full_name', u.full_name) END AS changed_by_user
  FROM ticket_stage_history h
  LEFT JOIN users u ON u.id = h.changed_by
`

/** Full staff row for GET/PATCH /workers/:id (edit form). */
export const SQL_WORKER_DETAIL = `
  SELECT
    u.id,
    u.full_name,
    u.phone,
    u.email,
    u.active,
    u.approved_at,
    u.last_login_at,
    u.created_at,
    u.role_id,
    u.clerk_user_id,
    u.notes,
    u.image_url,
    u.kyc_documents,
    jsonb_build_object('name', r.name, 'display_name', r.display_name) AS roles,
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'territory_id', ut.territory_id,
          'is_primary', ut.is_primary,
          'territories', CASE
            WHEN tr.id IS NOT NULL THEN jsonb_build_object('id', tr.id, 'name', tr.name)
            ELSE NULL
          END
        )
      ) FILTER (WHERE ut.territory_id IS NOT NULL),
      '[]'::jsonb
    ) AS user_territories
  FROM users u
  INNER JOIN roles r ON r.id = u.role_id
  LEFT JOIN user_territories ut ON ut.user_id = u.id
  LEFT JOIN territories tr ON tr.id = ut.territory_id
`

export const SQL_WORKERS_WITH_TERRITORIES = `
  SELECT
    u.id, u.full_name,
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'territory_id', ut.territory_id,
          'territories', jsonb_build_object(
            'id', tr.id,
            'centroid_lat', tr.centroid_lat,
            'centroid_lng', tr.centroid_lng
          )
        )
      ) FILTER (WHERE ut.id IS NOT NULL),
      '[]'::jsonb
    ) AS user_territories
  FROM users u
  LEFT JOIN user_territories ut ON ut.user_id = u.id
  LEFT JOIN territories tr ON tr.id = ut.territory_id
`
