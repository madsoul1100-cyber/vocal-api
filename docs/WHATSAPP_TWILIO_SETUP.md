# WhatsApp intake via Twilio

Citizen grievance intake on WhatsApp uses the same flow as Telegram (issue → media → location → confirm → ticket).

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
```

`TWILIO_WHATSAPP_FROM` must match the sender Twilio uses (include `whatsapp:` prefix).

## Twilio Console steps

1. Open your WhatsApp sender (or Sandbox settings).  
2. **When a message comes in** → `https://<api>/webhooks/whatsapp`  
3. Method: **POST**  
4. Save.

### Sandbox testing

1. On your phone, send the sandbox **join code** to the sandbox WhatsApp number (shown in Twilio Console).  
2. Message that same number from your phone — Twilio POSTs to your webhook.  
3. Reply with `1` or `report` to start filing an issue.

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
