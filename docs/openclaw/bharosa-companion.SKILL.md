# Bharosa companion skill (OpenClaw)

Use these HTTP tools against **vocal-api** only. Do not message citizens or send email yourself.

## Auth

```
Authorization: Bearer <BHAROSA_MCP_TOKEN from vocal-api .env.local>
X-Org-Id: <organization uuid>
```

Base URL (local): `http://127.0.0.1:<API_PORT>/v2/companion`

## Tools

### List open cases
`GET /cases?limit=10`

### Get one case
`GET /cases/{ticketNumber}`

### Open drafts (guide)
`GET /drafts?phone=98XXXXXXXX`  
(omit phone for recent open guide sessions)

### Propose citizen nudge (does not send)
`POST /nudge/propose`
```json
{ "language": "en", "name": "Anurag", "problemPreview": "sewer blockage" }
```

### Citizen Guide memory (read-only)
`GET /memory/{citizenId}`

Returns past problems, areas, and behavior signals for a logged-in citizen. Use this to brief staff — do not invent history.

## Rules

1. Staff / leader assistant only.  
2. Never invent ticket numbers.  
3. Nudge text is a **proposal** — a human or vocal-api sends via Twilio.  
4. Prefer short answers; quote ticket_number and stage from the API.  
5. Citizen memory is context only — if they opened a new issue, follow that.
