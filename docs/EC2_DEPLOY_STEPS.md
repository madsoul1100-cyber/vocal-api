# EC2 deploy steps (my-leader-prod) — after `git pull`

You are on the API box (`vocal-api`). Do **Phase 1 first** (API + DB). Dify / OpenClaw / Echo are optional next.

---

## Phase 1 — Ship Guide + memory (required, ~10 min)

### 1) Confirm you are in the right place

```bash
cd ~/vocal-api   # or wherever your pull landed — adjust path
pwd
git log -1 --oneline
ls supabase/migrations/023_citizen_guide_memory.sql
```

### 2) See how the API is running today

```bash
# Which process owns the API?
sudo ss -tlnp | grep -E ':3001|:80|:443' || true
ps aux | grep -E 'node|tsx|pm2' | grep -v grep | head -20

# If PM2:
pm2 list
# If systemd:
systemctl list-units --type=service | grep -iE 'vocal|bharosa|node' || true
```

**Remember the restart method** (PM2 vs systemd vs `npm start`) — you will use it in step 6.

### 3) Install deps

```bash
npm ci
# if npm ci fails (lockfile): npm install
```



### 4) Env — add agent flags (safe mode)

Edit production env (usually `.env` or `.env.local` or `/etc/…`):

```bash
nano .env.local
# or: nano .env
```

**Add / set** (keep existing DATABASE_URL, JWT, OpenRouter, Twilio, etc.):

```bash
# Phase 1 safe — Guide works without Dify/OpenClaw/Echo on this box yet
BHAROSA_DIFY_ENABLED=false
BHAROSA_COMPANION=off

# Jobs worker (same process as API)
JOBS_WORKER_ENABLED=true
JOBS_SCHEDULER_ENABLED=true

# Echo — leave commented until you have the vendor key
# ECHO_MEM_API_KEY=
# ECHO_MEM_API_BASE=https://api.echo-mem.com/mcp
```

Save. **Do not** point `DIFY_API_BASE` at your laptop.

### 5) Run migration (RDS)

Uses `DATABASE_URL` from env:

```bash
# load env if your shell does not auto-load it
set -a && source .env.local 2>/dev/null; source .env 2>/dev/null; set +a

npm run db:migrate -- 023_citizen_guide_memory.sql
# If it says already applied / skip — OK
# Or full: npm run db:migrate
```



### 6) Restart API

**PM2 (common — your box runs** `jai-api` **on :3002; add** `vocal-api` **on :3001):**

```bash
# First time (process missing from pm2 list):
cd ~/vocal-api
pm2 update   # fix out-of-date in-memory PM2 warning
pm2 delete vocal-api 2>/dev/null || true
pm2 start npm --name vocal-api -- start
pm2 save
pm2 status
pm2 logs vocal-api --lines 40

# Later deploys:
pm2 restart vocal-api
```

**Do not** rely on bare `NODE_ENV=production npm start` in SSH — it stops when the session ends.

**systemd:**

```bash
sudo systemctl restart vocal-api   # use your real unit name
sudo systemctl status vocal-api
```

**Manual / nohup:**

```bash
# find old PID and kill, then:
NODE_ENV=production npm start
# better: use pm2 start "npm start" --name vocal-api
```



### 7) Smoke test on the box

```bash
curl -sS http://127.0.0.1:3001/health
curl -sS https://prod.my-leader.in/health   # if nginx/TLS terminates here
```



### 8) Frontend (Vercel) — if Ask for help UI needs the new buttons

From your laptop (or Vercel dashboard), redeploy **vocal-web** so Guide issue chips ship:

```bash
# on your Mac, in vocal-web:
# ensure .env.production still points at prod.my-leader.in
vercel --prod
# or push to the branch that auto-deploys
```



### 9) Product check

1. Open production Bharosa → **Sign in**
2. Ask for help → **New chat** → `hi`
3. Expect issue list / new problem (not stuck electricity boilerplate)
4. Raise a real issue → New chat again → should list **issues**, not every chat line

**Phase 1 done.** Citizens already get memory + anti-stuck without Dify/OpenClaw on EC2.

---



## Phase 2 — Dify on same EC2 (optional)

Needs **Docker** + ~4 GB free RAM. Skip if the box is small.

### 2a) Install Docker + Compose (Amazon Linux 2023)

