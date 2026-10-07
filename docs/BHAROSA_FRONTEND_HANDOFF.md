# Bharosa — Frontend Handoff

This document is for the frontend team. It lists every screen to build and the exact API each screen calls, mapped to the manager's flow:

```
Citizen (WhatsApp / App-Web / Email / Call)
   → lodge complaint with location + media proof, constant updates in their language
Org / Party / Team
   → verify (auto) → split into tasks & assign → hold for SLA → generate content (mail/message/post)
   → email the authority directly → public dashboard anyone can check
Public resolution body
   → emails to responsible authority → progress checks → escalation to higher authority
```

**AI does the work, humans approve.** AI structures complaints, writes the verification-call script, proposes the resolution plan and tasks, drafts every email/message/post, follows up, summarizes authority replies and flags escalations. Nothing leaves the system (email, public post) without a human approving it — the citizen approves their own authority email; staff approve the rest.

---

## 0. What changes for the frontend (summary)

| Area | Status | What to build |
|---|---|---|
| **Citizen app (new)** | New | OTP login, complaint wizard (text → location → photos/video → AI summary review → consents → submit), My cases, Case detail with status stepper + timeline, approve/edit the AI-drafted authority email, respond / feedback / reopen, "finish emailed complaint" page |
| **Public pages (new)** | New | Track by link, status lookup by reference number, public dashboard (stats), political feed |
| **Ops console (existing `vocal-web`)** | Add pages | Assisted intake (phone call), Verification queue (AI call script), Case workspace (plan → tasks, communications, escalations, timeline), Task board, Approval queue, Escalations queue, AI review, Directory sources, Feed admin, Settings, Jobs |
| WhatsApp intake | No change | Existing Twilio flow keeps working; citizens now also get status updates on WhatsApp in their language (backend-only) |

Recommendation: build the citizen app as a separate mobile-first PWA (or a separate route tree in `vocal-web` with its own layout). Citizens and staff use different auth tokens and must never share a session.

---

## 1. Basics

### Base URLs
The existing `vocal-web` uses `VITE_API_BASE_URL=…/v1`. All Bharosa endpoints are under **`/v2`**:

| Prefix | Who | Auth |
|---|---|---|
| `/v2/public/*` | Citizens + anonymous public | Citizen token (where noted) |
| `/v2/bharosa/*` | Staff (ops console) | Existing staff JWT (`Authorization: Bearer <staff token>`) |

Add `VITE_API_V2_BASE_URL` (e.g. `https://api.my-leader.in/v2`) rather than string-replacing `/v1`.

### Tenant header (public/citizen app only)
Send `X-Org-Slug: <org slug>` on every `/v2/public/*` call (or `?org=<slug>`). If you omit it, the server uses its default org. Staff calls take the org from the staff token.

### Language
- Supported: `te` (Telugu, default) and `en`.
- Public endpoints accept `?lang=te|en` or `Accept-Language`. Citizen endpoints default to the citizen's `preferred_language`.
- All citizen-facing labels (status names, hints, timeline text) come **already translated** from the API — render them as-is. Only your own UI chrome needs i18n strings.
- Fonts: make sure a Telugu-capable font is loaded (e.g. Noto Sans Telugu).

### Errors
All errors are JSON:
```json
{ "error": "Human readable message", "code": "MACHINE_CODE", "details": {} }
```
`error` is safe to show to users. Switch on `code` where listed. Common statuses: `400` validation, `401` not signed in / bad token, `403` role or ownership, `404`, `409` wrong state, `429` rate-limited (`RATE_LIMITED`, `OTP_COOLDOWN`, `OTP_RATE_LIMIT`), `503` Postgres-only module not available.

### Pagination
List endpoints take `?page=1&limit=25` (max 100) and return `page`, `limit`, and usually `count`.

### Citizen status (what citizens see)
The backend maps internal ticket stages to six citizen statuses (from the flow):

| code | en | te |
|---|---|---|
| `created` | Received | స్వీకరించబడింది |
| `in_verification` | Being verified | ధృవీకరణలో ఉంది |
| `in_progress` | In progress | పురోగతిలో ఉంది |
| `on_hold` | On hold | నిలిపివేయబడింది |
| `resolved` | Resolved | పరిష్కరించబడింది |
| `cancelled` | Closed without resolution | పరిష్కారం లేకుండా మూసివేయబడింది |

Every case response includes a `status` block ready for a stepper:
```json
{
  "code": "in_progress", "label": "In progress", "hint": "Sent to the responsible authority.",
  "on_hold": false,
  "steps": [
    { "code": "created", "label": "Received", "state": "done" },
    { "code": "in_verification", "label": "Being verified", "state": "done" },
    { "code": "in_progress", "label": "In progress", "state": "current" },
    { "code": "resolved", "label": "Resolved", "state": "upcoming" }
  ]
}
```
`state` ∈ `done | current | upcoming | skipped`. Show `on_hold` as a badge on the current step; for `cancelled` show the first step done and the rest skipped.

