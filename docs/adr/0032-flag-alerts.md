# ADR-0032: Flag alerts — one alert when a fleet or flow flag is raised

## Status
Proposed (2026-10-26, epic `purplemux-flow`, story 10). Amends ADR-0002 (alert kinds and the orchestrator-only policy).

## Context
Fleet flags (ADR-0023: STALL?, WAITING-LONG, UNANSWERED) and flow flags (ADR-0026) exist only when a viewer polls Mission
Control. A stall nobody looks at stays silent. The dispatcher (`src/lib/notification-dispatcher.ts`) applies no policy;
its callers apply `shouldAlert` (orchestrator-only by default, `src/lib/status-manager.ts:1339,1454`), and so do the web
hooks (`src/hooks/use-toast-notification.ts:43`, `use-native-notification.ts:46`). `IAlert.tabId` is a required string,
and the phone reads it as the tab to open.

## Options considered
1. **Alert from each poll.** No tick; but no poll means no alert, which is the defect.
2. **Inbox notices to orchestrators.** Reaches agents only, types into a composer, and is not for the human.
3. **A server tick with raise-edge state, one new alert kind, and an explicit policy exemption.**

## Decision
Option 3.

1. **Kind.** `TAlertKind` gains `'flag'`. `IAlert` gains the optional `flag?: {source: 'fleet' | 'flow', rule: string,
   subject: string, text: string}`. `notification:alert` frames are otherwise unchanged; old clients drop the unknown
   kind (the phone) or ignore it (the web, verified in `use-agent-status.ts`).
2. **Tick.** One 60 s interval per process (`globalThis.__ptFlagAlertTick`, started beside the Mission Control runtime,
   stopped in `shutdownWs`). Each tick reads `readFleetView(now)` (the 5 s cache) and `deriveFlowFlags` over every
   workspace's flow record. A tick that runs longer than 5 s logs its duration; the next tick is skipped while one runs.
3. **Raise edge.** The key is `source:workspaceId:rule:subject`. State on `globalThis.__ptFlagAlertState`:
   `{raisedAt, lastAlertAt}` per key. A key present now and absent in the previous tick is a raise. A raise sends one
   alert unless the key alerted within fleet config `alerts.flag-repeat-minutes` (default 60, 1..10080). A flag that
   stays raised sends nothing more.
4. **Baseline.** The first tick after a process start records the raised keys and sends nothing, so a deploy does not
   replay every standing flag. The baseline is per source (the fleet view, each workspace's layout, each tab's state,
   the SM inbox, the registered waits, each workspace's flow record): a key first seen in a source with no good read
   since the start, or since the switch came back on, is recorded and not raised, whatever the tick count.
5. **Target.** A fleet flag names the flagged tab. A workspace-level fleet flag (an unattributed UNANSWERED) and every
   flow flag name the workspace's enabled orchestrator tab. With no orchestrator the alert is not sent; the tick logs
   `flag-alert-no-target` and the flag stays on the panel. The same holds for a disabled orchestrator and for an
   `orchestratorTabId` whose tab a readable layout no longer shows. When the tick cannot check the target (the fleet
   view or the workspace's layout is unreadable, or the orchestrator's row is in state `unknown`), the raise stays
   pending: it is retried on each tick while the flag stays raised, and the tick logs `flag-alert-target-unknown`.
   `isOrchestrator` is true only when the named tab is the orchestrator.
6. **What raises nothing.** An unreadable store or flow record raises no flag on a guess (ADR-0023 rule), and clears
   none: a flag its source cannot speak for this tick is unknown. A stale flow raises only its `stale` flag
   (ADR-0026 §5).
7. **Switch.** Fleet config `alerts.flags`: `off` stops every flag alert; any other value, or unset, is on. The
   `alerts.*` keys are written by the admin token only (`ADMIN_ONLY_KEYS`, ADR-0027 §1): they decide what reaches the
   owner's phone.
8. **Policy.** The tick calls `NotificationDispatcher.dispatch` directly. The orchestrator-only predicate
   (`alertsOrchestratorOnly`) does not apply to kind `flag`: a flag is a fleet-level fact the owner asked to see, and the
   alert names the orchestrator wherever the flag is workspace-level. The web client shows a `flag` alert as a toast
   with the flag text and a link to Mission Control, outside any orchestrator filter: `showNotificationAlert` in
   `src/hooks/use-agent-status.ts`, the one web consumer of `notification:alert` frames. The hooks
   `use-toast-notification.ts` and `use-native-notification.ts` never read alert frames and keep their filter for
   every other kind. Electron shows the same in-page toast for `flag` and no OS notification, by design. Every other
   kind keeps its policy.

## Consequences
- The owner and the phone learn of a stall or a bottleneck within about a minute of the flag, without watching.
- A server restart loses the raise-edge memory on purpose; the baseline rule prevents an alert storm.
- The tick adds one fleet-view read per minute (pane captures of tabs at their prompt); the 5 s cache shares it with any
  open panel.
- Some fleet stamps are in memory (ADR-0023), so a deploy can still raise a fleet flag once. The composer clock restarts
  at boot, so a STALL? for unsubmitted composer text can alert once after a deploy. A tab restored `inactive` after a
  restart has no observed stop time, so it may not raise "agent not running".
