# ADR-0025: `reportOn` — which end lines a tab forwards

## Status
Accepted (2026-10-23).

## Context
ADR-0018 made every turn that ends on `DONE:`, `BLOCKED:`, `NEEDS-DECISION:`, `READY-TO-MERGE:` or `CHECKPOINTED:` a `turn-marker` nudge to the tab's target: its live `reportsTo`, else the workspace orchestrator. The marker set is fixed per server, not per tab.

Measured on the Treasury v2 workspace (`ws-ldhziO`, 2026-10-22 20:56Z to 2026-10-23 02:56Z, 48 tabs):

- The orchestrator tab reports to the scrum-master tab. In 6 hours the scrum master received 165 watchdog nudges, every one the orchestrator's `CHECKPOINTED:` line, and answered 133 of its 274 turns with "Nothing here needs me". Each such turn re-read about 500k cached tokens. None of the 160 marker lines repeated the previous one byte for byte, so the ADR-0018 duplicate filter (same episode within 60 s) and a text filter cannot help.
- The orchestrator itself received 156 watchdog nudges, 49 of them the scope pseudo-lane's `CHECKPOINTED:` after each of its landings; 59 of its replies were no-ops.

`CHECKPOINTED:` is the right end line for those workers (ADR-0018, L71): it keeps the idle nudge away and records the handoff. The waste is that one recipient is woken for a line it will never act on.

## Options
1. **A text or rate filter in the server.** Rejected by ADR-0018 review r1 finding 3: the text is not the key, and a rate limit drops a `BLOCKED:` behind a burst of checkpoints.
2. **Workers stop writing `CHECKPOINTED:`.** Then their stops have no end line and the idle nudge fires 15 minutes later (L49), to the same recipient. Worse, not better.
3. **A per-tab list of the markers whose nudges go out.** The recipient's needs differ per tab: a scrum master wants `BLOCKED:` and `NEEDS-DECISION:`, an orchestrator wants a builder's `DONE:`. The worker still ends on the marker it means; only the forwarding changes.

## Decision
Option 3. `ITab.reportOn?: TTurnMarkerName[]` names the markers whose `turn-marker` nudges leave the tab. Absent (or `all`) forwards every marker, today's behaviour.

- **Set** at `tab create --report-on DONE,BLOCKED` or later with `tab reports-to -w WS TAB [TARGET | --clear] --on DONE,BLOCKED`; `--on all` clears it. `PATCH /api/cli/tabs/<id>` takes `reportsTo` and/or `reportOn`, nothing else in the same body. Names are read case-insensitively, with or without the colon; an unknown name or an empty set is `report-on-invalid` (CLI exit 2): a tab that forwards nothing has silenced itself, and `tab close` is the way to do that.
- **Applied** where the stop is classified (`applyStopTurnEnd`): a `turn-marker` stop whose LAST line's marker is outside the list is recorded exactly as before (`turnEnd.kind === 'turn-marker'`, state `ready-for-review`, no idle nudge follows, `tab status` shows the line) and sends no nudge to anyone: not to `reportsTo`, not to the orchestrator. The server logs each withheld nudge and counts them (`getReportOnFilteredCount`). `READY-TO-MERGE:` lines above a `DONE:` ride with the `DONE:`, so the list judges the turn's own verdict.
- **Every other nudge kind is untouched**: needs-input, idle-no-end-line, long-wait, API error, usage limit, inactive, stuck, liveness and background-job nudges still reach the target. The list narrows one kind.
- The filter belongs to the SOURCE tab, so it holds whichever way the nudge would have routed, and a `reportsTo` that clears on the target's close leaves the list in place.

## Consequences
The scrum master of a 48-tab workspace can be set to `--on BLOCKED,NEEDS-DECISION,DONE` and the orchestrator's checkpoints stop costing it a turn; its 30-minute heartbeat and the explicit messages it receives are unchanged. A builder lane set to `--on DONE,BLOCKED` reports its landings through its own `DONE:` only. Nothing the worker writes is lost: the line is in the transcript, in `tab status` and in `tab result`. What is lost is the push; a recipient that needs a checkpoint must ask for it or leave the marker in the list.