---

## 2. Citizen app

### 2.1 Startup — `GET /v2/public/config`
No auth. Use it to drive the whole app:
```json
{
  "app_name": "My Leader",
  "languages": ["te","en"], "default_language": "te",
  "otp": { "length": 6, "resend_after_seconds": 45, "ttl_minutes": 10, "mode": "console" },
  "consents": { "text_version": "v1", "required": ["terms","privacy"],
                "optional": ["share_with_authority","whatsapp_updates","contact_by_phone","public_status","location_exact","media_use"] },
  "evidence": { "max_files": 10 },
  "categories": [{ "id": "…", "name": "Roads", "parent_id": null }],
  "features": { "whatsapp_updates": true, "verification_call": true, "public_dashboard": true, "feed": true }
}
```

**Screen: Language select** (first launch) — Telugu / English. Store locally; send it at OTP verify and `PATCH /me`.

### 2.2 Login (OTP to mobile)
**Screen: Enter mobile** → `POST /v2/public/auth/otp/request` `{ "phone": "9876543210" }`
```json
{ "sent": true, "masked_phone": "+91******3210", "expires_in_seconds": 600, "resend_after_seconds": 45, "dev_code": "123456" }
```
- `dev_code` appears only in dev/console mode — prefill it in dev builds only.
- Errors: `INVALID_PHONE`, `OTP_COOLDOWN` (429, message says how many seconds), `OTP_RATE_LIMIT`, `OTP_SEND_FAILED` (503 — show "try again / request assisted call"), `BLOCKED` (403).

**Screen: Enter code** (6 boxes, resend timer from `resend_after_seconds`) → `POST /v2/public/auth/otp/verify`
```json
{ "phone": "9876543210", "code": "123456", "display_name": "Ravi", "language": "te" }
```
→ `{ "token": "<citizen JWT>", "is_new": true, "citizen": { "id", "display_name", "phone", "email", "preferred_language", "whatsapp_opt_in", "phone_verified_at" } }`
- Errors: `INVALID_CODE`, `OTP_INVALID` (401), `OTP_EXPIRED`, `OTP_NOT_FOUND`, `OTP_TOO_MANY_ATTEMPTS`.
- Store the token securely; send `Authorization: Bearer <token>` on citizen calls. On `401` with `CITIZEN_AUTH_REQUIRED` / `CITIZEN_AUTH_INVALID`, return to login.
- Token lasts 30 days (configurable).

**Profile:** `GET /v2/public/me` · `PATCH /v2/public/me` `{ display_name?, preferred_language?, whatsapp_opt_in?, email? }`

### 2.3 Lodge a complaint (wizard)
The wizard saves a **draft submission** at each step, so the citizen can leave and come back.

**Step 1 — Describe** → `POST /v2/public/submissions`
```json
{
  "description": "Ameerpet main road has big potholes…",
  "language": "te",
  "category_hint": "Roads",
  "issue_location":    { "text": "Near metro pillar 1203", "latitude": 17.437, "longitude": 78.448, "source": "map_pin", "precision_m": 15 },
  "reporter_location": { "latitude": 17.44, "longitude": 78.45, "source": "gps", "precision_m": 20 },
  "idempotency_key": "<uuid generated once per wizard>"
}
```
- `description` must be ≥ 10 chars (`DESCRIPTION_REQUIRED`).
- Two locations: **issue location** (where the problem is — map pin or typed) and **reporter location** (where the citizen is now — GPS, optional). `source` ∈ `gps | map_pin | typed | whatsapp_pin`.
- Offer voice-to-text if possible; many users will speak Telugu rather than type.
- Returns the submission (`id`, `status: "draft"`, `evidence: []`, …). Re-sending the same `idempotency_key` returns the same draft (safe on retries).

**Step 2 — Location** (if not captured in step 1) → `PATCH /v2/public/submissions/:id` with any of `description, category_hint, language, issue_location, reporter_location, answers`.

**Step 3 — Photos / video / audio / PDF** (up to 10). Direct upload to S3:
1. `POST /v2/public/submissions/:id/evidence/upload-url` `{ "file_name", "mime_type", "file_size_bytes" }`
   → `{ "upload_url", "storage_path", "method": "PUT", "headers": { "Content-Type": "…" }, "expires_in" }`
2. `PUT` the file bytes to `upload_url` with exactly those `headers`.
3. `POST /v2/public/submissions/:id/evidence` `{ "storage_path", "file_name", "mime_type", "file_size_bytes", "captured_at?", "latitude?", "longitude?", "sha256?" }` → evidence row.
- Remove: `DELETE /v2/public/submissions/:id/evidence/:evidenceId` (204).
- Allowed types: jpeg, png, webp, heic/heif, gif, mp4, mov, mp3, ogg, m4a, pdf. Max 20 MB for images and 60 MB for video/PDF.
- Show per-file progress; compress images client-side when you can.

