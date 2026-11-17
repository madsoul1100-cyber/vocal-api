# Bharosa for electricity

Aligned to manager package **17 Nov 2026** (draft for integration; forecast/true-up gated).

## Feature 1 — Understand my electricity bill

Scoped multi-turn flow (`power_bill_explain`) with:

- Photo / typed bill → confirm → explain (KB status-gated)
- First-message shape: total/due, energy, lumped small charges, attention lines
- Service-number keyed history (no cross-account merge)
- Corrections keep all other fields; user-facing names only
- No complaint filing inside this flow
- Next-bill forecast **off** unless `ELECTRICITY_BILL_FORECAST_ENABLED=1`
- True-up: show printed amount only (`disabled` until order text read)

Runtime KB: `src/modules/bharosa/electricity/kb.ts`  
Review YAML: `docs/bharosa-electricity-kb.yaml`  
Flow notes: `docs/bharosa-electricity-flow-prompt.md`

## Feature 2 — New connection cost

Limited form without approved pole/cost data (`ELECTRICITY_POLE_DATA_ENABLED` / `ELECTRICITY_CONNECTION_COST_ENABLED`).

## Tests

```bash
npx tsx scripts/electricity-unit-checks.ts
```

Fixtures: public TGSPDCL specimen text in `scripts/fixtures/tgspdcl-public-bills.ts`.

## Shared rules (bill flow)

- Answer in chosen language (loanwords OK in Telugu).
- Never invent numbers/links.
- Never show internal field keys (`total_inr` → “total”).
- Offer file/follow-up only outside this flow.
