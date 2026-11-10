# WhatsApp ↔ Bharosa guide chatbot (Telinfy + Exotel number)

Anyone who messages the business WhatsApp number talks to the **Bharosa guide** (`handleGuideTurn`),
the same chatbot as the website. (The older Twilio route `/webhooks/whatsapp` is unchanged and unrelated.)

## Roles

| Provider | What it does |
|---|---|
| **Exotel** | Owns the phone number only. Needed once, to receive Meta's verification code (SMS or voice call). No credits used afterwards. |
| **Telinfy** | WhatsApp Business API provider: holds the WABA, bills credits, delivers inbound messages to our webhook and sends our replies. |

## Flow

```
User ──WhatsApp──► Meta ──► Telinfy ──POST──► /webhooks/telinfy/whatsapp?token=…   (vocal-api, 200 OK immediately)
                                                    │  parse → dedupe → citizen by phone → guide session
                                                    ▼
                                             handleGuideTurn()
                                                    │
User ◄──WhatsApp── Meta ◄── Telinfy ◄──POST── sendWhatsAppText()  (free text, inside 24h window)
```

* One guide session per WhatsApp number; resumed if the citizen writes again within
  `WHATSAPP_SESSION_TTL_HOURS` (12). Sending `new` / `restart` / `menu` starts a fresh chat.
* The citizen is created/linked by phone number (channel `whatsapp`) so guide memory and case history work.
* If the guide drafts an email to a department, the draft is shown and the citizen replies **SEND** to send it.
* Images / voice notes / stickers: the bot asks the citizen to type (media download is not wired yet).
* Replies outside the 24h window need an approved **template** (`sendWhatsAppTemplate`) — not used by the chat flow.

## Environment (vocal-api `.env.local` on the server)

```bash
TELINFY_API_KEY=...                       # from Telinfy
TELINFY_WEBHOOK_TOKEN=$(openssl rand -hex 24)
# Optional overrides (defaults shown in .env.example):
# TELINFY_TEXT_URL=https://api.telinfy.net/gaca/whatsapp/message/direct
# TELINFY_TEXT_AUTH_HEADER=Api-Key
```

`ORG_ID` must already be set. Without `TELINFY_WEBHOOK_TOKEN` the webhook rejects all requests in production.

## Deploy

```bash
cd vocal-api
npm run db:migrate -- 024_whatsapp_guide.sql     # adds whatsapp_guide_sessions + whatsapp_inbound_dedupe
pm2 restart vocal-api
curl -sS https://prod.my-leader.in/webhooks/telinfy/whatsapp      # → {"ok":true,"service":"telinfy-whatsapp-webhook"}
```

Give Telinfy this inbound URL (they register it for the WABA):

```
https://prod.my-leader.in/webhooks/telinfy/whatsapp?token=<TELINFY_WEBHOOK_TOKEN>
```

## Test without WhatsApp

```bash
curl -X POST "https://prod.my-leader.in/webhooks/telinfy/whatsapp?token=$TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"entry":[{"changes":[{"value":{"contacts":[{"wa_id":"919999999999","profile":{"name":"Test"}}],
       "messages":[{"id":"t1","from":"919999999999","type":"text","text":{"body":"Hi"}}]}}]}]}'
# Watch: pm2 logs vocal-api   (lines tagged [whatsapp:guide])
```

## Watch-outs

* Delivery failures (e.g. Meta 131047 "re-engagement", 24h window) are logged as `[telinfy] delivery failed …`.
* The free-text endpoint in Telinfy's older docs is `api.telinfy.net/gaca/whatsapp/message/direct`;
  confirm with Telinfy it is enabled for your account (override with `TELINFY_TEXT_URL`).