**Step 4 — AI review** → `POST /v2/public/submissions/:id/structure` (max 10/min)
```json
{
  "submission_id": "…",
  "ai_fallback": false,
  "structured": {
    "title":   { "en": "Potholes on Ameerpet main road", "te": "…" },
    "summary": { "en": "…", "te": "…" },
    "category": "Roads", "severity": "high", "safety_risk": true,
    "issue_location": { "text": "Ameerpet main road near metro", "landmark": "metro pillar 1203" },
    "incident_dates": [], "offices_or_officials_mentioned": [],
    "missing_questions": [{ "key": "since_when", "question_en": "Since when?", "question_te": "ఎప్పటి నుండి?" }],
    "is_civic_issue": true, "out_of_scope_reason": null, "confidence": 0.82
  }
}
```
Show it as **"Here's what we understood — is this right?"**:
- Show title and summary in the citizen's language, editable.
- Show category as a dropdown from `config.categories`.
- Show a severity chip (`critical` / `high` → red).
- Show `missing_questions` as optional inline fields. Save answers with `PATCH …/:id { "answers": { "since_when": "3 months" } }`, then call `/structure` again to refresh the summary.
- If `is_civic_issue` is false, show `out_of_scope_reason` and let the citizen edit or continue anyway.
- If `ai_fallback` is true (AI unavailable), the summary is just their own text. Still let them continue.

**Step 5 — Consents + submit** → `POST /v2/public/submissions/:id/confirm`
```json
{
  "consents": [
    { "type": "terms", "granted": true }, { "type": "privacy", "granted": true },
    { "type": "share_with_authority", "granted": true },
    { "type": "whatsapp_updates", "granted": true },
    { "type": "contact_by_phone", "granted": true },
    { "type": "public_status", "granted": false },
    { "type": "location_exact", "granted": true },
    { "type": "media_use", "granted": false }
  ],
  "edits": { "title": "…", "summary": "…", "category": "Roads" }
}
```
- `terms` and `privacy` are required (`CONSENT_REQUIRED`). Show each optional consent as a toggle with a one-line explanation:
  - `share_with_authority` — "Share my name with the office we email."
  - `whatsapp_updates` — "Send me updates on WhatsApp."
  - `contact_by_phone` — "The team may call me."
  - `public_status` — "Show my case (no name or phone) on the public tracker."
  - `location_exact` — "Share my exact GPS location."
  - `media_use` — "My photos may be used in public posts."
- `NOT_STRUCTURED` (409) means step 4 wasn't run.
- Response: `{ "ticket_id", "ticket_number": "DEM-2026-00001", "tracking_token": "…", "already_confirmed": false }`

**Screen: Submitted** — Show the reference number large with a copy button. Add a share button for the tracker link `https://<app>/track/<tracking_token>`, and offer to save it, because the token is shown only once. Tell them: "We'll verify your complaint. You may get a call."

### 2.4 My cases — `GET /v2/public/cases`
```json
{ "count": 2, "page": 1, "limit": 25,
  "cases": [{ "id", "ticket_number", "title", "category", "area",
              "status": { "code", "label", "hint" },
              "needs_action": true, "pending_approvals": 1, "created_at", "updated_at" }] }
```
Put cases with `needs_action` first and highlight them ("Action needed").

### 2.5 Case detail — `GET /v2/public/cases/:id`
```json
{
  "id", "ticket_number", "title", "summary", "category", "area", "location_text", "language",
  "created_at", "updated_at", "closed_at",
  "status": { …stepper block… },
  "verification_status": "in_verification | verified | failed | unverified",
  "routing_status": "unrouted | suggested | confirmed | uncertain | delivered | bounced",
  "actions": {
    "approve_communications": ["<communication id>"],
    "can_request_authority_email": true,
    "respond_requested": false,
    "can_give_feedback": false,
    "can_reopen": false
  },
  "timeline": [{ "id", "type": "authority_email_sent", "text": "Your complaint was emailed…", "actor": "team | you | authority", "at" }],
  "communications": [ …see 2.6… ],
  "evidence": [{ "id", "file_name", "mime_type", "type": "image", "url": "<signed url>", "created_at" }],
  "consents": { "whatsapp_updates": true, "public_status": false },
  "feedback": null
}
```
Layout:
1. Header: reference number, title, status stepper, hint text.
2. **Action cards** driven by `actions`. Show only the ones that apply:
   - `approve_communications` not empty → "Review the email to the authority" (2.6).
   - `can_request_authority_email` → "Email the responsible office" (2.6).
   - `respond_requested` → "The team needs a reply from you" → text box → `POST /v2/public/cases/:id/respond { "text" }`.
   - `can_give_feedback` → rating form (2.7).
   - `can_reopen` → "Not resolved? Reopen" (2.7).
