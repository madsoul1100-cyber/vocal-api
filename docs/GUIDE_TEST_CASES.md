# Priya Guide — conversation test cases (top 20 playbooks)

**Purpose:** Dummy multi-turn chats that prove Priya is proficient, elegant, and gives proper guidance — before / after manager feedback on which conversation styles to keep.

**Date:** Oct 2026  
**Agent:** Priya (Bharosa / My Leader Guide)  
**Coverage:** All 20 Telangana playbooks + ladder / topic-switch / dual-path / email behaviours from `FULL_AGENT_ARCHITECTURE.md`

**How to run:** with `vocal-api` on `:3001`,

```bash
node scripts/guide-conversation-evals.mjs
```

---

## 1. What we are testing (chat types)

| Type | Code | What it proves | Typical length |
| ---- | ---- | -------------- | -------------- |
| Soft ladder — local civic | `ladder_local` | greet → name → problem → **area** → help | 5–7 user msgs |
| Soft ladder — self-serve ID | `ladder_self` | greet → name → problem → help (**no** area spam) | 4–6 user msgs |
| Direct problem (skip greet) | `direct` | Citizen dumps the issue first; still classifies | 1–3 msgs |
| Multi-issue same chat | `multi` | Light + water, or power then another civic | 6–10 msgs |
| Topic switch self-serve | `switch` | After electricity help, ask PAN/Aadhaar — **no old boilerplate** | 5–8 msgs |
| Dual-path close once | `dual_once` | Official call/email path + desk escalate offered **≤1×** | 4–6 msgs |
| Raise / email draft | `email` | Ask mail → collect name/mobile/email/place → draft | 4–7 msgs |
| Thanks / goodbye | `bye` | “thanks” → short bye, **no** dual-path spam | 3–5 msgs |
| Vague → clarify | `vague` | “problem in my area” → ask what / where, then help | 4–6 msgs |
| Language mix | `lang` | Telugu / Hindi openers still land on right playbook | 2–4 msgs |
| Follow-up depth | `followup` | “then what?”, “documents?”, “old mobile lost” | 4–7 msgs |

These are the **kinds of chats** we generate. Manager can cut / rename types after review.

---

## 2. Who we help (user personas)

| Persona | Profile | Issues they bring | Language |
| ------- | ------- | ----------------- | -------- |
| **Ravi** | Young professional, logged-out web | Aadhaar mobile, PAN name | English |
| **Lakshmi** | Homemaker, colony resident | Water supply, garbage, streetlight | Telugu-leaning English |
| **Suresh** | Auto / daily wage | Power cut, sewer, manhole | English + short Telugu |
| **Fatima** | First-time voter / student | Voter address, ration card | English |
| **Venkat** | Bill-conscious resident | Wrong power bill, water leak | English |
| **Anitha** | Senior / pension | Aasara pension stopped | English / Hindi |
| **Imran** | Driver | DL address, LPG transfer | English |
| **Meena** | Parent of newborn | Birth certificate (MeeSeva) | English |
| **Kiran** | Frustrated multi-problem | Power → then roads → then “raise complaint” | English |
| **Priya-user** | Polite, says thanks early | Single streetlight, then bye | English |

Each eval chat tags a persona so reports stay readable for the manager.

---

## 3. Top 20 problems (playbooks under test)

| # | Playbook id | Mode | Needs area? |
| - | ----------- | ---- | ----------- |
| 1 | `aadhaar_mobile` | self_serve | no |
| 2 | `aadhaar_address` | self_serve | no |
| 3 | `aadhaar_name_dob` | self_serve | no |
| 4 | `pan_correction` | self_serve | no |
| 5 | `voter_update` | self_serve | no |
| 6 | `ration_card` | self_serve | no |
| 7 | `transport_update` | self_serve | no |
| 8 | `lpg` | self_serve | no |
| 9 | `certificates` | self_serve | no |
| 10 | `power_outage` | department | yes |
| 11 | `power_bill` | department | yes* |
| 12 | `water_supply` | department | yes |
| 13 | `roads` | department | yes |
| 14 | `sewer` | department | yes |
| 15 | `garbage` | department | yes |
| 16 | `streetlight` | department | yes |
| 17 | `water_leak` | department | yes |
| 18 | `pension` | department / grievance | often no |
| 19 | `manhole` | department | yes |
| 20 | `encroachment` | department | yes |

\*Bill disputes still benefit from place / service number; ladder may ask area when classifier says so.

---

## 4. Success criteria (scorecard)

A **chat passes** only if every checked criterion for that chat type is met. Overall **success rate** = passed chats / total chats.

### Global (every chat)

| ID | Criterion | Fail if |
| -- | --------- | ------- |
| G1 | Reply is non-empty and ≥ ~60 chars of real guidance | empty / “I don’t know” only |
| G2 | Correct playbook `problem.id` when a topic is locked | wrong id or none after clear problem |
| G3 | No invented private data ask (Aadhaar number, OTP, bank PIN) | asks for OTP / full Aadhaar / bank password |
| G4 | Warm Priya tone; not a raw FAQ dump only | robotic single paste with no next step |
| G5 | No “I do not have a Telangana script” | script-miss phrase |

### Ladder

| ID | Criterion | Fail if |
| -- | --------- | ------- |
| L1 | After greet, asks for **name** (or accepts name) before deep help | jumps to long civic close with no name path |
| L2 | Asks **problem** before area | area first |
| L3 | Local civic: asks **area/address** when needed | never asks place for power/water/roads |
| L4 | Self-serve ID: does **not** force colony address | insists on street for Aadhaar/PAN |

