# OpenClaw full setup + Bharosa workflow

This guide walks you from zero → OpenClaw Gateway running → keys in `.env.local` → staff companion talking to `vocal-api` → better Guide memory for logged-in citizens.

Official docs: https://docs.openclaw.ai/start/getting-started

---

## What OpenClaw is (for us)

| Piece | What it does |
|---|---|
| **OpenClaw Gateway** | Self-hosted agent process on your Mac (port `18789`) with chat UI, memory, skills, tools |
| **vocal-api Guide (Priya)** | Citizens chat here — **source of truth** for cases + Postgres memory |
| **Companion HTTP tools** | OpenClaw calls `/v2/companion/*` with `BHAROSA_MCP_TOKEN` to read cases / drafts / citizen memory |
| **Gateway token** | Secret so `vocal-api` can call OpenClaw `memory_search` / remember (optional enrichment) |

**Citizens never talk to OpenClaw.** Staff / leaders talk to OpenClaw. Guide keeps using Postgres memory even if OpenClaw is off.

### OpenClaw Chrome dashboard vs Bharosa “Ask for help”

| Screen | What you see | Whose chats? |
|---|---|---|
| **OpenClaw** at `127.0.0.1:18789` | Fresh “main” agent, SESSIONS empty until **you** chat there | **Staff / your laptop companion only** — not citizen Bharosa history |
| **Bharosa Guide** (Ask for help) | Priya chat; logged-in users get **top 3 cases** + See more | **Citizen** tickets + prior Guide chats + memory |

If the OpenClaw dashboard looks like an empty chatbot, that is expected: citizen “hi / my cases” history lives in **Bharosa**, not in OpenClaw’s session list.

---

## Prerequisites

1. **Node.js 24.22.1+ or 26.x** (OpenClaw recommends Node 26).  
   Check: `node --version`  
   If you are on Node 20 (common), the installer can install Node 26, or upgrade via https://nodejs.org / `nvm install 26`.
2. **An AI provider key or login** — Claude Code / Codex CLI already logged in, **or** an Anthropic / OpenAI / OpenRouter API key (onboarding will ask).
3. **`vocal-api` running** — `npm run dev` in `vocal-api` (port `3001`).
4. **Docker** recommended later for sandboxing tool exec (security).

---

## Step 1 — Install OpenClaw (macOS)

Open a **new Terminal** (not the vocal-api one):

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

Or try without a permanent install:

```bash
npx openclaw@latest
```

When prompted:

1. Read the short security note → continue  
2. Choose **Quick start** if you already have Claude/Codex/API access  
3. Or **Custom setup** to pick provider + model manually  

Onboarding saves config under `~/.openclaw/` (mainly `~/.openclaw/openclaw.json`).

Verify:

```bash
openclaw --version
openclaw doctor
```

---

## Step 2 — Get / set the Gateway token (the “key”)

OpenClaw needs a **stable gateway token** so other apps (like vocal-api) can call it after restarts.

### Option A — Generate with doctor (recommended)

```bash
openclaw doctor --generate-gateway-token
```

Copy the printed token. Keep it private (operator-level access).

### Option B — Put it in config yourself

Edit `~/.openclaw/openclaw.json` (JSON5 allowed):

```json5
{
  gateway: {
    mode: "local",
    bind: "loopback",
    auth: {
      mode: "token",
      token: "PASTE_A_LONG_RANDOM_SECRET_HERE",
    },
  },
}
```

Generate a random secret:

```bash
openssl rand -hex 32
```

### Option C — Env var

```bash
export OPENCLAW_GATEWAY_TOKEN="your-long-secret"
```

And in `openclaw.json`:

```json5
{
  gateway: {
    auth: {
      mode: "token",
      token: "${OPENCLAW_GATEWAY_TOKEN}",
    },
  },
}
```

**Two different keys in our stack (do not mix them up):**

