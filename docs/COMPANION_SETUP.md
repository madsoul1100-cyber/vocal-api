# Phase 2 — OpenClaw + citizen Guide memory

**Decision:** companion = **OpenClaw**. Hermes is not in the active stack.

## How it fits

| Layer | Role |
|---|---|
| **Guide chat** (`vocal-api`) | Citizen talks to Priya. Source of truth for cases + memory. |
| **`citizen_guide_memory`** | Persistent profile for **logged-in** citizens (problems, areas, behavior). |
| **OpenClaw Gateway** (optional) | Staff companion + optional `memory_search` / remember enrichment. |

Citizens never chat through OpenClaw directly. Logged-in Guide sessions pass the citizen JWT; memory is loaded and updated every turn.

## Citizen memory (wired)

- Migration: `023_citizen_guide_memory.sql`
- `guide_sessions.citizen_id` links chats to the citizen
- On each Guide turn (when logged in):
  1. Load / bootstrap memory from past Guide chats + tickets
  2. Optionally enrich via OpenClaw `memory_search` if gateway env is set
  3. Prefill name / phone / email / last area
  4. Inject a short memory block into the answer prompt (does **not** force the old topic)
  5. Persist events (problem, topic switch, desk help, etc.)
- Welcome line for returning users: continue last open issue **or** start new

## Security (required)

1. Sandbox tool execution **on** (Docker) for OpenClaw.  
2. Allowlist: only our HTTP/MCP tools — no unrestricted shell in prod.  
3. Auth: `BHAROSA_MCP_TOKEN` on every companion call.  
4. Staff allowlist only (Telegram/WhatsApp user IDs).  
5. Never give the companion raw DB credentials.  
6. Gateway token is **operator-level** — loopback / private only.

## HTTP API (wired)

Base: `http://127.0.0.1:<API_PORT>/v2/companion`

| Method | Path | Purpose |
|---|---|---|
| GET | `/tools` | List tool catalogue |
| GET | `/cases?limit=10` | Open tickets |
| GET | `/cases/:ticketNumber` | One ticket |
| GET | `/drafts?phone=` | Open guide drafts |
| GET | `/memory/:citizenId` | Persistent citizen Guide memory |
| POST | `/nudge/propose` | Draft nudge text (does not send) |

Headers: `Authorization: Bearer <BHAROSA_MCP_TOKEN>`, `X-Org-Id: <uuid>`

Skill stub: `docs/openclaw/bharosa-companion.SKILL.md`

## Env

```bash
BHAROSA_COMPANION=openclaw
BHAROSA_MCP_TOKEN=<shared secret for companion → vocal-api>

# Optional — enable OpenClaw Gateway enrichment for Guide
OPENCLAW_GATEWAY_URL=http://127.0.0.1:18789
OPENCLAW_GATEWAY_TOKEN=<gateway.auth.token>
# OPENCLAW_MEMORY_SESSION_KEY=bharosa-citizen
```

Without `OPENCLAW_GATEWAY_*`, Guide memory still works from Postgres alone.

## OpenClaw install

1. Install OpenClaw per https://docs.openclaw.ai → typically `~/.openclaw`.  
2. Start the Gateway (default port `18789`).  
3. Copy `docs/openclaw/bharosa-companion.SKILL.md` into the agent skills folder.  
4. Point skill HTTP tools at `/v2/companion/*`.  
5. Set `OPENCLAW_GATEWAY_URL` + `OPENCLAW_GATEWAY_TOKEN` in `.env.local`.  
6. Restart `vocal-api`.  
7. Staff allowlist only in OpenClaw channel config.

## Do not

- Put citizen WhatsApp through OpenClaw as primary intake.  
- Also run Hermes in production.  
- Let OpenClaw send email / WhatsApp to citizens directly.  
- Force the previous problem when the citizen asks something new.
