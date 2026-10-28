# Bharosa Guide agent — full architecture (manager view)

**Purpose:** Show progress clearly. Dify’s canvas only shows **Start → LLM → Answer**. That is **one small brain** inside a much larger product. This doc is the full picture: what we built, why each piece exists, benefits, how to test, and what to do next.

**Date:** Oct 2026  
**Product:** Bharosa / My Leader — citizen help agent **Priya**

---

## 1. Elevator pitch (30 seconds)

> Citizens talk only to **Priya inside our app** (web / WhatsApp).  
> **Dify** classifies “what is the problem / do we need area?”  
> **OpenClaw** is a **staff companion** + optional memory enrich — not the citizen chatbot.  
> **vocal-api** owns conversation ladder, playbooks, memory of **issues** (not every chat line), dual-path escalate, email, tickets.  
> Result: a personal agent that doesn’t get stuck, remembers returning users’ **issues**, and can grow without rewriting the citizen app.

---

## 2. Why Dify looks “too simple”

What you see in Dify Studio:

```text
[ Start: user input ] → [ LLM: gemini ] → [ Answer: JSON ]
```

Example output:

```json
{
  "category": "power",
  "summary": "Frequent power cuts in the area.",
  "needs_area": true,
  "confidence": 0.9
}
```

**That is intentional.** Dify’s job in Phase 1 is **intake classify only** — not the whole product.

| If we put everything in Dify… | Why we don’t |
|---|---|
| All Telugu/Hindi chat, tickets, Twilio, email, login | Hard to control tenancy, approvals, audit |
| Citizen memory + staff tools | Wrong product shape; security risk |
| Playbooks + raise complaint | Must stay in our DB / approval gates |

So: **simple Dify flow = focused specialty.** Complexity lives in **vocal-api** (our system of record).

---

## 3. Full architecture (current)

```text
┌──────────────────────────────────────────────────────────────────────────┐
│                         CITIZEN CHANNELS                                 │
│   Web “Ask for help” (Guide)  ·  WhatsApp (Twilio)  ·  (future app)      │
└───────────────────────────────┬──────────────────────────────────────────┘
                                │  JWT if logged in
                                ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  vocal-api  = PRODUCT BRAIN (Priya / Guide)                              │
│                                                                              │
│  A. Intake ladder                                                            │
│     greet → name → PROBLEM first → AREA only if needed → help                │
│                                                                              │
│  B. Issue memory (logged-in)                                                 │
│     top 3 distinct ISSUES (water / Aadhaar / voter…) — not every chat line │
│     tap issue → continue that topic · See more · New problem                 │
│                                                                              │
│  C. Playbooks + web search                                                   │
│     20 Telangana scripts · official steps · department contacts              │
│                                                                              │
│  D. Dual path                                                                │
│     official dept (call/email) + help desk / leadership escalate             │
│     close offered ONCE per local issue (no spam)                             │
│                                                                              │
│  E. Topic switch                                                             │
│     answer LATEST question; don’t stick on old electricity boilerplate       │
│                                                                              │
│  F. Raise / email                                                            │
│     draft → citizen confirm → SES · ticket / reference                       │
│                                                                              │
│  G. Voice (optional)                                                         │
│     Sarvam STT / TTS                                                         │
└───────────────┬─────────────────────────────┬───────────────────────────────┘
                │                             │
                │ classify                    │ enrich + staff tools
                ▼                             ▼
┌───────────────────────────┐   ┌─────────────────────────────────────────────┐
│  Dify (Chatflow)          │   │  OpenClaw Gateway (:18789)                  │
│  Bharosa Intake Classify  │   │  Staff dashboard / Telegram (later)         │
│  Start → LLM → Answer     │   │  Calls /v2/companion/*                      │
│  → category, summary,     │   │  · list open cases                          │
│    needs_area, confidence │   │  · drafts · citizen memory                  │
│  Fallback: local rules    │   │  · propose nudge (does NOT send)            │
│  if Dify down             │   │  Optional memory_search for Guide enrich    │
└───────────────────────────┘   └─────────────────────────────────────────────┘
                │                             │
                └─────────────┬───────────────┘
                              ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  DATA (source of truth)                                                    │
│  Postgres: citizens · tickets · guide_sessions · guide_messages            │
│            citizen_guide_memory · citizen_guide_memory_events              │
│            communications · directory · ai_runs                            │
└──────────────────────────────────────────────────────────────────────────┘
```

