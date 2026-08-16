# ADR-0004: Server changes are additive-only and feature-detected by the client; deploy = fork `main` via `deploy.sh`

_Epic decision id: ADR-008 (see `_output/purplemux-mobile/architecture.md`)._

## Status
Accepted (2026-08-16, epic `purplemux-mobile`)

## Context
 the fork merges upstream; the web client and `sw.js` must keep working; the phone may meet an un-upgraded server (or a future upstream-only one).

## Decision
 no existing wire field is renamed or removed; new routes/fields/frames only; the client feature-detects (`seq` absent → provisional negative seqs, no search index; `byProvider` absent → combined tiles + hint; `POST /api/tabs/{id}/send` 404 → fall back to `POST /api/tmux/send-input` bracketed paste; `notification:alert` absent → no alerts + banner "server needs update"); `GET /api/health.version` is shown in Settings. Deployment: server stories merge to fork `main` (02 before 03/04; 05, 06, 07 independent) and roll with `orchestration/deploy.sh` (tmux count invariant, `KillMode=process`).

## Consequences
 stories 09/10/12/14/15 each carry a "server without feature X" AC; no version negotiation protocol is built.


Source of truth for the epic: `_output/purplemux-mobile/architecture.md` (nomupay workspace). Related: `research.md` "API contract".
