# vocal-api

Express backend for My Leader. Migrated from the Next.js monolith (`vocal-app`).

## Local development

```bash
cd vocal-api
cp .env.example .env.local
# Fill DATABASE_URL (PostgreSQL/RDS), CLERK_SECRET_KEY, CLERK_PUBLISHABLE_KEY, ORG_ID
# See DATABASE.md for RDS setup and migrations

npm install
npm run dev
```

API runs at **http://localhost:3001**

| Version | Base path | Source |
|---------|-----------|--------|
| v1 | `/v1/*` | `src/routes/v1/` (stable for existing clients) |
| v2 | `/v2/*` | `src/routes/v2/` (copy of v1; evolve response shapes here) |

Business logic stays in `src/services/` — both versions call the same services until you fork behavior.

### v2 directory (paginated)

`GET /v2/directory` — v1 unchanged; v2 adds pagination and filters.

| Query param | Description |
|-------------|-------------|
| `limit` | Page size (default `20`, max `100`) |
| `offset` | Rows to skip (default `0`) |
| `keyword` or `search` | Search name, org, role, email, phone |
| `category` | Filter by `directory_contact_tags` where `tag_type=category` (partial match) |
| `status` | `verified`, `unverified`, `outdated`, or `all` |

Response includes `pagination` (`limit`, `offset`, `total`, `hasNextPage`, `hasPreviousPage`), `filters`, and each contact has a `categories` array.

### v2 tickets (paginated)

`GET /v2/tickets` — v1 unchanged; v2 adds pagination, sort, and SLA filters.

| Query param | Description |
|-------------|-------------|
| `limit` | Page size (default `20`, max `100`) |
| `offset` | Rows to skip (default `0`) |
| `sort` | `created` (default), `updated`, or `accepted` |
| `order` | `asc` or `desc` (default `desc`) |
| `keyword` or `search` | Search title, issue text, ticket number |
| `stage` | `to_do`, `in_progress`, `on_hold`, `closed` |
| `severity` | `critical`, `high`, `medium`, `low` |
| `needs_triage` | `true` / `false` |
| `has_location` | `true` / `false` |
| `critical` | `true` / `false` |
| `owner_id` | Filter by owner user UUID |
| `sla_breached` | `true` / `false` — `sla_breached_flag` |
| `sla_first_contact_overdue` | `true` — first-contact due passed, not contacted |
| `sla_resolution_overdue` | `true` — resolution due passed, not closed |
| `sla_at_risk` | `true` — SLA due within 24h, not breached, still open |

Response includes `pagination` and echoed `filters` (same shape as v2 directory).

| Endpoint | Description |
|----------|-------------|
| `GET /v2/tickets/:id` | Ticket detail; includes `citizen_identity` (PII when role allows) and `has_pending_ai_suggestion` (`true` only for central support / super admin while `needs_triage` is true — skip `GET .../ai-suggestion` when `false`) |
| `GET /v2/tickets/:id/ai-suggestion` | Pending AI suggestion (`super_admin` / `central_support` only; latest completed, unconfirmed, or `null`) |
| `POST /v2/tickets/confirm-ai` | Apply AI suggestion to empty ticket fields; body `{ ticket_id, suggestion_id }`; same roles only |

AI suggestions are created asynchronously when a citizen files via Telegram (`telegramFlow` → OpenRouter → `ai_ticket_suggestions`). Clients should use these v2 endpoints rather than querying `ai_ticket_suggestions` directly.

Backfill for an existing ticket (requires `OPENROUTER_API_KEY` in `.env.local`):

```bash
npm run generate:ai-suggestion -- <ticket-uuid>
npm run generate:ai-suggestion -- <ticket-uuid> --force   # if a pending row already exists
```

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Health check (`auth: clerk`) |
| `GET /v1/auth/me` | Current user (Clerk Bearer token) |
| `GET /v1/me` | Same as `/v1/auth/me` (compat) |
| `GET /v1/tickets` | Ticket list |
| `GET /v1/tickets/:id` | Ticket detail |
| `POST /webhooks/telegram` | Citizen bot webhook |
| `POST /webhooks/telegram-worker` | Worker bot webhook |

## Auth

Uses `@clerk/express` — same Clerk app as the monolith. Resolves `users.clerk_user_id` for staff profiles.

`POST /v1/auth/login` (JWT/password) is **not** used in the Clerk setup.

### Local dev without Clerk (`npm run dev`)

`npm run dev` sets `NODE_ENV=development`, which **bypasses Clerk** on all `/v1/*` and `/v2/*` routes. Requests work without a Bearer token; the API impersonates a user from the DB (`DEV_USER_ID`, else first `super_admin` in `ORG_ID`, else any active user).

- Disable: `DEV_BYPASS_AUTH=false` in `.env.local`
- Force on (e.g. `npm start`): `DEV_BYPASS_AUTH=true` (never in production)
- Pick user: `DEV_USER_ID=<uuid>`

`GET /health` returns `"auth": "dev-bypass"` when this mode is active.

### CORS (Flutter web / vocal-web)

In development, any `http://localhost:<port>` and `http://127.0.0.1:<port>` origin is allowed (e.g. Flutter `flutter run -d chrome`).

Defaults also include `http://localhost:5173`, `3000`, and `8080`. Add more in `.env.local`:

```bash
CORS_ORIGINS=http://localhost:8080,http://localhost:54321
```

## Telegram webhook (local)

Use a tunnel (cloudflared / ngrok) pointing to port 3001:

```
https://<tunnel>/webhooks/telegram
https://<tunnel>/webhooks/telegram-worker
```

## Pair with vocal-web

Start **vocal-api** on `:3001` and **vocal-web** on `:5173`. See `../LOCAL_DEV.md`.
