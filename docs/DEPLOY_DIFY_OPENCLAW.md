# Deploy Guide + Dify + OpenClaw (beyond localhost)

**Audience:** you + manager / DevOps  
**Today:** `vocal-api` / web already hit production-ish hosts; **Dify** and **OpenClaw** run on your Mac.  
**Goal:** ship agent features safely without exposing OpenClaw to the public internet.

---

## 0. Important mental model

| Piece | Must be public? | Deploy where |
|---|---|---|
| **vocal-web** (Ask for help) | Yes | Vercel (you already use this) |
| **vocal-api** (Priya) | Yes | Your API host (`prod.my-leader.in` / EC2 / etc.) |
| **Postgres (RDS)** | No (private / SG) | Already AWS RDS |
| **Dify** | No — only **vocal-api** calls it | Same VPC / private VM / Docker on API box |
| **OpenClaw Gateway** | No — loopback or Tailscale only | Staff VPS or same private network |

**Citizens never call Dify or OpenClaw.** Only `vocal-api` does.

**You can deploy Guide memory + anti-stuck to prod first** even if Dify/OpenClaw stay local:  
- Dify off → local heuristics still classify `needs_area`  
- OpenClaw off → Postgres `citizen_guide_memory` still works  

---

## 1. Recommended rollout (3 phases)

```text
Phase A (this week)     Ship Guide code + memory migration to prod API/web
                        BHAROSA_DIFY_ENABLED=false  (or point later)
                        OPENCLAW_GATEWAY_* unset

Phase B (next)          Run Dify CE on a private server → set DIFY_* on prod API

Phase C (when ready)    Run OpenClaw on private host / Tailscale → set OPENCLAW_*
                        Staff-only; never public 0.0.0.0 without auth + allowlist
```

---

## 2. Phase A — Deploy what you already built (API + web)

### 2.1 Code + DB

On the machine / CI that deploys `vocal-api`:

```bash
cd vocal-api
git pull   # or your normal deploy pipeline
npm ci
npm run build   # if production uses dist/
npm run db:migrate -- 023_citizen_guide_memory.sql
# or full: npm run db:migrate
```

Ensure production `DATABASE_URL` is the RDS you use for prod (not only local `.env.local`).

### 2.2 Production env on **vocal-api** (minimum)

Set on the **server** (systemd / PM2 / ECS / Elastic Beanstalk — wherever `prod.my-leader.in` runs):

```bash
# Already used in prod — keep as-is
DATABASE_URL=...
JWT_SECRET=...
OPENROUTER_API_KEY=...
# ... Twilio, SES, CORS, ORG_ID, etc.

# Agent flags — start safe
BHAROSA_DIFY_ENABLED=false
BHAROSA_COMPANION=off
# Do NOT set OPENCLAW_GATEWAY_URL yet
# Do NOT set DIFY_API_BASE yet
```

Restart API. Deploy **vocal-web** (Vercel) with production API bases (you already have):

```bash
VITE_API_BASE_URL=https://prod.my-leader.in/v1
VITE_API_V2_BASE_URL=https://prod.my-leader.in/v2
```

### 2.3 What works after Phase A (no Dify/OpenClaw server)

- Soft ladder, anti-stuck, dual-path once  
- Logged-in **issue list** + continue (Postgres memory)  
- Playbooks + OpenRouter answers  
- Raise / email paths  

**Does not yet:** Dify cloud classify, OpenClaw staff dashboard enrichment.

### 2.4 Smoke test on prod

1. Open production Bharosa → Sign in → Ask for help → New chat → hi  
2. Confirm issue list / new problem works  
3. Power cut → asks area; then help  
4. Switch to PAN → no electricity boilerplate  

---

## 3. Phase B — Deploy Dify (private)

### 3.1 Where to put it

Best: **same VPC as vocal-api**, e.g. small EC2 `t3.medium`+ in `ap-south-2`, security group:

- Inbound **80/443** only from **vocal-api security group** (or private IP)  
- **Not** open to `0.0.0.0/0` unless you put SSO / VPN in front  

Alternative: Docker on the **same** API host, bind `127.0.0.1` only; API uses `http://127.0.0.1/v1`.

### 3.2 Install (Docker Compose — official Dify CE)

On the Dify host:

```bash
git clone https://github.com/langgenius/dify.git
cd dify/docker
cp .env.example .env
# edit SECRET_KEY, DB passwords, etc.
docker compose up -d
```

Open Studio via SSH tunnel or VPN (not public if possible):

```bash
ssh -L 8080:127.0.0.1:80 ec2-user@dify-host
# browser http://127.0.0.1:8080
```

### 3.3 Recreate / publish intake app

1. Create Chatflow (same as local): Start → LLM → Answer JSON  
2. Prompt: return `{ category, summary, needs_area, confidence }`  
3. Publish → copy **API key** (`app-...`)  
4. Note internal base URL, e.g. `http://10.0.1.20/v1` or `https://dify.internal.my-leader.in/v1`

### 3.4 Point production vocal-api at Dify

```bash
BHAROSA_DIFY_ENABLED=true
DIFY_API_BASE=http://<private-dify-host>/v1
DIFY_APP_INTAKE_KEY=app-xxxxxxxx
DIFY_INTAKE_MODE=chat
```

Restart API. Test:

