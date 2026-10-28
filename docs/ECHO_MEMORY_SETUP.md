# Echo Memory — token-efficient Guide context

**Repo:** https://github.com/echo-mem/echo-mem  
**Hosted keys:** https://app.echo-mem.com/keys  
**Protocol:** MCP HTTP — https://echo-mem.com/docs/integration.md  

## Why we added it

| Layer | Role | Token behaviour |
|---|---|---|
| **Postgres** `citizen_guide_memory` | Issue list UI (top 3 water / Aadhaar / voter) | Structured rows — fine for buttons |
| **Dify** | Intake classify only | Tiny JSON |
| **OpenClaw** | Staff companion + optional notes | Not for stuffing full citizen history into Priya |
| **Echo Memory** | Graph of **facts** (citizen↔issue↔area) | Recall only ~8 relevant facts instead of whole chats |

Dumping every past message into the LLM burns tokens. Echo stores **edges** (“Anurag reported water logging in Sector 78”) and `query_memory` returns the few that matter (~97% less context in their published evals).

## How it sits in Bharosa

```text
Citizen turn
   → Postgres issue list (UI)
   → Echo recall (compact facts → Priya prompt)     ← ECHO_MEM_API_KEY
   → Dify classify (needs_area)
   → Answer
   → Echo write_episode (entities + facts)          ← no LLM on Echo write path
   → OpenClaw optional staff mirror
```

## Enable (when vendor gives the key)

In `vocal-api/.env.local` / production:

```bash
ECHO_MEM_API_KEY=em_...                    # from app.echo-mem.com/keys
ECHO_MEM_API_BASE=https://api.echo-mem.com/mcp
# Optional named graph (create at app.echo-mem.com/memories first):
# ECHO_MEM_MEMORY=bharosa-prod
```

Restart `npm run dev`. If the key is **missing**, Echo is skipped — Guide still works with Postgres memory.

## Code

| File | Job |
|---|---|
| `companion/echoMemoryClient.ts` | MCP session pool, `write_episode` / `query_memory` |
| `companion/echoGuideMemory.ts` | Map Guide issues → entities/facts; recall for citizen |
| `companion/citizenMemory.ts` | Enrich prompt + write on problem events |

## Self-host later (optional)

```bash
pip install echo-mem
echo-memory quickstart
# then point ECHO_MEM_API_BASE at your MCP server if exposed
```

Prefer hosted until ops is ready; same client code.

## Test after key arrives

1. Set `ECHO_MEM_API_KEY`, restart API  
2. Logged-in Guide: discuss water logging + area  
3. New chat → hi — prompt should include compact ECHO MEMORY lines (check API logs if needed)  
4. Ask a follow-up — answers should use recalled facts without pasting whole history  