3. Timeline: a vertical list, newest first or last; `actor` decides the icon.
4. Authority emails: sent emails and authority replies. A reply shows `reply_summary` in the citizen's language, e.g. `{ "en": "…", "te": "…" }`.
5. Evidence gallery (signed URLs expire, so refetch rather than caching long).
6. Privacy settings: `PUT /v2/public/cases/:id/consents { "consents": [{ "type": "public_status", "granted": true }] }` (allowed: share_with_authority, public_status, whatsapp_updates, contact_by_phone, media_use).

Polling: refresh on focus/pull-to-refresh. Citizens also get WhatsApp updates for each step.

### 2.6 Email the authority (citizen-approved)
This is the "email the authorities directly" feature from the flow. The AI drafts; the citizen reviews and approves. Nothing is sent without approval.

1. **Pick office** → `GET /v2/public/cases/:id/authority-suggestions`
   ```json
   { "uncertain": false, "message": null,
     "candidates": [{ "contact_id", "office": "GHMC Ameerpet Circle", "designation": "Assistant Engineer",
                      "department": "Roads", "covers": ["Ameerpet"], "confidence": 0.86, "reason": "Covers Ameerpet; handles Roads" }] }
   ```
   Show as selectable cards (max 3). If `uncertain`, show `message` and a "Let the team decide" option, which just skips this step.
2. **Generate draft** → `POST /v2/public/cases/:id/authority-email`
   `{ "contact_ids": ["…"], "share_name": true, "language": "te", "note": "optional extra instruction to the AI" }`
   → communication (below). Errors: `NO_RECIPIENT`, `ALREADY_DRAFTED` (409), max 5/min.
3. **Review screen** shows `subject`, `body`, and recipients:
   - **Language switch:** `translations` holds both versions, `{ "en": { "subject", "body" }, "te": { … } }`. Switching shows the other version instantly.
   - **Edit:** `PATCH /v2/public/communications/:id { "subject?", "body?", "language?" }`. This returns a **new version with a new id**, so always use the returned id afterwards.
   - **Approve & send:** `POST /v2/public/communications/:id/approve { "language": "te" }` → `status: "queued"`, then `sent` within seconds.
   - **Reject:** `POST /v2/public/communications/:id/reject { "reason?" }`.

Communication shape (citizen view):
```json
{ "id", "channel": "email", "direction": "outbound | inbound",
  "purpose": "authority_complaint | follow_up | escalation | authority_reply",
  "status": "pending_approval | queued | sent | delivered | bounced | failed | received | rejected | superseded",
  "needs_your_approval": true, "language": "te", "subject", "body",
  "translations": { "en": {…}, "te": {…} },
  "recipients": [{ "name", "office", "designation", "email", "kind": "to | cc" }],
  "reply_summary": null, "sent_at", "delivered_at", "created_at" }
```
Follow-ups: if the authority doesn't reply, the AI drafts follow-ups (at 3, 7 and 14 days by default). The citizen approves each one the same way, and they show up in `actions.approve_communications` with a WhatsApp nudge. After the last follow-up, the system drafts an escalation to the next senior officer for staff approval.

**Translate helper** (optional, e.g. to show an English reply in Telugu): `POST /v2/public/translate { "texts": ["…"], "target": "te" }`.

### 2.7 Feedback & reopen
- `POST /v2/public/cases/:id/feedback { "rating": 1-5, "resolved": true|false, "comment?", "reopen?": true }` → `{ ok, reopened }`. Allowed only once the case is closed, and only once per case.
- `POST /v2/public/cases/:id/reopen { "reason" }`. Allowed within 30 days of closure; the reason is required.

### 2.8 Finish an emailed complaint — route `/complete/:token`
Citizens can email a complaint to `complaints@<inbound domain>`. The AI structures it and emails back a link `https://<PUBLIC_APP_URL>/complete/<token>`. The page must:
1. Ask the citizen to log in by OTP (2.2) if they aren't already. Keep the token in memory/session.
2. `POST /v2/public/submissions/claim { "token" }` → the submission, already `status: "structured"`, with `structured_json` filled.
   - `CLAIM_INVALID` (404): the link is expired or wrong.
   - `CLAIM_TAKEN` (409): another account claimed it.
   - `ALREADY_CONFIRMED` (409): it was already submitted.
3. Continue the normal wizard from **Step 3 (photos)** or **Step 4 (review)** using the submission `id`, then confirm (Step 5).

---

## 3. Public pages (no login)

| Page | Endpoint | Notes |
|---|---|---|
| **Track by link** `/track/:token` | `GET /v2/public/track/:token?lang=` | `{ ticket_number, title, category, area, created_at, updated_at, status, timeline[{id,type,text,at}] }`. No personal data. |
| **Status lookup** | `GET /v2/public/status/:ticketNumber?lang=` | Always returns `{ ticket_number, status{code,label}, updated_at, details_public }`. If `details_public` is true it also returns `title, category, area, created_at, status (full stepper), authority_contacted, authority_messages_sent, authority_replied`. If false, show "Details are private". |
| **Public dashboard** | `GET /v2/public/stats?lang=` (cached 5 min) | `total_cases, by_status[{code,label,count}], by_category[{category,total,resolved}], by_area[{area,total,open}], median_resolution_days, created_last_30_days, resolved_last_30_days, authority_emails_sent, authority_response_rate (0–1 or null), daily[{d,created,resolved}] (30 days), generated_at`. Suggested: KPI tiles, donut by status, bar by category/area, 30-day line chart. |
| **Political feed** | `GET /v2/public/feed?lang=&page=` | `items[{ id, title, link, summary, image_url, language, published_at, pinned, source_name }]`. Show pinned items first; open links in a new tab. |

