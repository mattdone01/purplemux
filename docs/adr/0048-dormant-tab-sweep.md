# ADR-0048: The dormant-tab sweep and the keep mark

Status: accepted, 16 Nov 2026. The design was reviewed before code, and the review's changes are in this record.

## Context

Agent tabs that finished their work stay open. In one measured day, five builder tabs ran no turn for about 22 h and
held nothing: no lease, no job, no worktree change. Two Scrum Master tabs sat empty for 22 to 24 h. A person closed all
seven by hand. Each idle tab uses a WIP slot (ADR-0027), a tmux session and memory. It also adds a line to every
status read.

A close that is wrong costs more than a close that is late. A wrong close ends a worker's session in the middle of its
work, and the context is lost. A late close costs one more idle tab for one more pass.

## Decision

A server job runs every 10 min. Its first pass is one tick after boot. It judges each agent tab (claude-code,
codex-cli, grok-cli) of each workspace whose layout reads. Terminal and browser tabs are out of scope.

### 1. Dormant

A tab is dormant when both conditions are true:

- Its state is `idle`, `ready-for-review` or `inactive` (the agent process exited). `busy` (WAITING included),
  `needs-input`, `startup-prompt`, `unknown`, and a tab the status manager does not know are never dormant.
- Nothing shows activity for `tabs.dormant.hours` (default 6).

The last activity is the newest of these sources:

- the turn ledger (`tab_turns`, the newest start or end);
- the last hook event, `busySince` and the agent launch;
- `lastRestartAt`, the persisted last stop record and the keep mark's `at`;
- the tmux session's creation time;
- the transcript's last entry and background activity;
- the newest tab-event delivery.

Only durable sources decide after a restart. A clock in memory that starts again at each boot is rejected: a daily
deploy would keep a 22 h tab open forever. A source that throws is a hold (`ledger-unreadable`,
`transcript-unreadable`, `tab-events-unreadable`). If no source has a time, the hold is `activity-unknown`.

### 2. Holds

A dormant tab that holds any of these is reported and never closed. A read that fails is a hold with the name
`<source>-unreadable`.

| Hold | Read |
|---|---|
| `orchestrator` | the workspace's `orchestratorTabId` (enabled or not) |
| `keep …` | an unexpired keep mark (§4) |
| `orchestration-pending` | `orchestrationActivity.launch` or `.turn` |
| `restarting`, `usage-limit-halt` | the restart window; the usage-limit halt |
| `seat-rotation (<phase>)` | a seat in `rotate-requested`, `handoff-ready`, `rotating` or `rotation-alarm`, or a lifecycle step that runs |
| `needs-decision`, `blocked` | the current stop (same seq as the last event) ended on that marker |
| `turn-open` | the turn tracker has an open turn for the tab |
| `tab-events-held (n)` | digest events held for the tab (urgent rows are held only while `rotating`, a seat hold) |
| `background-tasks (n)` | the Claude transcript's open background tasks. On claude-code, an unread ledger is `background-unreadable` |
| `lease …` | a lease whose holder is the tab |
| `bg-jobs (n)` | a live registered `tab bg` job. The sweep reads the workspace's `liveness.json` strictly first: absent is no jobs, unreadable or malformed is `jobs-unreadable` (the store's own readers turn both into no jobs). A job on disk that the liveness manager does not know (a hydrate that failed) holds the tab |
| `watches (n)`, `inbox (n)`, `notes (n)` | an armed watch; a queued or held inbox line; an open note routed to the tab |
| `mission-control …` | an open item whose opener row or NEEDS-DECISION line row names the tab; an open run bound to it |
| `grant …` | an active grant whose grantee is the tab. One unreadable grant file makes the read fail |
| `reports-target` | another tab of the layout has this tab as its `reportsTo` |
| `worktree-dirty (n)`, `worktree-unreadable`, `cwd-unknown` | `git status` in the pane's live cwd, on the tab's host (over ssh for a remote tab) |

A directory outside git and a deleted directory are not holds. The worktree check runs last, and only when nothing
else holds.

### 3. Close

