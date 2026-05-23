# WhatsApp intake via Twilio

Citizen grievance intake on WhatsApp uses **AI conversational intake** by default (`WHATSAPP_INTAKE_MODE=ai`), powered by `intakeConversationManager` and OpenRouter. Citizens can chat naturally (“Hi, what can you do?”, describe problems in their own words); the bot empathizes, stays on civic topics, and files a ticket when enough detail is collected.

Set `WHATSAPP_INTAKE_MODE=script` to restore the older numbered-menu flow (reply `1` / `report`, etc.).

## What you need from Twilio

1. **Twilio account** — https://www.twilio.com/console  
2. **Account SID** and **Auth Token** (Console home).  
3. **WhatsApp-enabled number**  
   - **Sandbox (dev):** Messaging → Try it out → WhatsApp sandbox. Note sandbox number and join code.  
   - **Production:** Request / connect an approved WhatsApp Business sender.  
4. **Webhook URL** pointing at your API:  
   `https://<your-api-host>/webhooks/whatsapp` (HTTP POST).

## vocal-api environment variables

Add to `.env.local`:

```bash
ORG_ID=<your-org-uuid>

TWILIO_ACCOUNT_SID=ACxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxx
TWILIO_WHATSAPP_FROM=whatsapp:+14155238886

# Local dev only (tunnel URL changes break signature validation):
# TWILIO_SKIP_SIGNATURE_VALIDATION=true

# AI chat (default for WhatsApp)
OPENROUTER_API_KEY=sk-or-...
# OPENROUTER_MODEL=google/gemini-2.5-flash
# WHATSAPP_INTAKE_MODE=ai
```

`TWILIO_WHATSAPP_FROM` must match the sender Twilio uses (include `whatsapp:` prefix).

`OPENROUTER_API_KEY` is required for natural-language replies. Without it, users get a short fallback prompt asking them to describe their issue.

## Twilio Console steps

1. Open your WhatsApp sender (or Sandbox settings).  
2. **When a message comes in** → `https://<api>/webhooks/whatsapp`  
3. Method: **POST**  
4. Save.

### Sandbox testing

1. On your phone, send the sandbox **join code** to the sandbox WhatsApp number (shown in Twilio Console).  
2. Message that same number from your phone — Twilio POSTs to your webhook.  
3. Send a normal message (e.g. “Hi” or describe a road/pipe problem). The AI assistant will guide you.

## Local development

```bash
cd vocal-api && npm run dev   # port 3001
```

Expose with ngrok or cloudflared:

```bash
ngrok http 3001
```

Set Twilio webhook to `https://<subdomain>.ngrok.io/webhooks/whatsapp`.

While the public URL changes often, set:

```bash
TWILIO_SKIP_SIGNATURE_VALIDATION=true
```

**Do not use that flag in production.**

## vocal-web (optional landing link)

```bash
# .env.local — digits only, country code, no +
VITE_WHATSAPP_WAME_NUMBER=919876543210
```

Or set in `src/config/tenant.config.ts`:

```typescript
whatsapp: {
  enabled: true,
  waMeNumber: '919876543210',
  displayNumber: '+91 98765 43210',
  prefillMessage: 'Hi',
},
```

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/webhooks/whatsapp` | Health check |
| POST | `/webhooks/whatsapp` | Inbound messages from Twilio |

## Citizen menu (text)

Reply **1** — Report issue  
Reply **2** — Status  
Reply **3** — Help  

Or: `report`, `status`, `cancel`, `yes`, `done`, `skip`

## Status notifications

When a ticket filed via WhatsApp is updated, `citizenNotifier` sends updates back on WhatsApp (same templates as Telegram, plain text).

## Not included in v1

- Worker alerts on WhatsApp (still Telegram worker bot only).  
- WhatsApp template messages outside the 24-hour session window (may need Twilio Content API for prod nudges).