All public endpoints are rate-limited per IP. Show a friendly retry on 429.

---

## 4. Ops console (staff, `vocal-web`)

Staff auth is the existing login. Every call goes to `/v2/bharosa/*` with the staff token.

### 4.1 Roles

| Role | Access |
|---|---|
| `super_admin` | Everything; the only role that can change **Settings** |
| `central_support` (**GRO**) | Everything except settings: all cases, verification, approve plans, approve emails/posts, escalations queue, AI review, directory, feed, jobs |
| `state_leader`, `district_leader` | Read all cases; work their own tasks; can draft authority communications (a GRO approves) |
| `ground_worker`, `legal_support` | Only cases they own, are assigned to, or have a task on; only their own tasks and assigned verification calls. `legal_support` can also draft communications. |
| `media_volunteer` | Feed admin; draft and approve **public posts** only |

Hide nav items by role. The API enforces the same rules and returns 403.

### 4.2 New pages

#### A. Assisted intake (Call channel) — `/intake/call`
For when a citizen phones the office. The staff member types while talking.
1. Form with phone (required), citizen name, language, description, issue location text, and category hint → `POST /v2/bharosa/intake/assisted`
   → `{ submission_id, structured{…same as 2.3 step 4…}, ai_fallback, citizen{ id, display_name, phone, phone_verified } }`.
   If `phone_verified` is true, this person has used the app before; show "Existing citizen".
2. Show the AI summary to **read back to the citizen** and ask the `missing_questions`. Save the answers with `PATCH /v2/bharosa/intake/assisted/:submissionId { "answers": {…}, "restructure": true }`, which returns a refreshed `structured`. The PATCH body accepts the same fields as the citizen PATCH.
3. Optional evidence (e.g. a photo the citizen sent by WhatsApp): `POST …/intake/assisted/:id/evidence/upload-url`, then `PUT` to S3, then `POST …/intake/assisted/:id/evidence`. Same contract as 2.3.
4. Consents checklist labelled **"Citizen agreed verbally"** (terms and privacy required, others optional), then `POST /v2/bharosa/intake/assisted/:id/confirm { consents, edits }` → `{ ticket_id, ticket_number, tracking_token }`.
5. Tell the citizen the reference number. They get a WhatsApp message if they agreed to updates. Because the phone wasn't OTP-verified, the case **always gets a verification call** in the queue.

#### B. Verification queue — `/verification`
`GET /v2/bharosa/verification/queue?status=&mine=true` → `items[]`:
`{ id, ticket_id, ticket_number, title, severity, language, location_text, method: "call", status: "pending | in_progress", mode: "manual | automated", attempt_count, script_json, assigned_user_id, assigned_user_name, citizen_name, citizen_phone, citizen_language, created_at }` (ordered critical first).
- GROs see everything. Others see only checks assigned to them.
- **Claim:** `POST /v2/bharosa/verification/:checkId/assign { "user_id"?: "<id>" | null }` (omit to claim for yourself; only a GRO can assign others).
- **Call screen:** a tap-to-call button with `citizen_phone`, plus the AI script in the citizen's language:
  - `script_json.greeting.te|en`
  - `confirmations[{ key, statement_te, statement_en }]` — read these out and tick each one
  - `questions[{ key, question_te, question_en, why }]` — one answer input per `key`
  - `closing.te|en`
- **Finish:** `POST /v2/bharosa/verification/:checkId/complete`
  `{ "result": "passed | failed | inconclusive", "notes", "answers": { "<key>": "answer" }, "transcript?": "…", "checklist?": {…} }`
  - If you send a `transcript` and no `answers`, the AI extracts the answers.
  - **passed:** the case becomes verified and the AI routes it and drafts a resolution plan automatically.
  - **failed:** a GRO escalation is opened.
- Start another call: `POST /v2/bharosa/cases/:id/verification/call { "mode"?: "manual | automated" }`.
- Other verification methods: `POST /v2/bharosa/cases/:id/verification { "method": "media | field | document", "result", "notes", "checklist" }`.

