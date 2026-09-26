# ADR-0016: CLI exit-code contract; tab-owned processes die with the tab

## Status
Proposed (2026-09-26). Epic `purplemux-portfolio-coordination`. Story 02 writes the exit-code half; story 16 appends the reaping half.

## Context
`bin/cli.js` exited 1 for every failure and printed only `body.error`. The send route answers a missing tab with 404 `Tab not found`, a dead tmux session with 409 `agent-not-ready` + `detail: session-not-running`, and a booting agent with 409 `agent-not-ready` + `detail: readiness-timeout`. On the command line the three looked identical. A relay loop retried `tab send` into a closed tab (pid 2744842) for more than a day.

The lease commands (story 03), the bash-guard lease rules (story 04) and the command bodies (story 05) also branch on the CLI result. They need a contract that is stable across releases.

A second defect sat in front of the CLI. The installed entry point, `bin/purplemux.js`, kept its own list of command names and answered `unknown command` for any other name. A command group added to `cli.js` alone did not exist for a caller of `~/.local/bin/purplemux`.

## Decision (exit codes)
1. A CLI route error body carries a machine `code` beside `error` for every failure a caller must branch on. Story 02 covers the tab-target failures on every route under `/api/cli/tabs/[tabId]` (`tab-not-found`, `session-not-running`, `target-changed`, `readiness-timeout`) and the authorization refusals (`forbidden`). Later routes return their own codes from the table. Other failures — 400 validation errors, `Workspace not found`, the dispatch-policy bodies `agent-model-mismatch` / `agent-model-unverified`, `Browser tab not attached yet` — carry no code yet and exit 1. The `error` text and the HTTP status do not change: the web UI and the phone read them (ADR-0004, additive wire changes only).
2. `bin/cli.js` maps `code` to an exit code through ONE table. A later route adds its code to that table; it never adds a table of its own.

| Exit | Meaning | Codes | Retry? |
|---|---|---|---|
| 0 | success; for `lease check`, the caller holds the lease | — | — |
| 1 | unexpected error | any unmapped code; 5xx; a 2xx without JSON; `gh-unavailable`; `outcome-unknown`; `close-not-confirmed`; a request that could not be sent (malformed port or header) | investigate |
| 2 | usage error | client-side argument errors, including an unknown command at the entry point; `lease-policy`, `watch-invalid`, `reports-to-invalid`, `note-too-large`, `config-invalid`, `note-target-missing` | fix the command |
| 3 | conflict / refused by state | `lease-held`, `lease-held-by-other`, `watch-cap`, `forbidden`, `inbox-not-held`, `grant-tab-unverified`, `config-version-conflict`, `caller-unresolved`, `grant-password-invalid`, `grant-locked` | after the state changes |
| 4 | target gone (permanent) | `tab-not-found`, `session-not-running`, `target-changed` | **never** |
| 5 | not ready yet | `readiness-timeout` | yes, bounded |
| 6 | server unreachable | `server-unreachable`: connection refused, no port or token configured, a read interrupted; `routes-absent`: the server answered 404 without a JSON body on a `/api/cli/` route — it predates the command (story 27) | yes, bounded; `routes-absent` not until the server is deployed |
| 7 | not found | `lease-not-found`, `note-not-found`, `watch-not-found`, `inbox-not-found`, `deploy-not-found`, `config-not-found` | — |

3. stderr names the code and its class, e.g. `error: tab-not-found (permanent — the tab is closed; do not retry) — Tab not found`. A `readiness-timeout` names the waited milliseconds.
4. A write that loses its connection after it connected exits 1 with `outcome-unknown`, not 6. The server may have acted on it, so a blind retry of `tab send` could type the prompt twice. A read, or a request that never connected, exits 6. Only undici's network failures (`fetch failed` / `terminated` with a coded cause) count as network failures; a request that could not be built is never sent and exits 1.
5. `tab send --wait-ms` is capped at 240000 in the CLI. Node's `fetch` stops waiting for response headers at 300 s, and after the wait the server still takes the dispatch lock and types the prompt. The cap leaves a minute for that. It narrows the window in which a send ends in `outcome-unknown` while the server can still paste; it does not close it.
6. A body without `code` from a server built before this contract is classified by its `error` text (`Tab not found`, `Tab session is not running`, `session not found`, `agent-target-changed`, `agent-not-ready` + `detail`). A rollback therefore does not turn a closed tab back into a retryable exit 1.
7. `bin/cli-commands.js` holds the command-group set. `bin/purplemux.js` and the tests read it. A test holds it equal to the top-level `case` labels of `cli.js` `main()`.
8. `GET /api/cli/api-guide` accepts any valid CLI scope. It accepted only the global token, so an agent tab, which holds a workspace token, got 403.
9. `tab close` prints `ok` only when the body says `ok: true`.

## Options rejected (exit codes)
- **Map HTTP statuses to exit codes.** A 409 is a booting agent, a dead session and a replaced tab at once. The status cannot carry the retry decision.
- **Parse the `error` text.** The text is for people and changes with them. It is kept only as the legacy fallback for pre-contract servers.
- **A table per command group.** Two tables drift, and a caller cannot learn one rule for the whole CLI.

## Decision (reaping)
The tab-owned process set is (a) every descendant of the pane pid and (b) every process of the server's uid whose `/proc/<pid>/environ` contains exactly `PMUX_TAB_ID=<tabId>`. The environment marker survives `setsid`, `nohup`, `disown` and re-parenting to the subreaper. SIGTERM, 3 s grace, SIGKILL; the kill list is returned and audited. `--keep-processes` opts out. Options rejected: a cgroup or systemd scope per tab (strongest, but moves tmux session creation under systemd-run and changes the launch path of every provider — out of proportion); pattern kills (C-341). Linux only; elsewhere the result says `reaper: unavailable` (NFR-7). Story 16 implements this half.

## Consequences
- A caller branches on the exit code alone. Exit 4 is the one to never retry. `session-not-running` is exit 4 although a person can restart the session under the same tab id (`restartTabSession`, `crossCheckLayout`): no caller retry brings it back, so the CLI hint says a person must restart the tab.
- Every new CLI route must return a `code` on each error and register it in the table in `bin/cli.js`. A code absent from the table exits 1, which a caller investigates rather than retries.
- A new command group must be added to `bin/cli-commands.js`; the parity test fails otherwise.