```bash
sudo yum install -y docker
sudo systemctl enable --now docker
sudo usermod -aG docker ec2-user

# Compose plugin (required — plain `docker` has no `compose` subcommand)
sudo yum install -y docker-compose-plugin
# If that package is missing, install standalone:
# sudo curl -L "https://github.com/docker/compose/releases/download/v2.29.7/docker-compose-linux-x86_64" -o /usr/local/bin/docker-compose
# sudo chmod +x /usr/local/bin/docker-compose

# Apply docker group (or log out / in)
newgrp docker
docker --version
docker compose version || docker-compose --version
```



### 2b) Clone / start Dify CE

```bash
cd ~
# skip clone if already done
git clone https://github.com/langgenius/dify.git 2>/dev/null || true
cd ~/dify/docker
cp -n .env.example .env

docker compose up -d
# if plugin missing: docker-compose up -d

docker compose ps
```

UI: open via SSH tunnel from your Mac:

```bash
ssh -L 8080:127.0.0.1:80 ec2-user@16.112.148.71
# browser http://127.0.0.1:8080
```

Create admin → Chatflow (Start → LLM → Answer JSON) → Publish → copy `app-…` key.

### 2c) Point API at local Dify

In `vocal-api` env:

```bash
BHAROSA_DIFY_ENABLED=true
DIFY_API_BASE=http://127.0.0.1/v1
DIFY_APP_INTAKE_KEY=app-xxxxxxxx
DIFY_INTAKE_MODE=chat
```

Restart API (same as Phase 1 step 6).  
Security group: **do not** open Dify ports to `0.0.0.0/0`.

---



## Phase 3 — OpenClaw on same EC2 (optional, staff only)

Needs **Node 26**. Keep Gateway on **127.0.0.1** only.

```bash
# install nvm + node 26 if needed
curl -fsSL https://openclaw.ai/install.sh | bash
# or after nvm:
nvm install 26 && nvm use 26
openclaw --version
openclaw onboard          # first time
openclaw gateway install  # background service
openclaw gateway status   # :18789
```

Copy token from `~/.openclaw/openclaw.json` → `gateway.auth.token`.

In `vocal-api` env:

```bash
BHAROSA_COMPANION=openclaw
BHAROSA_MCP_TOKEN=<long random — openssl rand -hex 32>
OPENCLAW_GATEWAY_URL=http://127.0.0.1:18789
OPENCLAW_GATEWAY_TOKEN=<from openclaw.json>
OPENCLAW_MEMORY_SESSION_KEY=bharosa-citizen
```

Restart API. Install skill:

```bash
mkdir -p ~/.openclaw/workspace/skills/bharosa-companion
cp ~/vocal-api/docs/openclaw/bharosa-companion.SKILL.md \
  ~/.openclaw/workspace/skills/bharosa-companion/SKILL.md
# edit file: MCP token + https://prod.my-leader.in/v2/companion + X-Org-Id
openclaw gateway restart
```

---



## Phase 4 — Echo Memory (when vendor key arrives)

```bash
# in vocal-api .env
ECHO_MEM_API_KEY=em_...
ECHO_MEM_API_BASE=https://api.echo-mem.com/mcp
# ECHO_MEM_MEMORY=bharosa-prod
```

Restart API. No extra process on EC2 (hosted).

---



## One-shot checklist (copy)

```bash
cd ~/vocal-api          # adjust path
git log -1 --oneline
npm ci
# edit .env: BHAROSA_DIFY_ENABLED=false BHAROSA_COMPANION=off
set -a; source .env.local 2>/dev/null; source .env 2>/dev/null; set +a
npm run db:migrate -- 023_citizen_guide_memory.sql
pm2 restart all         # or systemctl restart …
curl -sS http://127.0.0.1:3001/health
```

Then redeploy **vocal-web** on Vercel.

---



## If something fails


| Symptom                         | Fix                                                   |
| ------------------------------- | ----------------------------------------------------- |
| migrate fails / no DATABASE_URL | `source` the env file; confirm RDS SG allows this EC2 |
| health 502                      | nginx upstream; `pm2 logs` / journalctl               |
| Guide no issue list             | citizen must be **signed in**; web redeployed         |
| Dify OOM                        | skip Phase 2 or upgrade instance to 8 GB              |
| OpenClaw command not found      | `nvm use 26` then retry                               |


More detail: `DEPLOY_DIFY_OPENCLAW.md`, `SINGLE_INSTANCE_STACK.md`, `ECHO_MEMORY_SETUP.md`.