#### C. Case workspace — `/tickets/:id` (extend the existing detail page)
`GET /v2/bharosa/cases/:id` →
```json
{ "case": { …ticket fields…, "citizen_status": "in_progress", "structured_facts_json", "verification_status", "routing_status",
            "citizen_name", "citizen_phone", "citizen_language", "source_channel", … },
  "verification_checks": [], "plans": [], "tasks": [], "communications": [], "escalations": [], "consents": [] }
```
Tabs:
1. **Overview:** AI facts, both locations on a map, evidence, consents, and a channel badge (whatsapp / web / email / call).
2. **Plan** (GRO): the latest plan where `status = "pending_approval"`. `plan_json` has:
   - `summary`, `issue_type`, `category`, `responsible_parties[{contact_id, description, why}]`, `risks[]`, `confidence`, `ai_fallback`
   - `steps[{ title, description, task_type, suggested_role, due_in_hours, depends_on_index, authority_contact_id, evidence_required[] }]`
   - `questions_for_gro_json` — show it prominently.

   UI: an editable step list, plus an owner picker per step (filter staff by `suggested_role`).
   - **Approve:** `POST /v2/bharosa/plans/:planId/approve { "owners": { "0": "<userId>", "2": "<userId>" }, "plan"?: <edited plan_json>, "reason"? }` → `{ plan, tasks[] }`.
   - **Reject:** `POST /v2/bharosa/plans/:planId/reject { "reason" }`.
   - **Regenerate:** `POST /v2/bharosa/cases/:id/plans/generate`.
3. **Tasks:** see D, filtered with `?ticket_id=`.
4. **Communications:** the thread (outbound, plus inbound replies with `summary_json`).
   - Draft new: `POST /v2/bharosa/cases/:id/communications/draft { "format", "contact_ids?"|"emails?", "language", "instructions?", "task_id?", "escalation_level?" }`.
   - `format` ∈ `authority_email | follow_up_email | escalation_email | letter | whatsapp_message | social_post | citizen_update`. These are the "generate content (mail, message, post)" items from the flow.
   - Thread detail: `GET /v2/bharosa/communications/:commId` → `{ communication, events[], versions[] }`, where events are created/approved/sent/delivered/bounced/reply_received.
   - Edit (staff-owned drafts only): `PATCH /v2/bharosa/communications/:commId { subject?, body?, language?, contact_ids?|emails? }` (returns a new version id).
   - Approve / reject: `POST …/:commId/approve { language? }` · `POST …/:commId/reject { reason }`.
   - Letters / posts sent outside the system: `POST …/:commId/mark-sent { note? }`.
   - Manual follow-up: `POST …/:commId/follow-up { instructions? }`.
   - Drafts the citizen must approve show "Waiting for citizen". Staff get 403 if they try to approve or edit these.
   - Authority reply `summary_json`: `{ classification: acknowledged | action_promised | action_taken | needs_information | redirected | rejected | auto_reply | unclear, internal_summary, citizen_summary{en,te}, commitments[], information_requested[], redirected_to, suggested_next_step, confidence }`.
5. **Routing:** `POST /v2/bharosa/cases/:id/routing/suggest` → candidates with confidence and reasons.
6. **Escalations on this case:** list them, plus a manual "Escalate to GRO" action: `POST /v2/bharosa/cases/:id/escalations { "reason", "task_id?" }`.
7. **Timeline (audit):** `GET /v2/bharosa/cases/:id/timeline?visibility=all|internal|citizen|public` → `events[{ id, event_type, actor_type, actor_label, visibility, summary, reason, data_json, created_at, … }]`. Show visibility as a chip ("Citizen sees this").
8. **New tracker link** (GRO): `POST /v2/bharosa/cases/:id/tracking-token` → `{ tracking_token }`. This invalidates the old link.

#### D. Task board — `/tasks`
`GET /v2/bharosa/tasks?status=assigned,in_progress&owner_id=&ticket_id=&mine=true&overdue=true` → `{ tasks[], count }`.
Each task has:
- `id, title, description, task_type, status, owner_user_id, owner_name, suggested_role`
- `due_at, effective_due_at`: show `effective_due_at`, which is the due date pushed back by time spent on hold
- `sla_paused_at, sla_paused_seconds, hold_reason, cancel_reason`
- `depends_on_task_id, plan_id, authority_contact_id, evidence_required_json`
- `ticket_ids[], ticket_numbers[]`: one task can cover several cases
- `created_at, updated_at`

Statuses (sub-task lifecycle from the flow) and allowed moves:

| From | Can move to |
|---|---|
| `unassigned` | assigned, cancelled |
| `assigned` | picked_up, unassigned, on_hold, cancelled |
| `picked_up` | in_progress, on_hold, waiting_for_reply, cancelled, closed |
| `in_progress` | on_hold, waiting_for_reply, cancelled, closed |
| `on_hold` | in_progress, picked_up, cancelled |
| `waiting_for_reply` | in_progress, on_hold, cancelled, closed |
| `cancelled`, `closed` | (GRO can reopen) |

