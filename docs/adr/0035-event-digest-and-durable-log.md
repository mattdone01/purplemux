# ADR-0035: Event digest and a durable tab event log

## Status
Accepted (2026-11-03, epic `harness-flow-loop`, story 09; architecture ADR-HFL-05 decisions 1-3). Amends ADR-0033 §1
(two columns and four partial indexes on `tab_events`) and §9 (`tab_events` kept 30 days), and ADR-HFL-05 decision 1
twice: the duplicate rule does not apply to urgent events (consult ruling 2026-11-03), and a copy is a duplicate only
while the earlier one is still undelivered (review round 2, F3).

## Context
The v2 orchestrator took 18,026 inputs in 14 days (audit), 68% of them trivial (1-2 API calls, at most 1 tool call).
Measured again for this story with the same method (`evidence/09/wake-measure.py`, transcripts `01829b72` and
`621a342e`, 2026-10-31T06:00Z to 11-03T06:00Z): 3,894 inputs, 1,298 a day, 71.1% trivial. By source: another seat's
`tab send` 1,723 (1,199 trivial; most carry the fleet header `FROM -> TO (cc COPIES): ...`, in which the `->`
recipient gets the original and only the cc tabs get copies), watchdog CHECKPOINTED 1,440 (1,266 trivial),
subagent completions 331, pastes 150, Mission Control 89, other watchdog nudges 69, SM heartbeats 54, DONE 18, BLOCKED
12, notes 8. Every watchdog nudge was typed at once, mid-turn too (`deliverAutomatedPrompt`), and the nudge history was
200 entries in memory (`MAX_NUDGE_HISTORY`, `status-manager.ts:1157`), lost on every restart.

## Options considered
1. **`--report-on` alone** (ADR-0025): drops CHECKPOINTED from the orchestrator's wakes but loses it; nothing records
   it and nothing reaches the seat later.
2. **Batch in the inbox** (ADR-0012): the inbox already types only into a ready, empty composer, but its lines carry
   no caller text by design, and a digest carries the worker's end lines.
3. **A class per event, a durable log, and a digest the router types only at the prompt.**

## Decision
Option 3.

1. **One class table** (`src/lib/wake-class.ts`, `WAKE_CLASS_TABLE`, `classifyWake(kind, detail)`). `urgent`: a
   `turn-marker` whose last line is DONE, BLOCKED, NEEDS-DECISION, READY-TO-MERGE or any line but CHECKPOINTED;
   `needs-input`, `off-scope`, `thrash`, `api-error`, `usage-limit`, `inactive`, `stalled`, `model-drift`; `bg-*` to
   the tab that registered the job; inbox `mission`, `resume`, `watch`, `deploy`; `red-main`, `rotate`; a block-severity
   `flag` or `alarm`; a `tab-send` that is not a copy. `digest`: CHECKPOINTED; `turn-ended`, `ready-for-review`,
   `idle-no-end-line`, `long-wait`, `stuck`, `probe-failed`; `bg-*` to another tab; the first `heartbeat` of an idle
   episode; `note`; a warn `flag` or `alarm`; a `tab-send` to a tab that is a copy (its name on the header's `cc`
   list and not among the `->` recipients; a header name matches the tab's name, a part of it, a prefix of a part of
   at least 3 letters, or its initials: `ORCH` is `v2-orchestrator`, `SM` is `v2-scrum-master`), or one that says "no
   reply needed". Such a send stays urgent when a line, or the text right after the header, starts with DONE:,
   BLOCKED:, NEEDS-DECISION: or READY-TO-MERGE:, or when it relays an owner's answer verbatim (ADR-HFL-05 names an
   owner answer urgent; the scrum master's approval route is this relay). Architect ruling 09-C1: the first cut held
   every send with a cc list, which held the original for its `->` addressee. `log`: later heartbeats of the same idle episode. A kind outside the table is urgent: a class
   never holds what it cannot name.
2. **Duplicates.** A digest or log event whose tab, kind and text match an event of the last 15 min that is still
   undelivered is logged, not delivered (a logged copy does not extend the window). A delivered copy never suppresses
   a later one: the watchdog's templates carry no episode token (`turn-ended`, `stuck`, `idle-no-end-line` read the
   same for every stop of one worker), so a matching text after delivery is a new event (review round 2, F3). Urgent
   events keep only the 60 s episode filter (`nudge-dedupe.ts`): the same `DONE:` after a fix round is a new decision,
   and urgent volume (about 10 a day) makes the rule worth nothing there.
