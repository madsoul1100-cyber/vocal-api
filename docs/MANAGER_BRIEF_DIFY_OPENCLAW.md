# Manager brief — Dify + OpenClaw in Bharosa / My Leader Guide

**Audience:** product / engineering leadership  
**Date:** Oct 2026  
**Owner:** Bharosa agent workstream  

---

## 1. One-sentence summary

We upgraded **Priya (citizen Guide chat)** from a sticky, script-heavy bot into a **personal help agent** that classifies problems better (Dify), remembers returning citizens (our memory + OpenClaw), and gives staff a companion view of open work — without putting citizens through a third-party chat product.

---

## 2. How the system works (simple picture)

```text
CITIZEN (web / WhatsApp)
        │
        ▼
 ┌─────────────────────────────────────────┐
 │  vocal-api  —  Priya (Guide)            │  ← always the citizen-facing brain
 │  • asks name → problem → area if needed │
 │  • answers steps / raises with desk     │
 │  • saves memory for logged-in users     │
 └───────────────┬─────────────┬───────────┘
                 │             │
        classify │             │ optional enrich + staff tools
                 ▼             ▼
           ┌─────────┐   ┌──────────────┐
           │  Dify   │   │  OpenClaw    │
           │ intake  │   │  Gateway     │
           │ flows   │   │  (staff +    │
           │         │   │   memory)    │
           └─────────┘   └──────────────┘
```

| Layer | Who uses it | Job |
|---|---|---|
| **Guide (Priya) in vocal-api** | Citizens | Conversation, advice, raise complaint, dual path (official + help desk) |
| **Dify** | Backend only | Classify “what is this problem?” and “do we need area?” — better routing |
| **OpenClaw** | Staff / leaders (+ optional memory enrich) | Long-lived companion: open cases, drafts, citizen memory briefing |
| **Postgres memory** | System | Source of truth for returning logged-in citizens |

**Important:** Citizens never chat inside Dify or OpenClaw. Those are engines behind Priya / for staff.

---

## 3. Why we set up **two** platforms (not one)

| Need | Best fit | Why not the other alone |
|---|---|---|
| Structured intake / classify / “needs local area?” | **Dify** (chatflows / workflows) | OpenClaw is a personal agent runtime, not a multi-citizen intake factory |
| Staff companion + long memory + tool calls to our API | **OpenClaw** | Dify is workflow/RAG oriented; not our staff messaging companion |
| Citizen chat at scale + Twilio + cases | **vocal-api (already built)** | Neither Dify nor OpenClaw should own citizen WhatsApp as primary |

So: **Dify = smarter intake brain**, **OpenClaw = staff memory companion**, **vocal-api = product**.

---

## 4. Problems we had → what we fixed

| Before | Pain | After |
|---|---|---|
| Bot stuck on first issue (e.g. electricity) | User asks about PAN; bot still dumps power Help Desk boilerplate | Topic switch + answer **only the latest question**; dual-path close **once** per local issue |
| Same 3-paragraph close every turn | Felt robotic; “thanks” still got escalation spam | Short thanks → short goodbye; self-serve topics (PAN/Aadhaar) skip civic close |
| Area asked too early / or never for local issues | Bad ladder (greet → dump scripts) | Soft ladder: name → **problem first** → area **only if needed** (Dify + heuristics) |
| Returning citizen = blank slate | No context of past cases / area / habits | Logged-in **persistent memory** (problems, areas, behavior); welcome “continue or new?” |
| Staff couldn’t ask “what’s open?” in chat | Dig admin UI / DB | OpenClaw calls `/v2/companion` (cases, drafts, memory, nudge draft) |
| “Just call 1912” style answers | Not a personal agent; weak political/help-desk path | Dual path: official department **and** help desk / leadership escalate when filing |

---

## 5. Benefits & growth of the agent

### For citizens
- Feels like a **personal agent**, not a FAQ dump  
- Remembers them when logged in (name, area, open issues)  
- Can change topic without fighting the bot  
- Clear choice: self-serve official steps **or** raise via our desk  

### For operations / party help desk
- OpenClaw briefing: open tickets, unfinished Guide drafts, citizen memory  
- Nudge **drafts** for unfinished chats (send still via Twilio — controlled)  
- Less repeated “stuck” chats → fewer frustrated escalations  

### For product / growth
- **Higher completion** of intake (right questions in right order)  
- **Higher trust** for returning users (memory)  
- **Staff leverage** without building a second CRM chat from scratch  
- Clear architecture: we can improve Dify flows or OpenClaw skills **without rewriting** the citizen app  

### Measurable signals to track next (suggested KPIs)
1. % chats that switch topic successfully (no old-issue boilerplate)  
2. % local issues where area is collected before escalate  
3. Returning logged-in users who get a memory welcome  
4. Staff companion queries / week (cases + memory)  
5. Dual-path close shown ≤ 1× per problem (quality)  

---

## 6. What each tool contributes going forward

| Next 2–4 weeks | Owner stack |
|---|---|
| Better Telugu/Hindi classify for power / drain / PAN | **Dify** intake app |
| More staff skills (summary of citizen journey, draft PRAJAVANI note) | **OpenClaw** + companion APIs |
| Richer memory (preferences: prefers desk vs self-serve) | **Postgres memory** (already wired) |
| Keep WhatsApp / Guide on vocal-api | **No change** — safety & tenancy |

---

## 7. Talking points for leadership (30 seconds)

1. **We did not replace our product with Dify or OpenClaw** — we plugged them in as specialist engines.  
2. **Dify** makes intake smarter (what problem + need area?).  
3. **OpenClaw** gives staff a chat companion with our live data + optional memory enrich.  
4. **Citizen Guide** is fixed where it hurt most: stuck topics, spam closes, no memory.  
5. **Result:** a personal agent path that can grow (more flows, more staff tools) without locking citizens into someone else’s multi-tenant chat.  

---

## 8. Status (as of this work)

| Item | Status |
|---|---|
| Soft intake ladder + dual path | Done |
| Stuck-topic / boilerplate fix | Done |
| Dify intake classify hook | Done (local Dify + env) |
| Citizen persistent memory (logged-in) | Done (migration + Guide wire) |
| OpenClaw companion HTTP tools | Done (`/v2/companion`) |
| OpenClaw Gateway on Mac + token in `.env.local` | Done / running locally |
| Staff skill copy + Telegram allowlist | Next (ops) |
| KPI dashboard for agent quality | Next (product) |
