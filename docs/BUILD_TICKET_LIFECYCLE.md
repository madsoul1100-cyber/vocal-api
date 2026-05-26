# Ticket lifecycle & soft close — build spec

Source: product matrix (stages/sub-statuses) + worker soft close with CS approval queue.

## A. Data model

| ID | Item | Status |
|----|------|--------|
| A1 | Sub-status `pending_closure_approval` (`on_hold`) — worker proposes closure; `stage` stays non-`closed` | Implemented |
| A2 | `needs_closure_review` boolean on `tickets` (indexed) for CS queue filters | Implemented |
| A3 | Catalog: types, labels, `SUB_STATUS_STAGE_MAP`, status-options | Implemented |

## B. System auto-set (SYS)

| ID | Item | Status |
|----|------|--------|
| B1 | Intake → `new_awaiting_triage` / `incomplete_information`; `needs_triage = true` | Implemented |
| B2 | No usable lat/lng → `needs_location_validation` sub-status | Implemented |
| B3 | `severity = critical` → `critical_immediate_attention` + `critical_flag` | Partial (on AI confirm / severity patch) |
| B4 | Critical: bypass serial offer; notify nearest worker + location leader | Deferred |
| B5 | Reject → `reassignment_pending` (`on_hold`) + re-offer | Implemented |
| B6 | Max attempts → `sla_breach_escalation_queue` | Exists |
| B7 | No auto-assign on intake until `ready_for_assignment` | Implemented |

## C. Permissions

| ID | Item | Status |
|----|------|--------|
| C1 | `accepted_by_worker` only via `POST /v2/tickets/accept` | Implemented |
| C2 | Workers: forward stage order only; privileged-only sub-statuses blocked | Implemented |
| C3 | Workers cannot set `closed/*` or privileged escalations/holds | Implemented |
| C4 | `escalated_to_authority`: worker SET; only privileged MOVE FROM | Implemented |
| C5 | `suspected_fake_spam_review`: worker SET; privileged MOVE FROM | Implemented |
| C6 | Privileged-only sub-statuses in `PRIVILEGED_ONLY_SUB_STATUSES` | Implemented |
| C7 | Soft close: worker → `pending_closure_approval`; CS disposes | Implemented |

## D. Side-effects on entry

| ID | Item | Status |
|----|------|--------|
| D1 | `assigned_awaiting_acceptance` → `expires_at` | Exists (assignmentService) |
| D2 | `accepted_by_worker` → SLAs + citizen reveal | Exists (accept) |
| D3 | `citizen_contacted` → `first_contacted_at` | Implemented |
| D4 | Real `closed/*` → `closed_at`; clear `needs_closure_review` | Implemented |
| D5 | `sla_breach_escalation_queue` → breach + triage flags | Exists |
| D6 | Soft close: no `closed_at`, `needs_closure_review = true` | Implemented |

## E. Prerequisites

| ID | Item | Status |
|----|------|--------|
| E1 | Accept only from `assigned_awaiting_acceptance` | Implemented |
| E2 | Hard close: `citizen_contacted` in history | Implemented |
| E3 | Hard close: `note_type = closure` | Implemented |
| E4 | Soft close: same + note in `POST /v2/tickets/request-closure` | Implemented |
| E5 | Workers never hard-close | Implemented |

## F. Worker UX (API)

| ID | Item | Status |
|----|------|--------|
| F1 | `POST /v2/tickets/request-closure` `{ ticket_id, note }` | Implemented |
| F2 | Closed tab includes `pending_closure_approval` + `closure_pending: true` | Implemented |
| F3 | Active tab excludes `pending_closure_approval` | Implemented |
| F4 | Status-options: soft close via request-closure; no `closed/*` for workers | Implemented |

## G. Central support queue

| ID | Item | Status |
|----|------|--------|
| G1 | `GET /v2/tickets?needs_closure_review=true` | Implemented |
| G2 | `GET /v2/tickets?sub_status=pending_closure_approval` | Implemented |
| G3 | Dashboard `action_required.pending_closure_review` → `/tickets?needs_closure_review=true` | Implemented |
| G4 | Approve: CS sets any `closed/*` via `/status` | Exists |
| G5 | Reopen: CS moves to in-progress/on-hold sub-status | Exists |
| G6 | Reassign: `POST /v2/tickets/assign` | Exists |

## H. API (v2)

| Endpoint | Purpose |
|----------|---------|
| `POST /v2/tickets/status` | Sub-status transitions (rules in `ticketStatusRules.ts`) |
| `POST /v2/tickets/accept` | Worker accept only |
| `POST /v2/tickets/reject` | Worker reject → reassignment |
| `POST /v2/tickets/request-closure` | Worker soft close + closure note |
| `GET /v2/tickets/status-options` | Role-scoped picker |

## Deferred (spec, not in this pass)

- **B4** Critical parallel notify (nearest worker + location leader)
- **B3** Full SYS critical at Telegram intake before AI (needs severity on create)
- Per-sub-status “forward only” within `in_progress` (beyond stage-order rule)

## Sub-status reference

See product matrix: To Do → In Progress → On Hold → Closed, plus `pending_closure_approval` for worker-proposed closure awaiting CS.
