# ADR-0028: `tab restart` — a fresh agent process under the same tab id

## Status
Proposed (2026-10-26, epic `purplemux-flow`, story 04). Amends ADR-0016 (codes `tab-busy`, `restart-unsupported`,
`restart-not-confirmed`).

## Context
A hook or `CLAUDE.md` change reaches an agent only through a fresh process. Today the only path is close and create,
which mints a new tab id. The tab id keys the tab token (ADR-0010), leases (ADR-0011), routed notes (ADR-0013), grants
(ADR-0014), watches (ADR-0015), probes, `reportsTo` (ADR-0018) and the Mission Control run binding, so a new id orphans
all of them. Three pieces exist: `killSession(name, {tabId})` reaps the ADR-0016 process set without a layout change
(`src/lib/tmux.ts:298`); `restartTabSession` recreates an absent session under the same id (`src/lib/layout-store.ts:539`);
`ensureTabToken` keeps a launch token and replaces a hook token with a fresh launch token (`src/lib/tab-token.ts:142`).
The resume command path lives in `src/lib/auto-resume.ts` (`sendResumeKeys`, Codex managed launch included), and the
fresh launch builders live inline in `POST /api/cli/tabs`. The existing human route
`POST /api/layout/pane/{p}/tabs/{t}` restarts only a dead session, and types a command the client sends.

## Options considered
1. **Close plus create with the persisted settings.** No new kill path; a new tab id, so everything keyed on it is lost.
2. **Extend the existing human route.** One route; but it types caller-supplied text, and agents cannot reach it.
3. **One restart service with a CLI route and a cookie route; the server builds every command.** Same id, nothing
   orphaned, one launcher shared with create and auto-resume.

## Decision
Option 3. `src/lib/tab-restart.ts` (new) exports `restartTab({workspaceId, tabId, clear, interrupt, by})`.

1. **Unsupported panels.** web-browser, diff, agent-sessions → 400 `restart-unsupported` (exit 2). A terminal tab
   restarts its shell with no command.
2. **Guards, taken once.** The service runs inside `withAgentDispatchLock(workspaceId, tab, …)`
   (`src/lib/agent-dispatch-policy.ts:118`), which takes the workspace mapping read guard (ADR-0021 lists restart among
   those paths) and the tab's dispatch lock, so no dispatch types into the session while it restarts. **Nothing inside it
   takes the mapping read guard again**: the lease (`src/lib/orchestration-mapping-lock.ts`) is not re-entrant, and a
   writer queued between two reads blocks the second read while the first waits for it — a deadlock. So
   `restartTabSession` is split into the guarded export (unchanged for its current callers) and a guard-free inner
   function that the service calls, and `launchAgentInTab` takes no mapping guard (its callers hold it). A test queues a
   mapping writer during a restart and proves both finish.
3. **Busy.** The tab is busy when its StatusManager `cliState` is `busy` or its `orchestrationActivity` holds a pending
   `launch` or `turn` (the `pending` test of `closeTab`). Busy without `interrupt` → 409 `tab-busy` (exit 3), nothing
   changes. Busy with `interrupt` → the restart proceeds and the audit line records the abandoned turn.
4. **Remote tab** (ADR-0022). The host is probed first (`hasSessionOrUnreachable`); an unreachable host → 503
   `remote-host-unreachable` (exit 6), and nothing is killed. A remote agent restarts fresh only: the resume path is local
   only (`auto-resume.ts`), so the answer says `resumed: false, resumeSkipped: 'remote'`.
5. **Lifecycle signal.** Before the reap, `emitTabRestart({workspaceId, tabId, sessionName, phase: 'restarting'})`
   (new, `src/lib/tab-lifecycle.ts`). The StatusManager retires the tab's watchdog checks as it does for `closing`, and
   retires the tab's registered background jobs with reason `tab-restart` (the reap kills them). Probes and watches stay.
   After the launch, `phase: 'restarted'` (or `'failed'`) restores the checks. **No `tab-closing` and no `tab-closed`
   event fires**, so leases, watches, probes, notes, grants, `reportsTo` and the run binding stay as they are.
6. **Kill.** `killSession(sessionName, {tabId})`. If a survivor remains or the session is still present, the service
   stops: 500 `restart-not-confirmed` (exit 1), and nothing is relaunched.
7. **Recreate.** `restartTabSession(wsId, paneId, tabId)` with no command. The tab token follows `ensureTabToken`: a
   launch token is kept; a hook token is replaced by a fresh launch token, so the tab reads `identity: launch` after it.
8. **Launch.** One launcher, `launchAgentInTab(tab, {resumeSessionId})` in `src/lib/agent-launch.ts` (new), extracted
   from `sendResumeKeys` and from the create route's builders; auto-resume and `POST /api/cli/tabs` call it too. It uses
   the persisted `agentLaunchConfig` (model, effort), `cwd`, `scope` and `host`. Resume when not `clear`, the provider
   reads a session id from the tab, and the tab is local; otherwise a fresh launch. Codex uses its managed launch
   (prepare, submit, wait). No caller text reaches the session.
9. **Record.** The tab gains `lastRestartAt` in the layout; `IFleetRow` gains `restartedAt?: number | null`. One audit
   line `{event: 'tab-restart', workspaceId, tabId, by, clear, interrupt, resumed, reaped: {killed, survivors},
   abandoned?}` goes to `~/.purplemux/audit/coordination.jsonl`.
10. **Routes.** `POST /api/cli/tabs/{tabId}/restart?workspaceId=WS` (`authorizeWorkspaceMutation`: own workspace only;
    the admin token and every other workspace get `forbidden`, ADR-0021) and `POST /api/tabs/{tabId}/restart?workspaceId=WS`
    (`requireMissionHumanMutation`: cookie and this server's Origin). Body `{clear?: boolean, interrupt?: boolean}`.
    200 `{ok: true, workspaceId, tabId, resumed, resumeSkipped?: 'clear'|'no-session'|'remote', identity:
    'launch'|'hook'|'none', reaped: {killed, survivors}, launchState?: 'active'|'held'}`; 404 `tab-not-found` (exit 4).
    The existing dead-session route is unchanged.
11. **CLI.** `purplemux tab restart -w WS TAB [--clear] [--interrupt] [--json]` prints `ok <TAB> restarted (resumed)` or
    `(fresh)`. The web tab menu gains "Restart" and "Restart fresh"; the phone gains the same (story 15).

## Consequences
- A tab keeps every binding across a restart; an orchestrator can roll a hook change through its workers by id.
- Create, auto-resume and restart build launch commands in one place; a launch flag change has one site.
- A restart kills the tab's background jobs (they are tab-owned, ADR-0016) without a "background job failed" nudge.
- The restart of a busy tab needs an explicit `--interrupt`; an unattended loop cannot kill a turn by accident.