### Guidance quality

| ID | Criterion | Fail if |
| -- | --------- | ------- |
| Q1 | Official step or number present (e.g. 1912, UIDAI, MeeSeva, website) | only “we will look into it” |
| Q2 | Dual-path style for department: official **and** desk/record option somewhere once | only “call 1912” forever, or escalate every turn |
| Q3 | Topic switch: new topic answer; **no** previous electricity/TSSPDCL spam | old close pasted after PAN ask |
| Q4 | “thanks” → short goodbye; dual-path **not** re-offered | full escalate block after thanks |
| Q5 | Email path: draft or clear ask for missing email/phone/place | ignores “please email” |

### Measurable KPIs (architecture §6)

| KPI | Target for this eval batch |
| --- | -------------------------- |
| Local issues with area collected before deep escalate | ≥ 80% of `ladder_local` chats |
| Topic switches without old boilerplate | 100% of `switch` chats |
| Dual-path close ≤ 1× per local issue | 100% of `dual_once` chats |
| Playbook match accuracy (clear openers) | ≥ 90% of `direct` + ladder problem turns |

---

## 5. Sample conversations (illustrative)

Full scripted turns live in `scripts/guide-conversation-evals.mjs`. Examples below for manager skim.

### Chat A — `ladder_local` / Suresh / power

1. User: `Hi`  
   Expect: Priya intro + ask name  
2. User: `Suresh`  
   Expect: ask what the problem is  
3. User: `No electricity since morning`  
   Expect: classify `power_outage`, ask area  
4. User: `H.No 12-3, Manchirevula, Narsingi, 500089`  
   Expect: 1912 / TGSPDCL guidance + dual-path close **once**  
5. User: `thanks`  
   Expect: short bye, no second escalate block  

### Chat B — `ladder_self` / Ravi / Aadhaar mobile

1. `Hello` → name ask  
2. `Ravi` → problem ask  
3. `Need to change mobile on Aadhaar` → `aadhaar_mobile` steps, **no** colony demand  
4. `Old number is lost` → centre / 1947 path, no OTP request  

### Chat C — `switch` / Kiran

1–3. Power cut + area → help + one close  
4. `Also I need to correct name on my PAN` → `pan_correction`, **zero** TSSPDCL/1912 spam  

### Chat D — `email` / Anitha / pension

1. `My Aasara pension stopped` → `pension` guidance  
2. `Please email the department. Name Anitha, mobile 9876543210, email anitha@example.com, place Warangal`  
   Expect: draft or confirm-send path  

### Chat E — `multi` / Lakshmi

1. Street light dead + area → `streetlight`  
2. `Garbage also not collected on same street` → `garbage`, still useful, not stuck only on lights  

---

## 6. Batch design (this eval run)

| Bucket | Chats | Approx user messages |
| ------ | ----- | -------------------- |
| Soft ladder × 20 playbooks (`P01`–`P20`) | 20 | ~70 (3–4 turns each) |
| Behaviour: switch, dual-once, bye, multi, vague, lang×2, email×2, followup×2 | 10 | ~45 |
| **Total** | **30 chats** | **~110–120 user messages** |

**Important:** “Direct dump of problem” is **not** scored as failure when Priya first asks for name — that matches the soft ladder. Playbook match is scored on the problem turn **after** name.

Anonymous (`X-Org-Slug: demo`) — issue-memory (logged-in top-3) is a **separate** checklist in architecture §9.C; not scored in this batch unless JWT is provided later.

---

## 7. Latest run (local, Oct 2026) — after fix loop

| Metric | Baseline | After loop |
| ------ | -------- | ---------- |
| Chats | 31 | 31 |
| User messages | 119 | 119 |
| **Overall success** | **19/31 (61.3%)** | **31/31 (100%)** |
| Top-20 soft ladder | 15/20 | **20/20** |
| Self-serve / local / switch / email / lang | Mixed | **All pass** |

### Fixes shipped in the loop

1. **Address ≠ roads** — place replies (“Road No. 4, KPHB”) no longer rematch `roads`; roads hint needs pothole/damage signal.
2. **Lock playbook before area** — `problem.id` set when asking colony so clients/evals see the topic.
3. **Unicode ladder** — JS `\b` does not work for Telugu/Hindi; problem hints use Unicode boundaries so కరెంట్ / आधार are problems, not names.
4. **Telugu names** — allow virama/marks in bare names; don’t title-case Indic scripts.
5. **Ladder prompts v2** — don’t re-ask “full name” once known; Te/Hi seeds say పేరు / नाम.

Raw JSON: `tmp/guide-eval-last.json`.

---

## 8. After manager feedback

Tell engineering which to keep / cut / rewrite:

- More Telugu-native full chats?  
- Shorter “elegant” replies vs longer step lists?  
- Harder multi-issue (3+ problems)?  
- WhatsApp-style short messages only?  
- Must-pass criteria to promote to CI?

Then we regenerate the `.mjs` scenarios and re-run for a new success rate.

---

## Related

- `FULL_AGENT_ARCHITECTURE.md` — product brain + KPI list  
- `scripts/guide-mock-chats.mjs` — older single-turn smoke (20 openers)  
- `scripts/guide-conversation-evals.mjs` — multi-turn eval + scorecard  
