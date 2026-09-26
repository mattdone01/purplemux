# ADR-0018: watchdog — `reportsTo`, turn-end markers, and `WAITING`

_Epic story: 15 (story 26 adds the API-error amendment) — see `_output/purplemux-portfolio-coordination/stories/`._

## Status
Accepted (2026-09-26, epic `purplemux-portfolio-coordination`, story 15).

## Context
Every agent `stop` became `READY FOR REVIEW`, and every nudge went to the one `orchestratorTabId` of the workspace.

- **L9.** Two orchestrators in one workspace shared one nudge target: ~45 alerts reached the wrong one, and each hand-forward cost a paid turn.
- **L14.** A worker that ended its turn only to wait on its own gate was announced ready for review. No server code read `DONE:` / `BLOCKED:`.
- **L25, measured 2026-09-26.** The 09-02 fix (`1d43b47b`) already held a stop as busy while the Claude transcript showed open background work. It never fired: replaying the 108 READY nudges of one hour (9 worker tabs) through it read 0 open tasks every time. Causes: it read only the last 8 KB of the transcript, and every start lay further back; completions delivered as `queue-operation` and `queued_command` entries, a foreground shell moved to the background on its timeout, Monitor events and `SendMessage` resumes were unknown shapes; its mtime cache hit dropped the count. The same tabs were then flagged stuck, because only the main transcript's activity counted (L19).

## Options (turn-end classification)
1. **An explicit report command** at turn end. Precise, but agents forget, and a forgotten report is silence.
2. **The marker from the transcript tail** the StatusManager already tracks. Workers already end with a marker (worker contract rule 10).
3. **A pane scrape.** Fragile across TUIs and widths.

## Decision
Option 2, applied at the one point every provider's stop reaches (`updateTabFromHook('stop')`):

1. **Marker.** Each provider's `readRuntimeSnapshot` returns `lastAssistantTail`: the final ≤ 600 characters of the current turn's last assistant message (the head snippet cuts the marker off). If its last non-empty line starts with `DONE:`, `BLOCKED:`, `NEEDS-DECISION:` or `READY-TO-MERGE:` (markdown emphasis stripped), the nudge is kind `turn-marker`:
   `[orchestrator-watchdog] worker <tab> (<name>) ended: <line, ≤ 300 chars> — read with: purplemux tab result -w <ws> <tab>`.
   Up to five `READY-TO-MERGE:` lines directly above the last line ride along. A marker wins over open work: the worker said what it is.
2. **WAITING.** No marker, and open background work — the provider's own tasks, or a live registered `tab bg` job — means no nudge. The tab stays `busy`; `entry.turnEnd` records `waiting` with the counts. The harness wakes the worker when the work returns, and that turn's stop is classified again.
3. **Otherwise** today's `READY FOR REVIEW`, unchanged. No transcript (no parser, no path, a read error) falls back to it, logged once per tab.

**A WAITING worker can be sent to** (architect ruling A′). WAITING keeps `cliState: 'busy'`, which the `composer-ready` gate of `tab send` (ADR-0008) refuses. `StatusManager.isWaitingAtPrompt(tab)` is true only when the tab is `busy`, `turnEnd.kind === 'waiting'` belongs to the current stop (`turnEnd.seq === lastEvent.seq`, `lastEvent.name === 'stop'`), and no agent launch happened since that stop (`lastResumeOrStartedAt < lastEvent.at`: a relaunched TUI is booting, the race ADR-0008 guards). The send route passes it as `waitingAtPrompt`; the gate accepts it; `COMPOSER_READY_STATES` is unchanged, and the response still reports `busy`. The web and phone use the `live-session` gate and were never affected. The inbox (ADR-0012) uses the same predicate; Mission Control does not until story 12.

The Stop hook can fire before the final entry reaches the file, so a read that is not at a turn end, or has no tail, is repeated once after 500 ms. A classification applies only if the stop it read is still the tab's latest event (by `seq`): a quicker, newer stop owns the tab.

**Open work comes from the whole transcript** (`src/lib/providers/claude/background-ledger.ts`): read once, then only appended bytes; starts from structured `toolUseResult` fields — `backgroundTaskId` (shell), `isAsync` + `agentId` (agent), `taskId` + `timeoutMs` (Monitor), `resumedAgentId` (agent resumed by `SendMessage`) — never from free text, which a `cat` of a transcript would forge. Ends: a `<task-notification>` with a `<status>`, a Monitor's expiry event or its deadline + 2 min, a `TaskStop` result. A status-less notification is a Monitor event: activity, not an end (a status tag quoted inside the event text does not count). Tasks started before the current Claude process (its session pid file's `startedAt`) are ignored: `claude --resume` appends to the same transcript, and a task open when the earlier process died never reports back. Fixtures: `tests/fixtures/claude-background/` (Claude Code 2.1.283). Replay of the 108 nudges: 95 held; the other 13 ended on a marker, an API error (story 26) or work outside the session.

**Stall (busy-stuck) rule for a waiting tab** (architect consult, 2026-09-26, ruling C): activity is the newest of the transcript, each open task's output file (an agent's links to its subagent transcript), every subagent transcript and Monitor events.