- **Change status:** `POST /v2/bharosa/tasks/:taskId/status { "status", "reason?" }`.
  - `on_hold` and `cancelled` **require a reason**. `on_hold` pauses the SLA clock (the "hold for SLA" step in the flow).
  - `INVALID_TRANSITION` (409) returns `details.allowed`. Build the action buttons from the table above.
  - The API returns 409 when the task it depends on is still open.
- Summary counts for board headers: `GET /v2/bharosa/tasks/summary` → `{ counts: { "<status>": n } }`.
- Create (GRO): `POST /v2/bharosa/tasks { title, ticket_ids[], description?, task_type?, owner_user_id?, suggested_role?, due_at?, depends_on_task_id?, authority_contact_id?, evidence_required? }`.
- Edit: `PATCH /v2/bharosa/tasks/:taskId { title?, description?, owner_user_id? (GRO only), due_at?, task_type?, depends_on_task_id? }`.
- Detail with history: `GET /v2/bharosa/tasks/:taskId` → `{ task, history[] }`.
- Link or unlink cases (GRO): `POST /v2/bharosa/tasks/:taskId/links { ticket_ids[], unlink?: true }`. A task must keep at least one case.
- `task_type` ∈ `general | verification | field_visit | contact_authority | follow_up | document | citizen_contact | escalation`.
- Suggested views: a Kanban board by status, and "My tasks" for field roles. Mark overdue items red, using `effective_due_at < now` while the task isn't on hold.

#### E. Approval queue — `/approvals` (GRO, media volunteer for posts)
`GET /v2/bharosa/communications/approvals` → staff-approvable drafts (authority emails drafted by staff, follow-ups/escalations, WhatsApp messages, letters, social posts), oldest first. Each list item has `id, ticket_id, ticket_number, ticket_title, channel, purpose, language, subject, recipients_json, version, created_at`; it doesn't include the body. When a card opens, load `GET /v2/bharosa/communications/:commId` for `body` and the en/te toggle (`translations_json`). Actions are **Approve / Edit / Reject**. Media volunteers see only `public_post` items.

#### F. Escalations queue — `/escalations` (GRO)
`GET /v2/bharosa/escalations?status=open|acknowledged|resolved|dismissed&target=gro|authority&ticket_id=` → `{ escalations[], count }`.
Each escalation has: `id, ticket_id, task_id, communication_id, target, level, trigger_type, reason, target_contact_id, status, created_by_agent, created_at, …`.

`trigger_type` labels:

| trigger_type | Label |
|---|---|
| `sla_breach` | SLA breached |
| `task_overdue` | Task overdue |
| `no_reply` | Authority didn't reply |
| `bounce` | Email bounced — fix contact |
| `ai_uncertain` | AI needs a human decision |
| `citizen_reopen` | Citizen unhappy / reopened |
| `manual` | Raised by staff |

Actions: `POST /v2/bharosa/escalations/:escId/status { "status": "acknowledged | resolved | dismissed", "note" }`. A note is **required** to resolve or dismiss. Link each row to the case workspace.

#### G. AI review — `/ai` (GRO)
- `GET /v2/bharosa/ai-runs?agent=&ticket_id=&status=&include_output=true` → `runs[{ id, agent, model, status: succeeded|failed|fallback|invalid_output, confidence, latency_ms, error, review_decision, created_at, output_json? }]`.
- `GET /v2/bharosa/ai-runs/metrics` → per agent over 30 days: `runs, succeeded, failed, accepted, edited, rejected, avg_latency_ms`.
- Review: `POST /v2/bharosa/ai-runs/:runId/review { "decision": "accepted | edited | rejected", "notes?" }`.
- Agents: `structuring, routing, resolution, content, response_summary, verification_call, translation`.

#### H. Authority directory sources — extend `/directory` (GRO)
These automatically refresh the authority contact list from official JSON/CSV URLs.
- `GET/POST /v2/bharosa/directory-sources` and `PATCH /v2/bharosa/directory-sources/:sourceId`. Body: `{ name, url (public https), format: json|csv, refresh_interval_hours (default 168), field_map?, active? }`.
  - `field_map` keys: `records_path, external_ref, contact_name, organization_name, role_designation, department, email, phone, whatsapp, jurisdiction_level, escalation_level, territory_name, territory_code, categories`. Defaults: `id, name, office, designation, department, email, phone, whatsapp, jurisdiction_level, escalation_level, territory, territory_code, categories`.
- Refresh now: `POST /v2/bharosa/directory-sources/:sourceId/refresh` → `{ stats: { fetched, created, updated, skipped, outdated, unmatched_territories } }`.
- Health: `GET /v2/bharosa/directory/health` → contacts needing attention (outdated, bounced, no email, or not verified in 180 days).
- Contacts gained these fields: `department, jurisdiction_level, escalation_level (1 = first point of contact, higher = more senior), parent_contact_id, whatsapp, is_public_authority, last_verified_at, bounce_count`. Show them in the existing directory editor. Only `is_public_authority = true` contacts with an email are offered to citizens.

