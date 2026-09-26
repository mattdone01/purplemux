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

The Stop hook can fire before the final entry reaches the file, so a read that is not at a turn end, or has no tail, is repeated once after 500 ms. A classification applies only if the stop it read is still the tab's latest event (by `seq`): a quicker, newer stop owns the tab.

**Open work comes from the whole transcript** (`src/lib/providers/claude/background-ledger.ts`): read once, then only appended bytes; starts from structured `toolUseResult` fields — `backgroundTaskId` (shell), `isAsync` + `agentId` (agent), `taskId` + `timeoutMs` (Monitor), `resumedAgentId` (agent resumed by `SendMessage`) — never from free text, which a `cat` of a transcript would forge. Ends: a `<task-notification>` with a `<status>`, a Monitor's expiry event or its deadline + 2 min, a `TaskStop` result. A status-less notification is a Monitor event: activity, not an end (a status tag quoted inside the event text does not count). Tasks started before the current Claude process (its session pid file's `startedAt`) are ignored: `claude --resume` appends to the same transcript, and a task open when the earlier process died never reports back. Fixtures: `tests/fixtures/claude-background/` (Claude Code 2.1.283). Replay of the 108 nudges: 95 held; the other 13 ended on a marker, an API error (story 26) or work outside the session.

**Stall (busy-stuck) rule for a waiting tab** (architect consult, 2026-09-26, ruling C): activity is the newest of the transcript, each open task's output file (an agent's links to its subagent transcript), every subagent transcript and Monitor events.

| Open work | STALLED when |
|---|---|
| at least one agent | no activity for **15 min** (longest silence of an open subagent on 2026-09-26: 10.0 min over 46 intervals — the foreground Bash limit) |
| shells only | no activity for **90 min** (backstop for an orphan; a gate waiter writes nothing for 20–40 min) |
| Monitors only | never on their own; a Monitor ends at its timeout |
| a live registered `tab bg` job, no agent | never; the liveness manager reports the pid's exit |
| nothing open | today's 10 min on the main transcript |

**Routing.** `ITab.reportsTo` — set by `tab create --reports-to`, `tab reports-to`, or `PATCH /api/cli/tabs/<id> { reportsTo }` — must name a live agent tab (a nudge is typed and submitted; a shell would run it) of the SAME workspace (research Q15; crossing workspaces is ADR-0014's grant), else `reports-to-invalid` (CLI exit 2). Worker-state and liveness nudges go to it while it is live, else to the workspace orchestrator (today's rule), else — liveness only — to the tab itself. It is cleared in memory and in the layout on the target's `tab-closed`. `tab bg add --notify self` sends the job's outcome nudge to the registering tab, so a worker wakes on its own gate; the default `orchestrator` keeps today's behaviour. `alert-policy.ts` (human pushes) is unchanged.

**Planned amendment (L15, story 26 — not built by story 15).** The classifier will also read `lastTurnError`: `api-error` → one resume notice to the worker through the inbox, no orchestrator nudge; a second consecutive failure → one `api-error` nudge. `usage-limit` → never any input, one nudge. Story 26 records the decision when it lands.

## Consequences
A worker waiting on its own gate costs the orchestrator nothing; an ended worker's line arrives without a capture turn. The ledger follows Claude Code's transcript shapes: an unknown future shape fails toward today's READY nudge (a missed start) or toward a held tab that the 15 / 90 min rule still reports (a missed end). A task orphaned any other way (a killed shell that never notified) holds the tab until the 90 min backstop reports it once. Subagent-owned tasks count through their parent agent, which stays open while they run. Codex and Grok report no background tasks yet, so their no-marker stops keep today's nudge unless a `tab bg` job is live.
