# React Native — Chat Paste & Screenshot Ticket Intake

This document describes how to integrate the **paste chat or upload screenshot → auto-fill form → review → submit** flow in the React Native app.

## Overview

Staff can file a ticket from a citizen chat in two ways:

1. **Paste text** — copy the conversation and paste it.
2. **Screenshot** — take a photo of the WhatsApp/Telegram chat screen and upload it. Vision AI reads the image and fills the same form.

```
┌──────────────────────┐     extract-from-chat        ┌──────────────────┐
│  Paste chat text     │ ───────────────────────────► │  Pre-filled form │
│  + Generate          │                              │  (editable)      │
└──────────────────────┘                              └────────┬─────────┘
┌──────────────────────┐     extract-from-chat-image          │ Submit
│  Chat screenshot(s)  │ ───────────────────────────►         ▼
│  + Generate          │                         POST worker-intake
└──────────────────────┘
```

**Two API calls per flow:**

1. **Extract** — parses chat (text or image), returns suggested field values (no ticket created).
2. **Submit** — creates the ticket after review.

---

## Auth

All endpoints require a staff JWT:

```
Authorization: Bearer <access_token>
```

Obtain the token via existing login (`POST /v2/auth/login` or `POST /v2/auth/otp/verify`).

**Allowed roles:** `super_admin`, `central_support`, `state_leader`, `district_leader`, `ground_worker`

---

## Step 1 — Extract fields from pasted chat

### Request

```
POST /v2/tickets/worker-intake/extract-from-chat
Content-Type: application/json
Authorization: Bearer <token>
```

```json
{
  "chat_text": "Ramesh: Namaste sir, naku road problem undi\nWorker: Cheppandi\nRamesh: Main road lo gaddi perigindi, Sircilla center daggara. Na peru Ramesh Kumar, number 9876543210"
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `chat_text` | string | Yes | Full pasted conversation. Max 16,000 characters. Alias: `text` |

### Success response `200`

```json
{
  "ok": true,
  "fields": {
    "citizen_name": "Ramesh Kumar",
    "citizen_phone": "+919876543210",
    "address": "Main road near Sircilla center",
    "description": "Grass/weeds overgrown on the main road near Sircilla center, causing civic nuisance.",
    "latitude": null,
    "longitude": null
  },
  "confidence": {
    "citizen_name": 0.92,
    "citizen_phone": 0.95,
    "address": 0.78,
    "description": 0.88,
    "latitude": 0,
    "longitude": 0
  },
  "missing_fields": [],
  "extraction_notes": null,
  "ai_used": true,
  "source": "text"
}
```

### Response fields

| Field | Description |
|-------|-------------|
| `fields` | Suggested values for the intake form. `null` when not found. |
| `confidence` | Per-field score `0.0`–`1.0`. Use to highlight low-confidence fields. |
| `missing_fields` | Required fields that could not be extracted reliably. Show these as empty + highlighted. |
| `extraction_notes` | Optional reviewer hint (e.g. blurry screenshot, two phone numbers). |
| `ai_used` | Always `true` on success. |
| `source` | `"text"` or `"image"` |
| `screenshot_count` | Present when `source` is `"image"` |

### Error responses

| Status | Body | When |
|--------|------|------|
| `400` | `{ "error": "chat_text is required" }` | Empty paste |
| `400` | `{ "error": "chat_text must be at most 16000 characters" }` | Too long |
| `403` | `{ "error": "Your role cannot use chat intake extraction" }` | Wrong role |
| `503` | `{ "error": "AI extraction is not configured..." }` | Server AI not set up |

---

## Step 1b — Extract from chat screenshot(s)

Use when the user screenshots WhatsApp/Telegram instead of copying text. Vision AI reads the image and returns the same form fields.

### Request

```
POST /v2/tickets/worker-intake/extract-from-chat-image
Content-Type: multipart/form-data
Authorization: Bearer <token>
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `screenshots` | file(s) | Yes* | Up to 3 images. Singular alias: `screenshot` |

\* At least one image. Use multiple for long chats (scroll captures).

**Limits:** JPEG, PNG, WebP, HEIC — max 10MB each.

### Success response `200`

Same as text extract, with `"source": "image"` and `"screenshot_count": 1`.

### Error responses (additional)

| Status | Body | When |
|--------|------|------|
| `400` | `{ "error": "At least one screenshot image is required" }` | No file |
| `400` | `{ "error": "Screenshots must be JPEG, PNG, or WebP images" }` | Wrong type |
| `400` | `{ "error": "Each screenshot must be at most 10MB" }` | Too large |

### React Native example

```typescript
async function extractFromScreenshot(token: string, imageUris: string[]) {
  const form = new FormData()
  for (const uri of imageUris) {
    form.append('screenshots', {
      uri,
      name: 'chat-screenshot.jpg',
      type: 'image/jpeg',
    } as any)
  }

  const res = await fetch(`${API_BASE}/tickets/worker-intake/extract-from-chat-image`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? 'Extraction failed')
  return data
}
```

**UI tips:** camera + gallery picker; up to 3 images; loading ~5–15s; if fields missing, ask for clearer screenshot or manual fill.

---

## Step 2 — Review form (client-side)

Bind `fields` to your form inputs. Recommended UX:

| Form field | API field | Required on submit |
|------------|-----------|-------------------|
| Customer name | `fields.citizen_name` | Yes |
| Phone number | `fields.citizen_phone` | Yes |
| Address / location | `fields.address` | Yes |
| Problem description | `fields.description` | Yes |
| Latitude (optional) | `fields.latitude` | No |
| Longitude (optional) | `fields.longitude` | No |
| Photos (optional) | — | No (multipart only on ground-worker route) |

**UI suggestions:**

