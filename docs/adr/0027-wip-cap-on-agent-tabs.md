# ADR-0027: WIP cap on agent tab creation, and `tab count`

## Status
Proposed (2026-10-26, epic `purplemux-flow`, story 03). Amends ADR-0016 (codes `wip-cap`, `config-store-unreadable`).

## Context
`POST /api/cli/tabs` has no ceiling. One orchestrator opened 56 tabs in one workspace; on 2026-10-16 another ran 18
workers (ADR-0023). Treasury-v2 added its own cap in a repository hook that counts tmux sessions, and a reviewer caught it
counting on the wrong socket. The harness knows its tabs, so it owns the ceiling. The owner's rulings (rulings.md Q3): the
cap applies to agent tabs only; a human create is never refused but is warned; only the orchestrator may pass the cap,
with a reason, audited.

## Options considered
1. **Count tmux sessions on `-L purple`.** Cheap; counts terminals and dead sessions, misses remote tabs, and races.
2. **Count in the route before `addTabToPane`.** Simple; two concurrent creates both read `cap − 1` and both pass.
3. **Count inside `addTabToPane`'s layout lock through an admission callback.** The count and the add are one critical
   section; no new lock.

## Decision
Option 3.

1. **Cap value.** Fleet config `tabs.cap-per-workspace` (ADR-0019): an integer 1..200. Unset → 8 with `capSource:
   'default'`; any other invalid value → 8 with `capSource: 'default-invalid'`, the value and the reason logged; a valid
   value → `capSource: 'fleet-config'`. The key is written by the admin token only (added to `ADMIN_ONLY_KEYS` in
   `src/lib/fleet-config-http.ts`, the `remote.*` precedent): under the ADR-0019 writer rule any workspace's orchestrator
   could otherwise raise the cap for the whole fleet. One fleet value (fleet-config keys cannot hold a workspace id with capitals). A
   fleet-config store that cannot be read refuses the agent create with 503 `config-store-unreadable` (exit 3): the cap
   never reads as "no cap".
2. **Count.** The tabs of every pane of the workspace layout whose `panelType` is in `AGENT_PANEL_TYPES`
   (`src/lib/agent-panel-types.ts`: claude-code, codex-cli, grok-cli), local and remote. Terminal, web-browser, diff and
   agent-sessions tabs do not count.
3. **Where.** `addTabToPane` gains `opts.admit?: (layout) => { ok: true } | { ok: false; refusal }`. It runs inside the
   layout lock before `createSession`. A refusal throws `WipCapError` with the count and the cap, and no session or tab
   is made. Only `POST /api/cli/tabs` passes `admit`, and only for an agent `panelType`.
4. **Refusal.** 409 `{code: 'wip-cap', error, workspaceId, count, cap, capSource}`; CLI exit 3, printed as `error:
   wip-cap (…) — <ws> holds <count> of <cap> agent tabs`.
5. **Over the cap.** The body field `overCap: {reason}` (1..500 characters, else 400 `invalid-request`) is accepted
   only from a verified tab that is its workspace's enabled orchestrator (`resolveCaller` + the fleet-config writer
   predicate `isWorkspaceOrchestrator`). Any other caller gets 403 `forbidden` naming the rule. The admin token cannot
   create a tab at all (ADR-0021), so it has no over-cap path. Each over-cap create appends `{event: 'tab-over-cap',
   workspaceId, tabId, count, cap, reason, by}` to `~/.purplemux/audit/coordination.jsonl`.
6. **Answers carry the count.** Every agent create answer from `POST /api/cli/tabs` and from the human route
   `POST /api/layout/pane/{p}/tabs` gains `wip: {count, cap, overCap}` (count after the add; `overCap = count > cap`).
   The human route never refuses; the web UI shows a sonner warning when `overCap` is true.
7. **`tab count`.** `GET /api/cli/workspaces/{ws}/tab-count` (read scope) answers `{workspaceId, count, cap, capSource,
   overCap}`. `purplemux tab count -w WS [--json]` prints `<count> <cap>`, exit 0. Repository hooks use it instead of
   tmux.
8. **Fleet view.** `IFleetView` gains `wip?: {[workspaceId]: {count, cap, overCap}}`; the fleet status panel shows
   `count/cap` per workspace and marks an over-cap workspace.

## Consequences
- The cap applies fleet-wide from the deploy that ships it. A workspace already above 8 agent tabs can create no agent
  tab until it closes some, or its orchestrator passes `--over-cap`, or the owner sets the key first (risk register).
- `config-store-unreadable`, returned by the create route today and unmapped, joins `CODE_EXIT` (exit 3).
- Treasury-v2 may replace its `.v2/tab-cap` hook with `purplemux tab count`; that change belongs to treasury-v2.
- Non-goal: no per-workspace cap, no cap on human creates, no cap on non-agent tabs.
