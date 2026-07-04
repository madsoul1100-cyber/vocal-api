# Dashboard web charts (Leadership UI)

Filtered chart endpoints for the Flutter web leadership dashboard. All charts under
`/v2/dashboard/web/*` share the same filter contract.

## Ticket → territory resolution

Charts filter on **`tickets.territory_id`** — the ward/mandal/district node stored on the
ticket at intake (or set later via `territoryResolveService`). A ticket matches when:

| `include_descendants` | Match rule |
|----------------------|------------|
| `true` (default) | `territory_id` is the selected node **or any descendant** in the territory tree |
| `false` | `territory_id` **equals** the selected node exactly |

**Whole-state default** (no `territory_id`): uses the org state root (Telangana) subtree **and**
includes tickets with `territory_id IS NULL` (not yet geocoded).

**District leader** without `territory_id`: counts only tickets in their assigned territories
(and descendants). Out-of-scope `territory_id` → `403`.

**Dates:** `created_at` inclusive in UTC — `from` 00:00:00.000Z through `to` 23:59:59.999Z.
All stages included (open + closed).

## Roles

Read-only — same as territory cascade filters:

- `super_admin`, `central_support`, `state_leader` — full state tree
- `district_leader` — scoped to assigned territories

Others → `403`.

---

## Chart 1: Tickets by category (donut)

```
GET /v2/dashboard/web/charts/ticket-categories
Authorization: Bearer <token>
```

### Query parameters

| Param | Required | Default | Notes |
|-------|----------|---------|-------|
| `from` | **Yes** | — | `YYYY-MM-DD` inclusive start |
| `to` | **Yes** | — | `YYYY-MM-DD` inclusive end |
| `territory_id` | No | state root | District/mandal UUID from picker |
| `include_descendants` | No | `true` | Subtree vs exact node |
| `limit` | No | `8` | Max category segments before **Other** bucket (max 20) |

**400** if `from`/`to` missing/invalid, `from > to`, or `parent_id` is sent (use `territory_id`).

### Grouping

- **Top-level category only** (`issue_categories.level = 1`), resolved from `category_id` /
  `subcategory_id`.
- Missing category → segment `uncategorized` / `Uncategorized`.
- Top `limit` categories by count; remainder → `other` / `Other`.
- Percents calculated server-side (one decimal).

### Example requests

Whole state, July 2026:

```bash
curl -sS -H "Authorization: Bearer $TOKEN" \
  "$BASE/v2/dashboard/web/charts/ticket-categories?from=2026-07-01&to=2026-07-31"
```

Hyderabad district + descendants:

```bash
curl -sS -H "Authorization: Bearer $TOKEN" \
  "$BASE/v2/dashboard/web/charts/ticket-categories?territory_id=<district-uuid>&include_descendants=true&from=2026-06-15&to=2026-07-04"
```

Single mandal only:

```bash
curl -sS -H "Authorization: Bearer $TOKEN" \
  "$BASE/v2/dashboard/web/charts/ticket-categories?territory_id=<mandal-uuid>&include_descendants=false&from=2026-07-01&to=2026-07-31"
```

### Sample response

```json
{
  "chart_type": "donut",
  "dimension": "ticket_category",
  "title": "Tickets by category",
  "total": 142,
  "segments": [
    { "key": "municipal_and_civic_services", "label": "Municipal and Civic Services", "count": 45, "percent": 31.7 },
    { "key": "public_infrastructure", "label": "Public Infrastructure", "count": 32, "percent": 22.5 },
    { "key": "other", "label": "Other", "count": 37, "percent": 26.1 },
    { "key": "uncategorized", "label": "Uncategorized", "count": 28, "percent": 19.7 }
  ],
  "meta": {
    "organization_id": "uuid",
    "generated_at": "2026-07-04T10:30:00Z",
    "filters": {
      "territory_id": "uuid-district-hyd",
      "territory_name": "Hyderabad",
      "territory_level": "district",
      "include_descendants": true,
      "from": "2026-07-01",
      "to": "2026-07-31",
      "limit": 8
    },
    "scope": { "role": "state_leader", "auto_scoped_territory_id": null }
  }
}
```

Empty (`total: 0`): `segments: []` — Flutter shows “No category data yet.”

### Fixture / seed data for local testing

1. Run `npm run seed:territories` (Telangana tree).
2. Create tickets via API or intake with:
   - `created_at` in your test date range
   - `territory_id` set to a known district/mandal UUID
   - `category_id` pointing at a level-1 `issue_categories` row (seeded in `schema.sql`)

Example SQL (adjust org + territory UUIDs):

```sql
INSERT INTO tickets (
  organization_id, ticket_number, source_channel, stage, sub_status,
  category_id, territory_id, created_at
) VALUES
  ('YOUR_ORG_ID', 'TST-2026-0001', 'manual', 'to_do', 'new_awaiting_triage',
   '10000000-0000-0000-0000-000000000005', '<hyderabad-district-uuid>', '2026-07-10T12:00:00Z'),
  ('YOUR_ORG_ID', 'TST-2026-0002', 'manual', 'closed', 'closed_resolved',
   '10000000-0000-0000-0000-000000000006', '<hyderabad-district-uuid>', '2026-07-15T12:00:00Z');
```

Then:

```bash
curl -sS -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3001/v2/dashboard/web/charts/ticket-categories?territory_id=<hyderabad-district-uuid>&from=2026-07-01&to=2026-07-31"
```

Expect segments for **Municipal and Civic Services** and **Public Infrastructure** (or your chosen categories).
