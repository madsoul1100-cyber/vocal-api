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

**Stage snapshot (region chart):** stacked bar segments use each ticket's **current** `stage`
at query time among tickets **created** in the date range.

**Null territory:** category chart includes null-territory tickets for whole-state views;
region chart **excludes** them from ranking (no “Unassigned” bar in v1).

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

---

## Chart 2: Top regions by tickets (stacked bar)

```
GET /v2/dashboard/web/charts/tickets-by-region-stage
Authorization: Bearer <token>
```

### Query parameters

Same filter contract as Chart 1 (`from`, `to`, `territory_id`, `include_descendants`).

| Param | Required | Default | Notes |
|-------|----------|---------|-------|
| `limit` | No | `5` | Max bars on X-axis (max 10) |

### X-axis “region” level

| User selection | Bars rank at |
|----------------|--------------|
| No `territory_id` (whole state) | **District** — top 5 districts statewide |
| `territory_id` = district | **Mandal** — top 5 mandals in that district |
| `territory_id` = mandal | **Ward** — top 5 wards under that mandal |

Ranked by total ticket count (sum of stage stacks) descending.

### Stack segments

Current ticket `stage`: `to_do`, `in_progress`, `on_hold`, `closed` (unknown → `to_do`).
All four segments appear on every bar (count may be 0).

### Example requests

Whole state, top 5 districts:

```bash
curl -sS -H "Authorization: Bearer $TOKEN" \
  "$BASE/v2/dashboard/web/charts/tickets-by-region-stage?from=2026-07-01&to=2026-07-31&limit=5"
```

Hyderabad district — top 5 mandals:

```bash
curl -sS -H "Authorization: Bearer $TOKEN" \
  "$BASE/v2/dashboard/web/charts/tickets-by-region-stage?territory_id=<district-uuid>&include_descendants=true&from=2026-07-01&to=2026-07-31"
```

### Sample response

```json
{
  "chart_type": "stacked_bar",
  "dimension": "ticket_stage",
  "territory_level": "district",
  "title": "Top regions by tickets",
  "total": 142,
  "segment_order": ["to_do", "in_progress", "on_hold", "closed"],
  "categories": [
    {
      "territory_id": "uuid-hyd",
      "label": "Hyderabad",
      "level": "district",
      "total": 48,
      "segments": [
        { "key": "to_do", "label": "To do", "count": 8 },
        { "key": "in_progress", "label": "In progress", "count": 22 },
        { "key": "on_hold", "label": "On hold", "count": 6 },
        { "key": "closed", "label": "Closed", "count": 12 }
      ]
    }
  ],
  "meta": {
    "organization_id": "uuid",
    "generated_at": "2026-07-05T12:00:00Z",
    "filters": {
      "territory_id": null,
      "territory_name": null,
      "territory_level": null,
      "include_descendants": true,
      "from": "2026-07-01",
      "to": "2026-07-31",
      "limit": 5
    },
    "scope": { "role": "state_leader", "auto_scoped_territory_id": null }
  }
}
```

Empty: `200` with `categories: []`, `total: 0`.

### Fixture / seed data

Create tickets across **multiple districts** and **stages** with `created_at` in range and
`territory_id` set to ward/mandal nodes under those districts:

```sql
INSERT INTO tickets (
  organization_id, ticket_number, source_channel, stage, sub_status,
  territory_id, created_at
) VALUES
  ('YOUR_ORG_ID', 'TST-RS-001', 'manual', 'to_do', 'new_awaiting_triage',
   '<hyderabad-ward-uuid>', '2026-07-10T12:00:00Z'),
  ('YOUR_ORG_ID', 'TST-RS-002', 'manual', 'in_progress', 'in_progress_active',
   '<hyderabad-ward-uuid>', '2026-07-12T12:00:00Z'),
  ('YOUR_ORG_ID', 'TST-RS-003', 'manual', 'closed', 'closed_resolved',
   '<rangareddy-ward-uuid>', '2026-07-15T12:00:00Z');
```

Then call the whole-state endpoint and expect up to 5 district bars with stacked stage counts.

---

## Chart 3: Ground worker leaderboard

```
GET /v2/dashboard/web/charts/worker-leaderboard
Authorization: Bearer <token>
```

### Query parameters

Same territory/date filters as other web charts, plus:

| Param | Required | Default | Notes |
|-------|----------|---------|-------|
| `metric` | No | `overall` | `overall` \| `assigned` \| `resolved` \| `pending` |
| `limit` | No | `10` | Max rows (max 20) |

### Metric definitions

All metrics use the **same territory filter** as other dashboard charts.

| Metric | Definition |
|--------|------------|
| **assigned** | Distinct tickets **created** in `[from, to]` + territory, where the worker was **accepted/force-assigned** and `COALESCE(responded_at, offered_at)` is in `[from, to]` |
| **resolved** | Tickets **created** in range + territory, **closed** in `[from, to]`, `owner_user_id` = worker at close |
| **pending** | **Current** open tickets (`stage <> closed`) owned by worker, territory scoped only (no `created_at` filter) |
| **overall** | Returns all three counts per worker; sorted **resolved ↓, assigned ↓, pending ↑** |

Only **ground_worker** role users appear.

### Sorting by `metric`

| `metric` | Sort |
|----------|------|
| `overall` | resolved ↓, assigned ↓, pending ↑ |
| `assigned` | assigned ↓ |
| `resolved` | resolved ↓ |
| `pending` | pending ↓ |

### Example requests

```bash
# Overall tab, June 2026, whole state
curl -sS -H "Authorization: Bearer $TOKEN" \
  "$BASE/v2/dashboard/web/charts/worker-leaderboard?from=2026-06-01&to=2026-06-30&metric=overall&limit=10"

# Most resolved tab
curl -sS -H "Authorization: Bearer $TOKEN" \
  "$BASE/v2/dashboard/web/charts/worker-leaderboard?from=2026-06-01&to=2026-06-30&metric=resolved&limit=5"
```

### Sample response

```json
{
  "chart_type": "leaderboard",
  "metric": "overall",
  "title": "Ground worker leaderboard",
  "entries": [
    {
      "worker_id": "uuid",
      "name": "Rajesh Kumar",
      "avatar_url": null,
      "assigned": 48,
      "resolved": 41,
      "pending": 7
    }
  ],
  "meta": {
    "organization_id": "uuid",
    "generated_at": "2026-07-05T12:00:00Z",
    "filters": {
      "territory_id": null,
      "territory_name": null,
      "territory_level": null,
      "include_descendants": true,
      "from": "2026-06-01",
      "to": "2026-06-30",
      "limit": 10,
      "metric": "overall"
    },
    "scope": { "role": "state_leader", "auto_scoped_territory_id": null }
  }
}
```

Empty: `200` with `entries: []`.
