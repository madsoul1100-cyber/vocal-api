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