- Show empty form first; after **Generate**, populate from `fields`.
- Highlight fields in `missing_fields` (red border / helper text).
- For `confidence[field] < 0.5`, show a warning icon — user should verify.
- Show `extraction_notes` in an info banner when present.
- All fields remain **editable** after extraction.
- Disable **Submit** until name, phone, address, and description are non-empty.

---

## Step 3 — Submit ticket

Use the **existing** worker intake endpoint (unchanged).

### Request

```
POST /v2/tickets/worker-intake
Content-Type: application/json
Authorization: Bearer <token>
```

```json
{
  "citizen_name": "Ramesh Kumar",
  "citizen_phone": "+919876543210",
  "address": "Main road near Sircilla center",
  "description": "Grass/weeds overgrown on the main road near Sircilla center.",
  "latitude": null,
  "longitude": null,
  "territory_id": "optional-uuid"
}
```

Field aliases also accepted: `name`, `phone` / `number`, `location_text`, `issue_text` / `original_issue_text`.

### Success response `201`

```json
{
  "ok": true,
  "ticket_id": "uuid",
  "ticket_number": "VOC-2026-00042",
  "stage": "to_do",
  "sub_status": "new_awaiting_triage",
  "needs_triage": true,
  "citizen_id": "uuid",
  "citizen_verified": false,
  "citizen_is_new": true,
  "attachment_count": 0
}
```

### Submit validation errors `400`

| Error | Fix |
|-------|-----|
| `name is required` | Fill citizen name |
| `number is required` | Fill phone |
| `address is required` | Fill address |
| `description is required` | Fill description |
| `latitude and longitude must be provided together` | Send both or neither |
| `Valid citizen phone number is required` | Use valid 10-digit Indian number |

---

## Ground workers (multipart with photos)

Ground workers can submit with photos via:

```
POST /v2/worker/tickets
Content-Type: multipart/form-data
```

Same text fields as form fields + `files[]` (up to 5 files, 20MB each). Chat extraction still uses the JSON extract endpoint; only submit differs.

---

## Suggested screen flow

### Screen A — Chat input (choose one)

**Option 1 — Paste text**
- Large multiline `TextInput` for pasted chat.

**Option 2 — Screenshot**
- Image picker (camera or gallery).
- Thumbnail preview; allow up to 3 images for long chats.

- **Generate** button (loading spinner while extracting).
- Optional: character count for text mode (max 16,000).

### Screen B — Review form

- Navigate here after successful extract (or stay on same screen with form section below).
- Pre-fill from `fields`; let user edit everything.
- Optional photo picker (ground workers).
- **Submit** button → calls `POST /v2/tickets/worker-intake`.
- On success → navigate to ticket detail or show `ticket_number` confirmation.

---

## Example React Native code

```typescript
const API_BASE = 'https://your-api.example.com/v2'

async function extractFromChat(token: string, chatText: string) {
  const res = await fetch(`${API_BASE}/tickets/worker-intake/extract-from-chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ chat_text: chatText }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? 'Extraction failed')
  return data
}

async function submitWorkerIntake(token: string, form: {
  citizen_name: string
  citizen_phone: string
  address: string
  description: string
  latitude?: number | null
  longitude?: number | null
}) {
  const res = await fetch(`${API_BASE}/tickets/worker-intake`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(form),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? 'Submit failed')
  return data
}

// Usage in component
const onGenerate = async () => {
  setLoading(true)
  try {
    const result = await extractFromChat(accessToken, pastedChat)
    setForm({
      citizen_name: result.fields.citizen_name ?? '',
      citizen_phone: result.fields.citizen_phone ?? '',
      address: result.fields.address ?? '',
      description: result.fields.description ?? '',
      latitude: result.fields.latitude,
      longitude: result.fields.longitude,
    })
    setMissingFields(result.missing_fields)
    setExtractionNotes(result.extraction_notes)
    setConfidence(result.confidence)
    setStep('review')
  } catch (e) {
    Alert.alert('Could not extract', e.message)
  } finally {
    setLoading(false)
  }
}

const onSubmit = async () => {
  setLoading(true)
  try {
    const ticket = await submitWorkerIntake(accessToken, form)
    navigation.navigate('TicketDetail', { ticketId: ticket.ticket_id })
  } catch (e) {
    Alert.alert('Could not create ticket', e.message)
  } finally {
    setLoading(false)
  }
}
```

---

## v1 compatibility

The same extract endpoint exists on v1:

```
POST /v1/tickets/worker-intake/extract-from-chat
```

Prefer **v2** for new app work.

---

## Notes

- Extraction uses AI (OpenRouter). Typical latency: 2–8 seconds. Show a loading state.
- Extraction does **not** create a ticket or citizen record — only submit does.
- Phone numbers are normalized server-side to E.164 (`+91XXXXXXXXXX` for 10-digit Indian numbers).
- After submit, the ticket goes to central support triage (`needs_triage: true`), same as manual intake.
- Chat can be in English, Hindi, Telugu, or mixed; extraction handles multilingual paste.

---

## Checklist for RN developer

- [ ] Chat intake screen with **Paste text** OR **Upload screenshot** tabs
- [ ] Text: `POST /v2/tickets/worker-intake/extract-from-chat`
- [ ] Screenshot: `POST /v2/tickets/worker-intake/extract-from-chat-image` (multipart)
- [ ] Review form with editable fields + missing/low-confidence highlights
- [ ] Submit via `POST /v2/tickets/worker-intake`
- [ ] Handle 400/403/503 errors with user-friendly messages
- [ ] Loading states for extract (~3–8s) and submit
- [ ] JWT attached on all requests
- [ ] (Optional) Ground worker photos via `POST /v2/worker/tickets`