3. **Digest delivery** (`src/lib/tab-event-router.ts`). One message, `DIGEST <n> since <time>`, a line per event
   (watchdog prefix and pane pointer dropped, 160 characters) while the whole stays within 2,048 bytes, then
   `Full text:` or `<k> more:` and `purplemux events show -w WS TAB --since <time>`. It is typed when the tab is at its
   prompt (`StatusManager.isAtPrompt`: idle, ready-for-review, or busy only because its stop waits on its own
   background work; not halted by a usage limit, not being closed), re-checked inside the dispatch lock just before the
   paste (`IAutomatedPromptRequest.whenReady`), and 15 min have passed since the tab's last digest or 20 events wait.
   No digest goes within 5 s of any delivery to the tab (an urgent paste, a notice, a send): the turn that paste
   started may not show in the tab's state yet (review round 2, F10). The window is read again inside the tab's
   dispatch lock, after any paste queued ahead of the digest. A 5 s tick and every new digest event check it.
   When a digest goes out, the nudges it carried are broadcast again under their ids, delivered, so a client that
   showed them as held updates them. A tab whose oldest held event is an hour old (it was never at its prompt: dead or
   always busy) is reported to the human once per backlog through the flag alert path (ADR-0032), with the
   `events show --since` command that shows it. A closed tab's held events become `log` rows when it closes, and a tab
   that closed while the server was down is retired the same way on the first stale tick, never reported.
4. **The durable log.** `tab_events` in `ledger.sqlite` (ADR-0033's table, the ledger's own handle) records every
   event first, then its delivery: `delivered_at`, and `digest_id` for the digest that carried it. It replaces the
   in-memory `orchestrationNudges`: `getOrchestrationNudges` reads the newest 200 rows that carry a source tab. Two
   nullable columns, `source_tab_id` and `source_tab_name` (the worker a nudge is about), and two partial indexes (the
   pending digest events; the delivered rows) are added in place: `user_version` stays 1, so a server rolled back to a
   build without them opens the file as before and names neither (the ADR-0023 rollback lesson). After a rollback the
   held non-urgent events stay in `tab_events` and the old release does not read them: read them with `purplemux
   events show` after rolling forward. Indexes, all
   partial: the held events per tab; the delivered rows per workspace; the digests per tab, by delivery (the
   last-digest read on every tick); the nudges per workspace, by seq (the history). An event the router holds is kept
   whole: it is the only copy until its digest; one another path typed (an urgent `tab send` brief) is kept to 16,384
   characters. Retention 30 days. Inbox notices keep their own delivery and receipts and are recorded when typed; an
   urgent `tab send` is recorded when typed; a digest-class `tab send` to a tab with no live session answers 409
   `session-not-running`, as any send does. **Delivery never depends on a ledger write:** a ledger that cannot be
   opened, or a write that fails (the duplicate check, the append), types every non-log event at once and logs one
   line naming the error; a delivery that cannot be recorded after its paste is logged and never typed again.
5. **Reads.** `GET /api/cli/workspaces/{ws}/events?tab=&since=&limit=` (`purplemux events show -w WS [TAB] --since 1h`;
   for one tab it prints every event whole, the text the digest's pointer names; for the workspace, one line each)
   and `GET .../events/wakes?since=&until=&by=window|day` (`purplemux events wakes`). `since` takes an age (`15m`,
   `1h`, `7d`), Unix ms or ISO-8601.
6. **Metrics for the finder.** `getLedgerStore().tabEvents.wakes(workspaceId, { since, until, byDay? })` returns
   `ITabWakeRow[]` = `{ tabId, day: 'YYYY-MM-DD' | null, wakes, digests, urgent, logged }` per tab (and per UTC day of
   the delivery with `byDay`). A wake is one delivery: an event delivered on its own (`urgent`) or a digest counted once
   however many events it carried; undelivered and `log` rows never wake; `logged` counts `log` rows recorded in the
   window. `tabEvents.hasAny(workspaceId)` tells "no record" from "a quiet seat". Wakes per hour per seat over 6 h is
   `wakes / 6` of `wakes(ws, { since: now - 6 h, until: now })`.

## Measured (review round 2)
150,000 rows over 30 days (5 workspaces, 30 tabs; a quarter sourced nudges of about 250 characters, the rest sends of
about 600), local disk (`evidence/09/f5-index-measure.json`): 710 bytes a row; at the baseline 1,298 inputs a day that is
about 0.9 MB a day and 28 MB at 30 days. Medians (p99), 200 runs: last digest of a tab 0.010 ms (0.026), the 200-nudge
history 0.385 ms (0.957), last delivery inside 5 s 0.010 ms (0.028), held tabs 0.012 ms (0.018), duplicate check
0.015 ms (1.243), wakes over 6 h 0.306 ms (1.779).

## Consequences
A seat is woken for what it must act on; the rest arrives at most four times an hour, at its prompt. A restarted or
rotated tab reads what it was sent. The class table is the one place a kind's urgency is decided; a wrong class is
fixed there, never in the digest. `--report-on` stays: a worker that reports only DONE and BLOCKED sends no
CHECKPOINTED at all.

## What proves it wrong
Run `evidence/09/wake-measure.py` over the 3 days after the deploy. Inputs stay at 400 a day or more, trivial wakes
above 20% (ADR-HFL-05: above 40% is the failure line), an urgent kind above 50% trivial, a seat acting on a tab in its
first turn after a digest that carried that tab's event, or a worker idle more than 2 min behind a held event. Then
the class table is wrong for that kind. Urgent same-text deliveries from different episodes above 5% of urgent
deliveries and rated trivial would make the duplicate rule worth extending to urgent events.