### One-turn flow (citizen message)

```text
1. Auth (optional citizen JWT)
2. Load / create guide session (+ link citizen_id)
3. Load issue memory → if “hi” / “my issues” → list top 3 ISSUES (deduped)
4. Soft ladder (name / problem / area)
5. Dify classify (needs_area? category?)  ←── this is the tiny Dify canvas
6. Match playbook OR web search
7. Answer latest question (LLM phrasing + facts)
8. Dual-path close once if department issue
9. Persist: session + memory event (real issues only, not meta chat)
10. Optional: OpenClaw remember note for staff enrichment
```

---

## 4. Layer map — “who does what”

| Layer | Tool | Visible to manager in UI? | Responsibility |
|---|---|---|---|
| Citizen UX | `vocal-web` Guide | Bharosa “Ask for help” | Chat, tap issues, voice |
| Conversation + rules | `vocal-api` Guide agent | Logs / DB | Ladder, playbooks, anti-stuck, dual path |
| Issue memory | Postgres `citizen_guide_memory` | Guide issue list | Distinct queries, not every message |
| Intake classify | **Dify** Start→LLM→Answer | Dify Studio | `needs_area`, category, summary |
| Token-efficient recall | **Echo Memory** (fact graph) | Hosted MCP | Few relevant facts into Priya — not full chat dumps |
| Staff companion | **OpenClaw** | OpenClaw Chrome UI | Staff asks about cases; **not** citizen history |
| Comms | Twilio / SES | Ops | WhatsApp + email (approval gates) |
| Cases | tickets table | My cases | Formal filed complaints |

**Critical distinction for demos**

| Screen | What it shows |
|---|---|
| **Dify canvas** | Only classify brain (3 nodes) — by design |
| **Bharosa Ask for help** | Full citizen agent + issue list |
| **OpenClaw dashboard** | Staff laptop agent — empty until staff chats; **not** citizen chats |

---

## 5. Problems we fixed (before → after)

| Before | After |
|---|---|
| Stuck on first issue + same Help Desk paragraph every turn | Answer latest question; close once; topic switch |
| Area asked too early / or never | Problem first; area when Dify/heuristic says `needs_area` |
| “Just call 1912” | Dual path: official + help desk escalate |
| Returning user = blank slate | Logged-in memory of **issues** |
| Listed every chat line as a “case” | Deduped issues (water / Aadhaar / voter) — meta lines filtered |
| Staff had no chat assistant on live data | OpenClaw → `/v2/companion` tools |

---

## 6. Benefits (for growth narrative)

### Citizens
- Feels like a **personal agent**, not a script dump  
- Can change topic without fighting the bot  
- See **their issues** and continue one with a tap  
- Official path **or** party/help-desk path  

### Operations / leadership desk
- Structured intake (area collected when needed)  
- Raise-with-desk trail in our system  
- Staff can brief via OpenClaw without raw DB access  

### Product / engineering
- **Swap/improve Dify flows** without rewriting citizen app  
- **Add OpenClaw skills** without multi-tenant citizen risk  
- Clear fallbacks: Dify down → local heuristics; OpenClaw down → Postgres memory still works  

### Measurable KPIs (track next)
1. % local issues with area before escalate  
2. % topic switches without old boilerplate  
3. % logged-in greetings that show ≥1 real issue (not meta)  
4. Dual-path close ≤ 1× per issue  
5. Staff companion tool calls / week  

---

## 7. What is live vs next

### Done (show as progress)

| Item | Status |
|---|---|
| Soft intake ladder | Done |
| Dify intake classify hook + local fallback | Done |
| Anti-stuck + once-only dual-path close | Done |
| Logged-in issue memory + top-3 list + See more | Done |
| Dedup issues (not every chat) | Done |
| OpenClaw companion HTTP API | Done |
| OpenClaw Gateway local + token wired | Done |
| Echo Memory client + Guide write/recall (key optional) | Done — enable with `ECHO_MEM_API_KEY` |
| Manager briefs / setup docs | Done |