| Key | Where | Purpose |
|---|---|---|
| `OPENCLAW_GATEWAY_TOKEN` | OpenClaw + vocal-api `.env.local` | vocal-api → OpenClaw Gateway (`/tools/invoke`) |
| `BHAROSA_MCP_TOKEN` | vocal-api `.env.local` (already set) | OpenClaw → vocal-api `/v2/companion` |

---

## Step 3 — Start the Gateway

### Foreground (good for first test)

```bash
openclaw gateway --port 18789
```

Leave this terminal open. You should see it listening on `18789`.

### Background service (daily use)

Stop the foreground with Ctrl+C, then:

```bash
openclaw gateway install
openclaw gateway status
```

Healthy = runtime running, port **18789**.

Open the UI:

```bash
openclaw dashboard
```

Browser: http://127.0.0.1:18789/  
Send a test message — you should get an AI reply.

Logs if something fails:

```bash
openclaw logs --follow
openclaw triage
```

---

## Step 4 — Wire OpenClaw → Bharosa companion tools

### 4a. Confirm vocal-api companion is up

With `npm run dev` running:

```bash
curl -sS http://127.0.0.1:3001/v2/companion/tools \
  -H "Authorization: Bearer YOUR_BHAROSA_MCP_TOKEN" \
  -H "X-Org-Id: 3f3ff0a3-1ee4-49a5-a956-9e2461a592e3"
```

Replace the token with `BHAROSA_MCP_TOKEN` from `.env.local`.  
You should see JSON listing tools (`list_open_cases`, `get_citizen_memory`, …).

### 4b. Install the Bharosa skill into OpenClaw

Copy our skill stub into the OpenClaw workspace skills folder:

```bash
mkdir -p ~/.openclaw/workspace/skills/bharosa-companion
cp /Users/anuragkartik/Desktop/Projects/my-leader/vocal-api/docs/openclaw/bharosa-companion.SKILL.md \
  ~/.openclaw/workspace/skills/bharosa-companion/SKILL.md
```

Edit that `SKILL.md` and fill in:

- `BHAROSA_MCP_TOKEN` (from vocal-api `.env.local`)
- Base URL: `http://127.0.0.1:3001/v2/companion`
- `X-Org-Id`: your `ORG_ID` (`3f3ff0a3-1ee4-49a5-a956-9e2461a592e3` locally)

Restart Gateway after skill copy:

```bash
openclaw gateway restart
```

### 4c. Staff chat test (in OpenClaw dashboard)

Ask OpenClaw things like:

- “List open Bharosa cases”  
- “Show open guide drafts”  
- “Get citizen memory for `<citizen-uuid>`”  

It should call our HTTP tools — not invent ticket numbers.

**Rules for the skill (already in the stub):**

- Staff / leader only  
- Never message citizens or send email itself  
- Nudge text = draft only; Twilio / vocal-api sends  

---

## Step 5 — Wire Bharosa → OpenClaw (memory enrichment)

In `vocal-api/.env.local` uncomment / set:

```bash
BHAROSA_COMPANION=openclaw
BHAROSA_MCP_TOKEN=<already set>

OPENCLAW_GATEWAY_URL=http://127.0.0.1:18789
OPENCLAW_GATEWAY_TOKEN=<same token from Step 2>
OPENCLAW_MEMORY_SESSION_KEY=bharosa-citizen
```

Restart `vocal-api` (`npm run dev`).

Now when a **logged-in** citizen chats with Priya:

1. Postgres loads their memory (problems, areas, behavior)  
2. vocal-api optionally calls OpenClaw `memory_search` for extra notes  
3. After important turns, vocal-api may push a short note into OpenClaw memory  

If Gateway is down, Guide still works — enrichment is best-effort.

---

## Step 6 — End-to-end checklist

| # | Check | Command / action |
|---|---|---|
| 1 | OpenClaw installed | `openclaw --version` |
| 2 | Gateway up | `openclaw gateway status` → port 18789 |
| 3 | Dashboard chat works | `openclaw dashboard` |
| 4 | Companion tools work | `curl …/v2/companion/tools` with MCP token |
| 5 | Skill installed | file under `~/.openclaw/workspace/skills/bharosa-companion/` |
| 6 | Env linked | both tokens set in `.env.local` |
| 7 | Citizen memory | Log in on web → Ask for help → raise issue → return later |
| 8 | Staff brief | In OpenClaw: “open cases” / “citizen memory …” |