#### I. Feed admin — `/feed` (GRO, media volunteer)
- Sources: `GET/POST /v2/bharosa/feed/sources`, `PATCH|DELETE /v2/bharosa/feed/sources/:sourceId`, `POST …/:sourceId/refresh`. Body: `{ name, url, kind: rss|atom|json|link, language?: te|en, refresh_minutes? (5–1440), active? }`.
- Items: `GET /v2/bharosa/feed/items?source_id=`, `PATCH /v2/bharosa/feed/items/:itemId { pinned?, hidden? }`, and manual add `POST /v2/bharosa/feed/items { link, title?, summary?, language?, pinned? }` (the preview is fetched automatically).
- URLs pointing at private or internal addresses are rejected (400).

#### J. Settings — `/admin/bharosa-settings` (read: GRO, write: super_admin)
`GET /v2/bharosa/settings` · `PATCH /v2/bharosa/settings` (deep-merge; send only changed keys):
```json
{
  "languages": ["te","en"], "defaultLanguage": "te",
  "otp": { "ttlMinutes": 10, "maxVerifyAttempts": 5, "resendCooldownSeconds": 45, "maxSendsPerPhonePerHour": 5, "maxSendsPerIpPerHour": 20 },
  "verification": { "callAfterCreate": true, "callMode": "manual", "fieldVisitCategories": [] },
  "routing": { "minConfidence": 0.6, "maxCandidates": 5 },
  "followUp": { "intervalsHours": [72, 168, 336], "escalateAfterLastFollowUp": true },
  "escalation": { "taskInactivityHours": 72, "unverifiedCaseHours": 24 },
  "email": { "senderMode": "platform", "footer": { "en": "…", "te": "…" } },
  "notifications": { "whatsappEnabled": true, "smsFallback": false }
}
```
Build it as a grouped form. `intervalsHours` is a list of numbers; show them as days.

#### K. Jobs — extend `/jobs` (GRO)
`GET /v2/bharosa/jobs?status=queued|running|succeeded|failed|dead&type=` · `POST /v2/bharosa/jobs/:jobId/retry` (dead/failed only). Show `last_error` for failed jobs.

### 4.3 Dashboard additions (existing `/dashboard`)
Useful tiles, all available from the endpoints above:
- Verification queue size
- Plans awaiting approval: open `ai_uncertain` escalations, or cases with a pending plan
- Approvals pending
- Open escalations by trigger
- Overdue tasks (`/tasks?overdue=true`)
- The public stats block

---

## 5. Flow → screen map (for QA)

| Flow step | Citizen sees | Staff does | Endpoint(s) |
|---|---|---|---|
| Lodge via App/Web | Wizard 2.3 | — | `/v2/public/submissions…` |
| Lodge via WhatsApp | Existing bot | — | (existing) |
| Lodge via Email | Email reply with link → 2.8 | — | inbound webhook → `/submissions/claim` |
| Lodge via Call | WhatsApp confirmation | Assisted intake 4.2-A | `/v2/bharosa/intake/assisted…` |
| Location + media proof | Steps 1–3 | — | evidence upload-url / evidence |
| Verify (auto) | "Being verified", may get a call | Verification queue 4.2-B | `/verification/…` |
| Split into tasks & assign | "In progress / action plan prepared" | Plan approve 4.2-C | `/plans/:id/approve` |
| Hold for SLA | "On hold" badge | Task → on_hold + reason | `/tasks/:id/status` |
| Generate content | — | Draft email/message/post | `/communications/draft` |
| Email authority directly | Approve the draft 2.6 | Or approve staff drafts 4.2-E | `/communications/:id/approve` |
| Progress check / follow-up | Approve follow-ups | Approve follow-ups | automatic + approvals |
| Escalate to higher authority | "Escalated to a senior officer" | Approve the escalation email; escalation queue 4.2-F | automatic + `/escalations` |
| Authority replies | Reply summary in their language | Review AI summary, next step | inbound webhook |
| Updates in their language | WhatsApp + timeline | — | automatic |
| Public dashboard / verify status | 3. Public pages | — | `/v2/public/stats`, `/status`, `/track` |
| Resolved / Cancelled | Feedback, reopen 2.7 | Close case (existing flow) | `/feedback`, `/reopen` |

---

## 6. Things the backend team still needs to configure (not frontend work)

- **SMS OTP in India:** needs the Exotel DLT template approval. Until then, OTP goes via Twilio or console.
- **Automated verification calls:** the voice-agent provider isn't chosen yet. Calls run as an assisted (manual) queue with the AI script, which works today.
- **Email sending:** SES production access, the sender domain, the inbound domain MX + receipt rule → SNS → `/webhooks/bharosa/ses`, and the intake address `complaints@<inbound domain>`.
- **WhatsApp update templates:** approved Twilio content templates (te/en) for messages outside the 24-hour window.

Frontend can build everything against a dev API with `OTP_DELIVERY_MODE=console` (OTP shown in the response) and `EMAIL_DELIVERY_MODE=console`.