| Open work | STALLED when |
|---|---|
| at least one agent | no activity for **15 min** (longest silence of an open subagent on 2026-09-26: 10.0 min over 46 intervals — the foreground Bash limit) |
| shells or live registered `tab bg` jobs only | no activity for **90 min** (backstop for an orphan or a hung waiter; a gate waiter writes nothing for 20–40 min, and the liveness manager reports a job's exit) |
| Monitors only | never on their own; a Monitor ends at its timeout |
| nothing open | today's 10 min on the main transcript |

A stall is reported once per wait: every classified stop re-arms the stuck latch, because a chain of WAITING turns never leaves `busy`.

**A compaction is not a turn end (L30, story 32).** After an auto-compaction Claude Code fires SessionStart with `source: "compact"` while the turn goes on (measured on W4, 2026-09-26 08:29Z: a false "finished its turn" nudge). The status hook forwards `source`; a compaction's SessionStart keeps the tab's state and `lastEvent`, sends no nudge, clears `compactingSince` and records `turnEnd: compacting`. No fallback without `source`: `status-hook.sh` is rewritten on every server start, so the server that reads the field also installed the script that sends it (a hook-timing fallback would misread Grok, which sends no source, and the measured compaction outlasted any short window). Every other source, and every Grok or Codex session start, keeps today's behaviour (idle; `turn-ended` from busy). Unmeasured: whether a manual `/compact` fires UserPromptSubmit; if it does, the tab stays busy after it until its next stop, and the 10-minute stuck check reports it.

**Routing.** `ITab.reportsTo` — set by `tab create --reports-to`, `tab reports-to`, or `PATCH /api/cli/tabs/<id> { reportsTo }` — must name a live agent tab (a nudge is typed and submitted; a shell would run it) of the SAME workspace (research Q15; crossing workspaces is ADR-0014's grant), else `reports-to-invalid` (CLI exit 2). Worker-state and liveness nudges go to it while it is live, else to the workspace orchestrator (today's rule), else — liveness only — to the tab itself. It is cleared in memory and in the layout on the target's `tab-closed`. `tab bg add --notify self` sends the job's outcome nudge to the registering tab, so a worker wakes on its own gate; the default `orchestrator` keeps today's behaviour. `alert-policy.ts` (human pushes) is unchanged.

**Amendment (L15, story 26): a turn that ends on a provider error.** Each provider snapshot reports `lastTurnError: { class, code, text, turnId } | null`, read from structured fields only: Claude's synthetic assistant entry flagged `isApiErrorMessage` with its `error` code, and Codex's `task_complete.error.codex_error_info`. Message text is never matched, so a worker quoting "API Error:" or a pane's usage-WARNING footer ("You've used 92% of your session limit …", recorded 2026-09-26) is no error. Classes, measured on this host (`evidence/story-26/error-shapes-measured.md`): Claude `server_error` → `api-error`; Codex `server_overloaded` → `api-error`, `usage_limit_exceeded` → `usage-limit`; every other code (Claude `authentication_failed`, Codex `other`) → `other`, which keeps the rules above.
- The current turn is bounded: a Codex `user_message` newer than a `task_complete` means that completion belongs to an older turn, so a stop read before the new turn's own completion reports no error.
- `api-error`: the stop is silent (no nudge, no push) and ONE resume notice goes to the worker through the inbox (ADR-0012; template `[purplemux resume r-xxxx] the last turn ended on an API error — continue from where it was cut off`, dedupe `resume-<tab>-<turn id>`). A second `api-error` stop in the same episode, a resume the inbox holds (`onInboxHeld`), or a resume that cannot be queued → one `api-error` nudge to the target with the error text. A clean stop ends the episode. Whenever an episode closes, changes class or escalates, its resume is withdrawn if it is still queued, and the inbox re-checks the item inside the dispatch lock just before pasting, so a withdrawn "continue" is not typed. A resume held after a server restart (no episode in memory) escalates once too.
- `usage-limit`: one `usage-limit` nudge per episode, and nothing automated is typed into the tab while the episode lasts — no inbox notice (refused `usage-limit-halt`), Mission Control delivery (retryable `usage-limit-halt`), watchdog nudge, heartbeat (a halted orchestrator is also not counted as idle), kickoff or `bg --notify self` completion (typing cancels the provider's auto-continue). A withheld automated prompt is dropped, not replayed. Not gated: a person typing through the web or phone, and `tab send` / `tab steer` — the orchestrator's deliberate way to restart a worker after the reset. The episode ends at the next classified clean stop, at a new session start, or when the agent exits.
- Both stops are silent toward the human. When an escalation has no one to nudge — the tab is the orchestrator, it has no orchestrator and no `reportsTo`, or its target is itself halted (a shared-account halt), whose nudge would be withheld — the human is alerted directly, whatever the alert policy.
- Named gaps: no Claude usage-limit halt and no Grok error of any kind has been recorded on this host, so neither is classified; both keep today's READY nudge and nothing is typed. A stop restored after a server restart (`resolveUnknown`) is not resumed, and a halt is held in memory only, so a server restart lifts its gate until the tab's next classified stop.
- Rejected: resuming through the watchdog's direct dispatcher (no composer gate), and unbounded resumes (a persistent provider fault becomes a loop).

## Consequences
A worker waiting on its own gate costs the orchestrator nothing; an ended worker's line arrives without a capture turn. The ledger follows Claude Code's transcript shapes: an unknown future shape fails toward today's READY nudge (a missed start) or toward a held tab that the 15 / 90 min rule still reports (a missed end). A task orphaned any other way (a killed shell that never notified) holds the tab until the 90 min backstop reports it once. Subagent-owned tasks count through their parent agent, which stays open while they run. Codex and Grok report no background tasks yet, so their no-marker stops keep today's nudge unless a `tab bg` job is live.