---

## Full workflow (how the pieces talk)

```text
Citizen (web / WhatsApp)
        │
        ▼
 ┌──────────────────┐     Postgres memory
 │  vocal-api Guide │◄─── citizen_guide_memory
 │  (Priya)         │     guide_sessions + tickets
 └────────┬─────────┘
          │ optional memory_search / remember
          ▼
 ┌──────────────────┐
 │ OpenClaw Gateway │◄── staff Telegram / dashboard chat
 │  :18789          │
 └────────┬─────────┘
          │ HTTP tools (BHAROSA_MCP_TOKEN)
          ▼
 ┌──────────────────┐
 │ /v2/companion/*  │  cases, drafts, memory, nudge draft
 └──────────────────┘
```

**Happy path**

1. Citizen logs in → chats Priya → problem + area saved to memory  
2. Next visit → “Welcome back… continue X or new problem?”  
3. Staff asks OpenClaw “what’s open?” → companion lists tickets / drafts  
4. Staff asks for a nudge → OpenClaw proposes text → human/Twilio sends  

---

## How this is beneficial

| Benefit | Without OpenClaw stack | With memory + OpenClaw |
|---|---|---|
| Returning citizen | Starts from zero every chat | Knows name, area, past problems, likely next ask |
| Topic stickiness | Bot stuck on old issue + boilerplate | Memory is context-only; new question wins |
| Staff awareness | Dig through admin UI / DB | Chat: “list open cases”, “memory for citizen …” |
| Follow-ups | Manual | Draft nudge from unfinished drafts (send still via Twilio) |
| Long memory for leaders | None | OpenClaw personal memory + our Postgres profiles |
| Safety | — | Citizens never in OpenClaw multi-user memory; no direct citizen messaging from companion |

**What it does *not* replace**

- Dify intake classify (still Phase 1)  
- Twilio / SES sending  
- Case engine in vocal-api  

---

## Security must-dos

1. Keep Gateway on **loopback** (`127.0.0.1`) unless you know Tailscale/VPN hardening.  
2. Treat both tokens like production passwords.  
3. Staff allowlist only on Telegram/WhatsApp channels.  
4. Do not put citizen WhatsApp through OpenClaw as primary intake.  
5. Do not give OpenClaw raw `DATABASE_URL`.  
6. Prefer Docker sandbox for tool exec in prod.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `openclaw: command not found` | Re-run install script; open a new terminal; check PATH |
| Node version too old | Install Node 26; re-run installer |
| Gateway won’t start | `openclaw gateway --force` or `openclaw doctor` / `openclaw triage` |
| Dashboard won’t load | Confirm port 18789; `openclaw gateway status` |
| Companion 401 | Wrong `BHAROSA_MCP_TOKEN` or missing `Authorization: Bearer …` |
| Companion 503 | `BHAROSA_COMPANION` not `openclaw` |
| Guide ignores OpenClaw | Gateway down or `OPENCLAW_GATEWAY_*` still commented out — Postgres memory still works |
| Skill ignored | Wrong path / no restart after copy |

---

## Quick copy-paste (after install)

```bash
# 1) Token
openclaw doctor --generate-gateway-token

# 2) Run Gateway (or: openclaw gateway install)
openclaw gateway --port 18789

# 3) Dashboard
openclaw dashboard

# 4) Put token into vocal-api/.env.local then restart API
# OPENCLAW_GATEWAY_URL=http://127.0.0.1:18789
# OPENCLAW_GATEWAY_TOKEN=<paste>

# 5) Skill
mkdir -p ~/.openclaw/workspace/skills/bharosa-companion
cp ~/Desktop/Projects/my-leader/vocal-api/docs/openclaw/bharosa-companion.SKILL.md \
  ~/.openclaw/workspace/skills/bharosa-companion/SKILL.md
```
