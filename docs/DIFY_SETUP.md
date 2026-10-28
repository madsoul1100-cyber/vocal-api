# Phase 1 — Dify setup (local)

## 1. Run Dify Community Edition

Repo is already cloned at `my-leader/dify` (gitignored). Stack:

```bash
cd my-leader/dify/docker
docker compose up -d
```

Console: **http://localhost** (nginx).  
Create admin account on first visit.

API for apps is usually via nginx → `/v1` on the same host, or the service port from compose.  
Set in vocal-api:

```
DIFY_API_BASE=http://127.0.0.1/v1
```

(If `/v1` 404s, try `http://127.0.0.1:5001/v1` after checking `docker compose ps` / published ports.)

Add your OpenRouter (or other) model provider in Dify settings — same credits model as today.

## 2. Create Knowledge Base

Upload / paste:
- Telangana playbook steps (from `guide/playbooks.ts` summaries)
- Department contacts (HMWSSB, GHMC, Prajavani, etc.)

Index and test retrieval in the Dify UI.

## 3. Create Workflow app: “Bharosa Intake Classify”

**Inputs**
- `message` (string) — citizen text  
- `language` (string)  
- `name` (string, optional)

**Logic (suggested nodes)**
1. LLM / Agent: classify civic category, short summary, `needs_area` boolean, confidence.  
2. Optional Knowledge Retrieval for similar playbooks.  
3. Output variables: `category`, `summary`, `needs_area`, `confidence`.

**Publish** → copy **API Key** into `DIFY_APP_INTAKE_KEY`.

## 4. Enable in vocal-api

`.env.local`:

```
BHAROSA_DIFY_ENABLED=true
DIFY_API_BASE=http://127.0.0.1:5001/v1
DIFY_APP_INTAKE_KEY=app-xxxx
```

Client code: `src/modules/bharosa/ai/difyClient.ts`  
`difyIntakeClassify()` returns `null` when disabled or on failure (existing OpenRouter path keeps working).

## 5. Multi-tenant reminder

Use **one** Dify workspace. Keep org isolation in Postgres / `vocal-api`. See `AGENT_PLATFORM_PLAN.md` license note.
