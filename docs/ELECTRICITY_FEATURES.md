# Bharosa for electricity

Two guided features inside the Bharosa guide (web Help chat + WhatsApp). Same conversation state; WhatsApp can copy the web flows.

## Feature 1 — Understand my electricity bill

1. User starts with “Understand my electricity bill” (or Telugu/Hindi equivalent) or uploads a bill photo.
2. Vision OCR (OpenRouter) or typed values extract units, total, period, charge lines.
3. Unclear fields are flagged — never guessed. User taps **Correct** or **Fix**.
4. Each recognised charge gets a plain-language explanation from the curated glossary; unknown lines say to check with the electricity office.
5. Usage chart + one sentence over bills the user sent.
6. Next-bill **range** only with ≥2 reliable months; otherwise “cannot estimate yet”.

## Feature 2 — Cost of a new electricity connection

1. User starts “New electricity connection” and shares location (browser GPS / WhatsApp pin / address).
2. Asks home / shop / farm and load (kW); can suggest load from appliances.
3. Confirm / fix answers.
4. **Pole + cost estimates** only when approved data flags are on:
   - `ELECTRICITY_POLE_DATA_ENABLED=1`
   - `ELECTRICITY_CONNECTION_COST_ENABLED=1`
5. Until then: limited form — process + MeeSeva / TGSPDCL / TGNPDCL / 1912; no invented poles or prices.
6. Outside Telangana → refuse. “Is this the final price?” → no; office decides after inspection.

## Rules

- Reply in the user’s language only (te / en / hi).
- Never invent numbers, rates, helplines, or links.
- Label every estimate.
- Bharosa submits nothing to any office.

## External dependencies (still needed for full Feature 2)

- Official tariff / connection charges (named + dated source).
- Utility-approved pole / network GIS.
- Telugu speaker review of all Telugu copy.
- Product decision: domestic only vs shop/farm (shop/farm currently get process guidance; demo cost bands are home-only).

## Tests

```bash
npx tsx scripts/electricity-unit-checks.ts
```

## Web UI

Help chat starters + **Bill photo** + **Share location** + Correct/Fix chips when the electricity flow is active.