### Next (roadmap)

| Priority | Item | Why |
|---|---|---|
| P0 | **Test plan** on real logged-in journeys (below) | Prove KPIs |
| P1 | Richer Dify: Knowledge base of playbooks + multi-intent | Better classify beyond 3 nodes |
| P1 | OpenClaw skill installed + staff Telegram allowlist | Daily ops use |
| P2 | Persist **query objects** table (one row per issue forever) | Cleaner than deriving from sessions |
| P2 | WhatsApp same issue-list UX | Parity |
| P3 | Analytics dashboard for agent KPIs | Leadership visibility |

---

## 8. How to demo for your manager (5 minutes)

1. **Dify Studio** — show Start→LLM→Answer; paste power-cut message → JSON `needs_area: true`.  
   *Say:* “This is only the classifier.”  
2. **Bharosa Ask for help (logged in)** — New chat → hi → **issue list** (not chat spam).  
   Tap voter ID / water → continues that issue.  
3. **New problem** — PAN or Aadhaar → answers new topic without electricity boilerplate.  
4. **OpenClaw dashboard** — “Staff tool, not citizen history.” Show `/v2/companion/tools` curl if useful.  
5. **Close** with architecture diagram from §3.

---

## 9. Testing checklist

### A. Dify classify
- [ ] Power cut → `category=power`, `needs_area=true`  
- [ ] PAN address → `needs_area=false` (or similar)  
- [ ] Telugu power message → still classifies  
- [ ] Stop Dify → Guide still works (heuristic fallback)

### B. Guide ladder + anti-stuck
- [ ] hi → name → problem → (area if local) → help  
- [ ] After electricity help, ask PAN → PAN answer, no TSSPDCL close spam  
- [ ] “thanks” → short bye, no dual-path block  
- [ ] Dual-path close appears at most once for a power issue  

### C. Issue memory (logged in)
- [ ] Raise / discuss water logging + voter ID as real issues  
- [ ] New chat → hi → list shows **those issues**, not “list my queries” lines  
- [ ] Same issue twice → **one** row  
- [ ] Tap issue → focused continue  
- [ ] See more / New problem work  
- [ ] Signed out → no personal issue list (expected)

### D. OpenClaw
- [ ] Gateway up on `18789`  
- [ ] `OPENCLAW_GATEWAY_*` set; API restarted  
- [ ] `GET /v2/companion/tools` with MCP token → 200  
- [ ] Staff chat can list cases (after skill installed)  
- [ ] Citizen Guide still works if Gateway stopped  

### E. Raise path
- [ ] “raise complaint” + phone/email → asks missing fields / draft  
- [ ] Confirm send → email / recorded reference  

---

## 10. Suggested next implementation (if you add one thing)

**`citizen_guide_queries` table** (future):

```text
id | citizen_id | topic_key | title | status | area | playbook_id | last_session_id | updated_at
```

Every time Priya locks onto a **real issue**, upsert by `topic_key`.  
List UI reads this table only → even cleaner than deriving from sessions/memory JSON.

Until then, current dedupe logic already filters meta chats and merges by topic.

---

## 11. One-slide “why these tools”

| Tool | Why we added it | Benefit |
|---|---|---|
| **Dify** | Visual, swappable intake brain | Better classify without hardcoding every phrase; product team can edit flows |
| **OpenClaw** | Staff companion + long memory skills | Ops/leaders ask “what’s open?” in chat; optional enrich |
| **vocal-api Guide** | Real product | Control, tickets, WhatsApp, safety, dual path, issue memory |

**We did not replace My Leader with Dify or OpenClaw — we plugged specialist engines into it.**

---

## Related docs

- `MANAGER_BRIEF_DIFY_OPENCLAW.md` — short talking points  
- `OPENCLAW_FULL_SETUP.md` — install / keys / workflow  
- `COMPANION_SETUP.md` — companion API  
- `AGENT_PLATFORM_PLAN.md` — Phase 0/1/2 decisions  
- `DIFY_SETUP.md` — Dify local setup  
