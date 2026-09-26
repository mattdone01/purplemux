# ADR-0010: per-tab caller identity and one tab-closed event

_Epic story: 01 (see `_output/purplemux-portfolio-coordination/stories/01-tab-caller-identity.md`)._

## Status
Accepted (2026-09-26, epic `purplemux-portfolio-coordination`, story 01).

## Context
Coordination records (leases, notes, watches, grants — ADR-0011 to ADR-0015) must name the tab that holds them. `TCliScope` names a workspace or `admin`, never a tab. Any process in a workspace holds that workspace's token (`PMUX_TOKEN`). The admin token (`~/.purplemux/cli-token`) is readable by every process of the user. The CLI found its own tab by parsing the tmux session name, which is wrong for an orphan session adopted at boot: the session keeps its old name under a new tab id.

## Options
1. **Asserted tab id.** The CLI sends `X-Pmux-Tab`; the server checks that the tab belongs to the token's workspace. Cheap, but any tab can claim to be any other tab of its workspace.
2. **Per-tab token** minted at session creation, injected as `PMUX_TAB_TOKEN`, revoked on close. The token itself names the tab.
3. **OS identity** (the peer pid of the HTTP connection, then the tmux pane ancestry). Not available over TCP from Next API routes; fragile.

## Decision
Option 2, with option 1 as a marked fallback.

- `src/lib/tab-token.ts` mints a 32-byte hex token per tab into `~/.purplemux/tab-tokens.json` (`{ [tabId]: { token, workspaceId, sessionName, createdAt } }`, mode 0600, tmp + rename, promise mutex on `globalThis`). A session recreated for an existing tab (boot cross-check, auto-resume, restart) reuses the tab's token.
- `createSession` receives `{ workspaceId, tabId }` from every call site, because every caller creates the tmux session before the tab is written to the layout. `workspaceEnv` adds `PMUX_TAB_TOKEN`, `PMUX_TAB_ID` and `PMUX_WORKSPACE_ID`. A failed mint costs the tab its tab identity, not its workspace scope. The ad-hoc session of a websocket without a session id belongs to no tab and gets none.
- `resolveCliScope` maps a tab token to `{ type: 'workspace', workspaceId, tabId, tabVerified: true }`. `canAccessWorkspace` and `canDriveWorkspace` never read `tabId`, so they answer exactly as for the workspace token.
- `src/lib/caller.ts` `resolveCaller(req)` answers "who is calling": a tab token gives a verified tab; a workspace token plus an `X-Pmux-Session` header naming a session of a tab **in that workspace** gives that tab unverified (tabs created before this change); a session of another workspace is ignored; the admin token gives `admin: true` — never "human", because every agent process can read it.
- `src/lib/tab-lifecycle.ts` emits one `tab-closed` event per closed tab. It keeps, per workspace, the tab set of the last layout written, and it compares each new write against it; the first write after a boot compares against the file on disk. A workspace delete emits for each of its tabs. The StatusManager is one listener; later stores subscribe the same way. The tab token is revoked on the event.
- Boot: the workspace store's cross-check adopts an orphan session under the tab id its token was minted for (exact workspace and session name), so the layout id equals the shell's `PMUX_TAB_ID`; a pre-token orphan gets a new id. `initTabTokens` then removes, logs and emits `tab-closed` (reason `boot-sweep`) for every token whose tab no longer exists, moves any token whose exact session name another tab id now holds, and keeps (with a warning) any token whose session still runs in tmux although no layout names it — a layout reset must not cost a live shell its scope. The server never parses a tab id out of a session name.
- A new token that cannot be saved is withdrawn and the tab launches without tab identity; an unreadable token file is moved aside, never overwritten. A workspace delete revokes every token of the workspace, including tabs that never reached its layout, with one `workspace-deleted` event each. Only a JSON parse failure moves the token file aside. Any other read error (EACCES, EMFILE) serves an empty map for that run, and the next save replaces the file with it: tabs that hold a token then fail closed (403) until they are recreated. The CLI does not fall back to `PMUX_TOKEN` on that 403; story 02's error contract owns any retry.
- `boot-sweep` events fire before the StatusManager starts. A later store that must see them subscribes before `initTabTokens`, or reconciles against `listLiveTabIds()` itself. "Exactly one event" holds within one process: a crash between a revoke in memory and its write can repeat the event at the next boot, so listeners stay idempotent.
- `bin/cli.js` presents `PMUX_TAB_TOKEN` > `PMUX_TOKEN` > the `-w` workspace's token on disk > the admin token. Without a tab token it sends `X-Pmux-Session` from `tmux display-message` when it runs inside tmux. `deriveOwnTabId` prefers `PMUX_TAB_ID`.

## Consequences
Verified identity arrives with each newly created tab. Tabs that existed before the deploy stay unverified until they are recreated, because `tmux set-environment` does not reach a running shell. Grants (ADR-0014) require verified identity; leases, notes and watches record the flag.

Threat model: accidental collision between cooperating agents. A same-workspace agent can still read a sibling tab's environment through `/proc`; that is outside this epic's threat model.

## Amendment (story 36, 2026-09-26): hook-time identity for tabs created before tab tokens

Verified means the server bound the token to the tab when it created the session. Identity taken on the
caller's word, per call or at hook time, is never verified.

- A running shell's environment cannot be changed, but Claude Code hands its SessionStart hook a
  `$CLAUDE_ENV_FILE` whose exports reach every later Bash command (measured on 2.1.283; CwdChanged too).
  purplemux rewrites `status-hook.sh` at every server start and running agents execute the file, so the next
  SessionStart (compact, clear, resume) of an old Claude tab runs the new hook without an agent restart.
- The hook asks only when `$PMUX_TAB_ID` is empty and `$PMUX_TOKEN`, `$TMUX_PANE` and `$CLAUDE_ENV_FILE` are
  set: `POST /api/cli/tab-identity {session}` with the PANE's workspace token (never the admin token, which is
  tied to no workspace), for the exact pane's session (`tmux display-message -t $TMUX_PANE`). The session must
  be a live tab of that workspace. Mint-only: a tab with a launch token answers 409 and never gets it; a tab
  that already took a hook token gets the same one back.
- Token records carry `origin: 'launch' | 'hook'` (absent = launch; an unknown value counts as hook) and
  `injectedAt`. `resolveCliScope` sets `tabVerified` only for launch records. `ICaller.verified` stays a
  boolean for launch proof; `ICaller.identity` is `launch | hook | session | none`, with
  `verified === (identity === 'launch')`. Leases, notes, watches and fleet-config audit lines store
  `identity` beside `verified`; a lease label reads `hook-identity`. Grants still require `verified`.
- A session the server recreates for a hook-token tab binds that token at launch: the record becomes
  `launch`.
- The ruling's disproof test holds and is pinned: a sibling tab holding the same workspace token can obtain
  another tab's hook token (the server cannot tell the real hook from it over TCP), which is exactly why a hook
  token is never verified.
- Not reached: Codex, Grok and terminal tabs created before tab tokens have no such hook; they stay
  `identity: none` (the `X-Pmux-Session` fallback) until recreated. `tab list` / `tab status` show
  `identity: launch | hook | none` per tab.

Source of truth for the epic: `_output/purplemux-portfolio-coordination/architecture.md` (nomupay workspace).