```bash
# From API host
curl -sS "$DIFY_API_BASE/parameters" -H "Authorization: Bearer $DIFY_APP_INTAKE_KEY"
```

Citizen power-cut message should set area ask via Dify.

### 3.5 Dify license note (manager)

Dify CE has multi-tenant restrictions. **Safe pattern:** one Dify workspace for ops; **vocal-api** remains multi-tenant product. Confirm with counsel before selling multi-workspace CE.

---

## 4. Phase C — Deploy OpenClaw (private / staff)

### 4.1 Do **not** put Gateway on the public internet

OpenClaw Gateway token = **operator access**. Bind **loopback** or **Tailscale** only.

Options:

| Option | Setup |
|---|---|
| **A. Same API box** | `openclaw gateway` on server; API uses `http://127.0.0.1:18789` |
| **B. Staff VPS + Tailscale** | Gateway on Tailscale IP; API also on Tailscale; `OPENCLAW_GATEWAY_URL=http://100.x.y.z:18789` |
| **C. Keep on your Mac** | Only for demos; prod API cannot reach `127.0.0.1` on your laptop |

### 4.2 Server install (Node 26)

```bash
# on private host
curl -fsSL https://openclaw.ai/install.sh | bash
nvm use 26   # if needed
openclaw onboard   # or configure openclaw.json
openclaw gateway install
openclaw gateway status
```

Ensure `~/.openclaw/openclaw.json`:

```json5
{
  gateway: {
    mode: "local",
    port: 18789,
    bind: "loopback",   // or Tailscale IP — NOT 0.0.0.0 public
    auth: { mode: "token", token: "<long-random-secret>" }
  }
}
```

### 4.3 Point production vocal-api

```bash
BHAROSA_COMPANION=openclaw
BHAROSA_MCP_TOKEN=<strong-random>          # OpenClaw → API
OPENCLAW_GATEWAY_URL=http://127.0.0.1:18789
OPENCLAW_GATEWAY_TOKEN=<same as openclaw.json>
OPENCLAW_MEMORY_SESSION_KEY=bharosa-citizen
```

Firewall: API must allow OpenClaw host to call `https://prod.my-leader.in/v2/companion/*` with Bearer MCP token.  
OpenClaw skill: copy `docs/openclaw/bharosa-companion.SKILL.md` and set prod base URL + org id.

### 4.4 Staff access

- Prefer **Tailscale** + OpenClaw dashboard  
- Or Telegram channel with **allowlist** only  
- Never share gateway token in Slack/Git  

---

## 5. Production env cheat-sheet

```bash
# --- Always (Guide) ---
# migrations through 023 applied
# OPENROUTER_* for Priya answers

# --- Phase B ---
BHAROSA_DIFY_ENABLED=true
DIFY_API_BASE=http://<private>/v1
DIFY_APP_INTAKE_KEY=app-...
DIFY_INTAKE_MODE=chat

# --- Phase C ---
BHAROSA_COMPANION=openclaw
BHAROSA_MCP_TOKEN=...
OPENCLAW_GATEWAY_URL=http://127.0.0.1:18789
OPENCLAW_GATEWAY_TOKEN=...
OPENCLAW_MEMORY_SESSION_KEY=bharosa-citizen
```

| If unset / false | Behavior |
|---|---|
| `BHAROSA_DIFY_ENABLED=false` | Local heuristics for area/classify |
| No `OPENCLAW_GATEWAY_*` | Postgres memory only; companion can still be `off` |
| `BHAROSA_COMPANION=off` | `/v2/companion` returns 503 |

---

## 6. Networking diagram (prod)

```text
Internet
   │
   ├─► Vercel (vocal-web)
   │         │
   │         ▼
   └─► prod.my-leader.in (vocal-api) ──────► RDS Postgres
                    │
                    ├── private ──► Dify CE (Docker)
                    │
                    └── loopback/Tailscale ──► OpenClaw Gateway
                                                    │
                                                    └──► /v2/companion (MCP token)
```

---

## 7. Cost / sizing (rough)

| Service | Rough size | Notes |
|---|---|---|
| vocal-api | existing host | No big change |
| Dify CE | 2–4 GB RAM VM | Postgres + Redis + workers in Compose |
| OpenClaw | 1–2 GB RAM | Plus model API costs (OpenRouter) |

---

## 8. What to tell your manager

1. **Citizen product deploys with normal API/web** — memory + chat fixes don’t require public Dify/OpenClaw.  
2. **Dify** moves to a **private** server next; API calls it like a microservice.  
3. **OpenClaw** stays **private** (loopback/Tailscale) for staff; never a public citizen chatbot.  
4. Failures are soft: if Dify/OpenClaw are down, Guide still answers.

---

## 9. Immediate next actions for you

1. **Today:** Deploy Phase A (API + migration `023` + web) with Dify/OpenClaw **flags off** on prod.  
2. **Confirm** who owns `prod.my-leader.in` (EC2 / PM2 / etc.) — apply env there.  
3. **Next sprint:** Spin Dify Docker on private EC2; wire `DIFY_*`.  
4. **Then:** OpenClaw on same box or Tailscale; wire `OPENCLAW_*` + skill.  

If you tell me how `prod.my-leader.in` is hosted (PM2, Docker, ECS, Elastic Beanstalk), I can give exact restart/deploy commands for that stack only.
