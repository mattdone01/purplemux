# ADR-0002: One alert policy for every channel — orchestrator-only predicate, four kinds, per-device visibility, `notification:alert` frame

_Epic decision id: ADR-005 (see `_output/purplemux-mobile/architecture.md`)._

## Status
Accepted (2026-08-16, epic `purplemux-mobile`)

## Context
 research §1.5; FR-7/FR-8; research Q3/Q9. Today the predicate lives inside the Web Push method only, is *suppress workers when an orchestrator exists* (every tab alerts in a non-orchestrated workspace), and `isAnyDeviceVisible()` is global. Standup `needsHuman` and keeper exhaustion push nothing.

## Options

1. **Phone re-derives alerts from `status:update` + `GET /api/workspace`** — no server change; but the two-transition rule, the debounce and the visibility gate get re-implemented on the phone and drift from the web; English `title` strings would be the only `kind` signal for Web Push. Rejected.
2. **Server-side `NotificationDispatcher` with pluggable channels (`WebPushChannel`, `StatusSocketChannel`) and a browser-safe `alert-policy.ts` (`shouldAlert(tab, workspace, config)`, `alertFor(event)`) used by the server and importable by the web hooks; new config key `alertsOrchestratorOnly` (default `true`); kinds `needs-input | review | standup-needs-human | orchestrator-stalled`; visibility keyed by the `deviceId` that `POST /api/push/visibility` already receives.** 

## Decision
 Option 2 (story 05). The web client silently ignores unknown status frame types (`use-agent-status.ts:76-110`, no `default`, try/catch — verified), so the new frame is safe to broadcast unconditionally.

## Consequences
 SC-2 becomes a server-side truth table test; the phone's own re-check (`isOrchestrator && orchestratorTabId == tabId`) is defence in depth, not the rule; `alertsOrchestratorOnly=false` preserves today's behaviour bit-for-bit for anyone who wants worker alerts; Web Push payload gains `kind`, `isOrchestrator`, `alertId`, `agentSessionId` (additive; `claudeSessionId` misnomer kept for `sw.js`).


Source of truth for the epic: `_output/purplemux-mobile/architecture.md` (nomupay workspace). Related: `research.md` "API contract".
