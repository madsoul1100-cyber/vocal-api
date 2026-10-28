# Single-instance stack (one server, one start)

Yes — you can run **everything on one machine** (laptop or one EC2). You do **not** need separate servers for Dify / OpenClaw / workers for the first production cut.

## What “workers” means here

`vocal-api` already starts the **Bharosa jobs worker inside the same process** when `DATABASE_URL` is set:

```text
npm run dev / node dist
   ├─ HTTP API (:3001)
   └─ jobs worker (email, tickets, etc.)   ← same instance, not a second service
```

So you do **not** run a separate “worker query” for that. One API process = API + workers.

## One command

From repo root:

```bash
chmod +x scripts/start-agent-stack.sh
./scripts/start-agent-stack.sh start    # Dify + OpenClaw + API/worker
./scripts/start-agent-stack.sh status
./scripts/start-agent-stack.sh stop
```

| Process | How it runs on that instance |
|---|---|
| **Dify** | Docker Compose in `dify/docker` |
| **OpenClaw** | Host CLI `openclaw gateway :18789` (needs Node 26 on PATH) |
| **vocal-api + jobs worker** | `npm run dev` (or `npm start` in prod) |
| **Postgres** | Your RDS (or local Postgres) — not required to be on same box |

Logs: `my-leader/.agent-stack-logs/`

## Env on that same box (`vocal-api/.env.local` or prod env)

```bash
# Loopback — all on one machine
BHAROSA_DIFY_ENABLED=true
DIFY_API_BASE=http://127.0.0.1/v1
DIFY_APP_INTAKE_KEY=app-...
DIFY_INTAKE_MODE=chat

BHAROSA_COMPANION=openclaw
BHAROSA_MCP_TOKEN=...
OPENCLAW_GATEWAY_URL=http://127.0.0.1:18789
OPENCLAW_GATEWAY_TOKEN=...

JOBS_WORKER_ENABLED=true
JOBS_SCHEDULER_ENABLED=true
```

## Single EC2 sizing (practical)

| RAM | Fits |
|---|---|
| **4 GB** | Tight — API + OpenClaw; Dify may struggle |
| **8 GB** | Comfortable — API + worker + Dify + OpenClaw |
| **16 GB** | Safe for demos + light prod |

Open ports to the world: **only** API `3001` (or 443 via nginx). Keep Dify/OpenClaw on **127.0.0.1**.

## “One query” vs “one command”

| Ask | Answer |
|---|---|
| One **SQL** query to start all services? | No — SQL only creates tables (`023_citizen_guide_memory.sql`). Services need a start script/compose. |
| One **migration** for memory tables? | Yes: `npm run db:migrate -- 023_citizen_guide_memory.sql` |
| One **shell command** for the stack? | Yes: `./scripts/start-agent-stack.sh start` |
| Separate worker server? | Not required — worker is in the API process |

## Prod systemd (optional, single instance)

Three units on one EC2: `dify` (docker compose), `openclaw`, `vocal-api`. Or call the start script from `@reboot` cron. Prefer systemd for restarts.

## What you still do once by hand

1. First-time Dify admin + publish Chatflow + copy `app-` key  
2. First-time OpenClaw onboard + gateway token  
3. Run DB migrations once  

After that: **one `start` command** brings the stack up on that instance.
