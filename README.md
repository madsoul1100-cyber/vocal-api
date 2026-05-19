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

## Telegram webhook (local)

Use a tunnel (cloudflared / ngrok) pointing to port 3001:

```
https://<tunnel>/webhooks/telegram
https://<tunnel>/webhooks/telegram-worker
```

## Pair with vocal-web

Start **vocal-api** on `:3001` and **vocal-web** on `:5173`. See `../LOCAL_DEV.md`.
