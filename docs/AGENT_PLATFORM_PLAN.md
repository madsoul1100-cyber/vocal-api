# Bharosa agent platform — Phase 1 & 2

## Can we use OpenClaw?

**Yes, for the long-lived companion — not as the citizen case engine.**

| Tool | What it is | Fit for Bharosa |
|---|---|---|
| **Dify** | Visual workflows + RAG + publish as API | **Phase 1** — intake/classify/draft brains, playbook knowledge |
| **Hermes** (Nous) | Self-improving personal agent, memory, skills, MCP | **Phase 2** — staff / leader companion, resume memory |
| **OpenClaw** | Self-hosted personal agent, messaging-first, huge channel/skill ecosystem (MIT) | **Phase 2 alternative** to Hermes — same *lane*, not a third stack |

OpenClaw and Hermes are **products you run**, not SDKs you embed into `vocal-api` for thousands of citizens. Market popularity does not change that: both are “assistant on your machine / VPS,” with chat gateways (WhatsApp, Telegram, etc.).

**Do not run OpenClaw + Hermes together.** Pick one companion.

| Prefer OpenClaw if… | Prefer Hermes if… |
|---|---|
| You want Node.js, widest chat channels, ClawHub skills | You want the self-improving skill loop + strong MCP story |
| Team already uses OpenClaw | You may import OpenClaw later (`hermes import-agent openclaw`) |

**Locked for Bharosa (decision):**  
- **Phase 1:** **Dify** (workflows + knowledge) behind `vocal-api`.  
- **Phase 2:** **OpenClaw** companion (HTTP tools into our APIs). Hermes is not used unless we migrate later.  
- **Citizen WhatsApp/Guide:** stay on `vocal-api` + Twilio (Phase 0 ladder). Do not put citizens into OpenClaw multi-user memory.

### Dify license note (important)

Dify Community Edition uses a **modified Apache-2.0** with extra terms. In particular, using the source to operate a **multi-tenant** environment may require written authorization; one tenant ≈ one workspace.  

**Our safe pattern:** one Dify workspace (ops), `vocal-api` remains the multi-tenant product (orgs, tickets, approvals). Confirm with counsel before multi-workspace CE for many customers. Enterprise/Cloud avoid this ambiguity.

---

## Architecture (locked)

```
Citizen (WA / Guide / App)
        │
        ▼
┌───────────────────────────────┐
│  vocal-api  (source of truth) │
│  sessions, tickets, approvals │
│  ai_runs, directory, Twilio   │
└───────┬───────────┬───────────┘
        │           │
        ▼           ▼
   ┌────────┐  ┌─────────────────┐
   │  Dify  │  │ Hermes|OpenClaw │
   │ flows  │  │ memory companion│
   │ + RAG  │  │ (staff / leader)│
   └────────┘  └─────────────────┘
```

**Rules**
1. Citizens never talk to Dify/Hermes/OpenClaw directly.
2. Nothing leaves the system (email/public post) without our approval gates.
3. Companion writes only via MCP/API into `vocal-api` (create draft, never raw send).

---

## Phase 1 — Dify (workflows + knowledge)

### Goals
- Publish an **Intake Classify** API app (problem category, language, needs_area, urgency).
- Put Telangana playbooks + directory snippets in a **Knowledge Base**.
- Call Dify from `vocal-api` behind `BHAROSA_DIFY_ENABLED=true` (fallback = current agents).

### Deliverables
1. Docker Compose / Cloud workspace for Dify CE.  
2. `difyClient.ts` in vocal-api (chat / workflow run).  
3. Feature-flagged hook from guide classify + structuring agent.  
4. Env: `DIFY_API_BASE`, `DIFY_API_KEY`, `DIFY_APP_INTAKE_KEY`.

### Out of scope for Phase 1
- Moving all 10 Bharosa agents.  
- Citizen UI changes.  
- Hermes/OpenClaw.

---

## Phase 2 — Hermes **or** OpenClaw (memory companion)

### Goals
- Staff/leader assistant with long-lived memory (“3 open cases”, “continue draft”).  
- MCP tools: `list_cases`, `get_open_draft`, `get_citizen_summary`, `create_draft_case`.  
- Cron nudge text proposed by companion; **sent only by vocal-api/Twilio**.

### Deliverables
1. Sandboxed install of **one** of Hermes / OpenClaw.  
2. MCP server (or HTTP tools) exposing read/write drafts on `vocal-api`.  
3. Staff-only allowlist; no citizen tenancy inside the companion.  
4. Runbook: security (sandbox on, tool allowlist, no shell for prod).

### Out of scope
- Replacing Twilio citizen intake.  
- Running both Hermes and OpenClaw.

---

## Suggested order this week

1. Stand up Dify (local Docker or Cloud).  
2. Wire `difyClient` + one intake workflow.  
3. Decide Hermes vs OpenClaw for Phase 2.  
4. Expose MCP tools from vocal-api; connect companion.