In `close` mode a free dormant tab closes on the second pass in a row that finds it free with the same `eventSeq`. At
most 5 tabs close in one pass, fleet-wide, oldest activity first. The others are `close-deferred`.

`closeTab` takes `refuseIf`. It runs inside the first layout read, under the orchestration mapping write lock, before
`tab-closing` is emitted and before anything is signalled. The sweep refuses the close when any of these is true:

- a launch or turn is pending;
- a keep mark is unexpired;
- the tab became the workspace orchestrator, or the registry does not read (the registry is read under the same
  mapping write lease, which every orchestration commit holds);
- another tab of the layout now names it as its `reportsTo`;
- the tab is restarting or closing;
- the `eventSeq` changed;
- the state is no longer eligible.

Every path that types into a tab first records its pending turn under that lock. These paths are automated delivery,
`tab send` and the web terminal. So a turn that starts between the judgement and the close refuses the close.

The holds read from other stores are not read again under the lock. A pass judges every tab first and closes after, so
for up to one pass these changes are not seen: a lease taken or a watch armed for the tab by another tab, an inbox
line or note queued for it, a grant or Mission Control item that names it, and a hand edit in its worktree. A change
the tab makes itself is a turn and changes its `eventSeq`. A close that throws, or a report or off pass, starts the
two-pass confirm again.

Each close writes:

- one log line;
- one `dormant-close` audit line, with the threshold, the last activity and its source, the checks, the worktree
  answer, and the agent session and transcript (so the work can be resumed).

Each pass also sends one note per workspace, through the system sender, that lists every tab closed in the pass. One
note per close was rejected: the system sender shares the 50-open-note cap, and an unacked note stays open 14 days. A
note that fails is logged and audited (`dormant-close-note-failed`).

### 4. Report once

A held tab gets one `dormant-held` line (log and audit) per rolling 24 h, whatever its holds do in that time. In
`report` mode a free tab gets one `would-close` line per 24 h. These keys are in memory, so a restart repeats at most
one line per tab.

### 5. The keep mark

`purplemux tab keep -w WS TAB --reason R [--until ISO|12h|3d]` and `--clear` (PATCH `{ keep }`, alone) set
`ITab.keep = { until, reason, at }` in the layout. The reason is 1..200 characters. `until` is at most 30 days ahead.
Without `until` the mark has no expiry and is reported daily as `keep (no expiry)`. An expired mark holds nothing. The
mark dies with the tab.

A lease `keep:<tab>` is rejected: a lease is held by its caller and is released when that caller closes.

### 6. Config and rollout

- `tabs.dormant.mode` = `off` | `report` | `close`. The default is `report`.
- `tabs.dormant.mode.<workspaceId>` wins for one workspace.
- `tabs.dormant.hours` is 1..168, default 6.

An absent, invalid or unreadable mode is `report`. An invalid workspace value never falls through to a fleet `close`.
If the hours cannot be read, the mode stays at `report`. These keys are admin-only, like every `tabs.*` key.

Rollout:

1. Deploy, and run at least 24 h (one night) in report mode.
2. Check every `would-close` line against the board: each must be a tab the Scrum Master would close by hand. Check
   every `dormant-held` line for false holds.
3. Then set `tabs.dormant.mode close`, per workspace first if wanted.
4. If a `would-close` line is wrong, fix the hold and stay in report.

## Consequences

- Dormant tabs close with no person, and only after a day of report lines shows that the holds are right.
- A tab that waits for an answer (NEEDS-DECISION, BLOCKED, an open Mission Control item) stays open and is reported
  daily. To close such a tab, a person closes it, or the answer comes and the tab ends its turn.
- A remote tab whose host does not answer is never closed: its worktree read fails.
- After a restart, the first close comes at least 20 min after boot (two passes).

## Known limits

- The Codex transcript reader swallows its own read errors (`providers/codex/runtime-snapshot.ts`), so
  `transcript-unreadable` never fires for a Codex tab. One activity source is lost for Codex; the hook events and the
  turn ledger still count.
- The close does not re-read every hold under the lock (§3 names the window).
