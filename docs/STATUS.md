# Claude CLI Work-State Detection

System that detects the in-progress state of the Claude CLI on the server, broadcasts it to the client over WebSocket, and reflects it in the UI indicators.

**Core principle**: `cliState` has a **single source of truth — hook events** (real Claude Code hooks + one hook-equivalent synthesized on the server from the JSONL interrupt marker). All transitions go through `deriveStateFromEvent`, and seq is monotonic per tab. The previous multi-source heuristics (JSONL-driven promotion, pane capture, client-side local derivation) have otherwise been removed; JSONL is only consulted for the synthetic `interrupt` event and for metadata (snippet, currentAction).

---

## State Definitions

### Agent Process State (`agentProcess: boolean | null`)

Determines whether the agent CLI process (Claude, Codex, …) is running inside a tmux pane. Managed independently from `cliState` and detected from two paths (terminal WS and timeline WS).

| Value | Meaning |
| --- | --- |
| `null` | Not yet detected (initial value) |
| `true` | Agent process is running |
| `false` | No agent process |

A separate `agentInstalled: boolean` field (default `true`) gates the entire UI; if `false`, a "Claude not installed" screen is shown.

Two detection paths:

| Path | Trigger | Server check | Sets value |
| --- | --- | --- | --- |
| Terminal WS `onTitleChange` | tmux title change | `/api/check-claude` → `isClaudeRunning()` | `true` / `false` |
| Timeline WS | Session file change | `detectActiveSession()` | `true` / `false` |

Both paths write to the same `agentProcess` field; the `agentProcessCheckedAt` server timestamp prevents stale updates.

The server-side `detectActiveSession` still uses its own `TSessionDetectionStatus` type internally; the client-facing mapping is: `running`/`starting` → `true`, `not-running` → `false`, `not-installed` → `agentInstalled = false`.

### CLI Work State (`TCliState`)

State of the work in progress inside the Claude CLI. Only changed by deterministic derivation from hook events.

| State | Meaning | Trigger |
| --- | --- | --- |
| `busy` | Processing a user request | `prompt-submit` hook |
| `idle` | Response complete + acknowledged by user | `session-start` hook, synthetic `interrupt` event, or `dismissTab` |
| `ready-for-review` | Response complete, awaiting user ack | `stop` hook |
| `needs-input` | Permission prompt / awaiting user input | `notification` hook |
| `unknown` | Was `busy` before a server restart, recovery not finished | Awaiting `resolveUnknown` |
| `inactive` | Initial state when the Claude process is not running | Default on tab creation |
| `cancelled` | User is deleting the tab | Client-only local state |

### Transition Rules (`deriveStateFromEvent`)

Pure function. `src/lib/status-manager.ts`:

```ts
export const deriveStateFromEvent = (event: ILastEvent | null, fallback: TCliState): TCliState => {
  if (!event) return fallback;
  switch (event.name) {
    case 'session-start': return 'idle';
    case 'prompt-submit': return 'busy';
    case 'notification':  return 'needs-input';
    case 'stop':          return 'ready-for-review';
    case 'interrupt':     return 'idle';
  }
};
```

`'interrupt'` is the only event name that does not correspond to a real Claude Code hook. Claude CLI does not fire any hook when the user presses Esc mid-stream, so the JSONL watcher synthesizes one on the server when it sees a `[Request interrupted by user]` entry (see "Synthetic Interrupt Event").

**Exception**: if `prevState === 'cancelled'`, the state stays `cancelled` even when a hook arrives.

**`inactive` handling**: it is just a default value, not a non-overwritable state. Even when a new tab starts in `inactive`, the first `session-start` hook promotes it to `idle`. (Previously both `inactive` and `cancelled` blocked transitions, which caused a bug where "start new conversation" would be stuck on `Creating new conversation...`. The `inactive` block was removed for that reason.)

### Releasing `ready-for-review`

The `ready-for-review → idle` transition only happens through the **`dismissTab` action**:

- The user focuses the tab (auto-dismiss)
- An explicit dismiss from the notification sheet

Hooks and the JSONL watcher do not cause this transition.

### Releasing `needs-input` (User Selection Ack)

When the user selects an option on a permission prompt, Claude resumes work but does not fire a `prompt-submit` hook. Therefore the `needs-input → busy` transition cannot be detected from hooks alone, so the client sends an explicit ack.

**Flow**:

1. `PermissionPromptItem.handleSelect` — after `sendSelection` succeeds, sends a `status:ack-notification` WS message with the current `lastEvent.seq`
2. `StatusManager.ackNotificationInput(tabId, seq)`:
   - If `cliState !== 'needs-input'`, ignore
   - If `lastEvent.name !== 'notification'` or `lastEvent.seq !== seq`, ignore (a newer hook has already arrived)
   - Otherwise: `applyCliState(busy)` + `persistToLayout` + `broadcastUpdate`

**Meaning of the seq guard**: if another hook (consecutive `notification` or `stop`) arrives before the ack does, `entry.lastEvent.seq` increments and no longer matches the ack → ignored. Since the server has already moved to a newer state, the late ack cannot overwrite it (race protection).

`eventSeq` is not incremented — this is a client action, not a hook event. The next real hook will arrive with a value larger than the current seq and be processed normally.

### Tab Display State (`TTabDisplayStatus`)

`selectTabDisplayStatus(tabs, tabId)` maps `cliState` to a UI display value:

| cliState | Display state | UI indicator |
| --- | --- | --- |
| `busy` | `busy` | Spinner |
| `ready-for-review` | `ready-for-review` | Purple dot (pulse) |
| `needs-input` | `needs-input` | Amber dot (pulse) |
| `unknown` | `unknown` | Gray dot (static) |
| `idle` | `idle` | None |
| `inactive` | `idle` | None |
| `cancelled` | (component-specific) | — |

### Session View (`TSessionView`)

Stored directly in the tab state (not derived). Decides which screen the Claude panel shows.

| State | Meaning | Enter condition | Exit condition |
| --- | --- | --- | --- |
| `session-list` | Browsing past sessions | Default. Also entered when `agentProcess` transitions `true → false` while in `timeline` | User clicks new/resume → `check` |
| `check` | Terminal preparation + agent start | User action (new conversation, resume, mode switch) | `agentProcess` becomes `true` → auto-transition to `timeline` |
| `timeline` | Active conversation | Auto from `check` when `agentProcess = true`. Also set directly on initial load if `agentProcess = true` | `agentProcess` transitions `true → false` → auto-transition to `session-list` |

The auto-transitions are handled inside `setAgentProcess`: when `agentProcess` becomes `true` and `sessionView` is `'check'` or `'session-list'`, it flips to `'timeline'`; when `agentProcess` transitions **`true → false`** (agent was confirmed running and then exited) and `sessionView === 'timeline'`, it flips to `'session-list'`. A `null → false` transition does **not** flip, so a freshly opened resume tab stays on `'check'` during initial shell detection until the actual agent process comes up. Additionally, `useTimeline` no longer infers `agentProcess = true` from `timeline:init` alone (JSONL existence ≠ process running) — the store's `agentProcess` is driven by `timeline:session-changed` (`reason='session-waiting'`, only sent when the server confirms a running agent) and by the terminal `onTitleChange` → `/api/check-claude` path.

Gates (checked before the view switch):
- `agentInstalled === false` → not-installed screen
- `agentProcess === null && view !== 'check'` → loading spinner

---

## Tab Store (`useTabStore`)

A Zustand store that manages all tab state as `Record<tabId, ITabState>`.

### Key Fields

| Field | Type | Source | Purpose |
| --- | --- | --- | --- |
| `terminalConnected` | `boolean` | Terminal WS | Whether input is allowed |
| `agentProcess` | `boolean \| null` | Terminal/Timeline WS | Process presence (`null` = not yet detected) |
| `agentProcessCheckedAt` | `number` | Server timestamp | Prevent stale updates |
| `agentInstalled` | `boolean` | Timeline WS | Gate for "not installed" screen |
| `sessionView` | `TSessionView` | User action / auto-transition | Which screen to show |
| `cliState` | `TCliState` | Server WS (`status:update` / hook derivation) | Work state, tab indicator |
| `lastEvent` | `ILastEvent \| null` | Server WS (`status:hook-event`) | Track event order, trigger PermissionPrompt re-fetch |
| `eventSeq` | `number` | Server WS | Monotonic counter to prevent reordering |
| `isTimelineLoading` | `boolean` | Timeline WS init received | Whether timeline data is still loading |
| `compactingSince` | `number \| null` | `pre-compact`/`post-compact` hooks | Drives the timeline compacting indicator |

### Write Paths

| Path | Action | Notes |
| --- | --- | --- |
| Server sync (`status:sync`) | `syncAllFromServer` | Initial load, `cancelled` protected |
| Server update (`status:update`) | `updateFromServer` | Metadata + cliState, `cancelled` protected, **stale seq preserves cliState/busySince/readyForReviewAt/dismissedAt** |
| Server event (`status:hook-event`) | `applyHookEvent` | Updates only `lastEvent`/`eventSeq`, prevents seq reordering |
| User dismiss | `dismissTab` | Local immediate `ready-for-review → idle` + WS `status:tab-dismissed` |
| User tab delete | `cancelTab` | `cliState = 'cancelled'`, local only |

**The client never propagates `cliState` back to the server.** The legacy `notifyCliState` / `status:cli-state` paths have been removed.

### Stale Seq Guard in `updateFromServer`

When `status:update` arrives with `update.eventSeq < existing.eventSeq`, the broadcast is a metadata-only message that was queued behind a newer seq-bearing event. In that case `updateFromServer` preserves `cliState`, `busySince`, `readyForReviewAt`, and `dismissedAt` from the existing state and merges only the non-state metadata fields. This prevents a late `busy` metadata broadcast from clobbering an `idle` state that a higher-seq `interrupt` (or any future event) already set.

### `isCliIdle()` Helper

Both `idle` and `ready-for-review` mean "waiting for work", so:

```ts
export const isCliIdle = (cliState: TCliState): boolean =>
  cliState === 'idle' || cliState === 'ready-for-review';
```

Used in: `WebInputBar` input mode, restart-complete detection, dismiss-on-focus.

---

## Claude Code Hook System

Uses Claude Code's [Hook](https://docs.anthropic.com/en/docs/claude-code/hooks) feature to receive Claude's work state immediately.

### Hook Settings

`ensureHookSettings()` runs at server startup and creates `~/.purplemux/hooks.json`.

| File | Purpose |
| --- | --- |
| `~/.purplemux/hooks.json` | Hook event → shell script mapping |
| `~/.purplemux/status-hook.sh` | Script that POSTs to the server |
| `~/.purplemux/port` | Current server port (referenced by the script) |

### Hook Event Mapping

| Claude Code Hook | Sent event | Result |
| --- | --- | --- |
| `SessionStart` | `session-start` | → `idle` |
| `UserPromptSubmit` | `prompt-submit` | → `busy` |
| `Notification` | `notification` | → `needs-input` (filtered by notificationType) |
| `Stop` | `stop` | → `ready-for-review` |
| `StopFailure` | `stop` | → `ready-for-review` |
| `PreCompact` | `pre-compact` | → `compactingSince = now` (cliState unchanged) |
| `PostCompact` | `post-compact` | → `compactingSince = null` (cliState unchanged) |
| _(synthesized by JSONL watcher)_ | `interrupt` | → `idle` (see below) |

`pre-compact`/`post-compact` do not touch `cliState`/`eventSeq`/`lastEvent`; they only set the separate `compactingSince` field. That value drives the timeline-view's compacting indicator (60s window). To handle a missing `post-compact`, the server auto-clears it via a `COMPACT_STALE_MS = 60s` timer.

### Notification Filtering (`INPUT_REQUESTING_NOTIFICATION_TYPES`)

Claude's `Notification` hook fires at many moments, but only cases that need user input should transition to `needs-input`. The whitelist in `status-manager.ts`:

```ts
const INPUT_REQUESTING_NOTIFICATION_TYPES = new Set(['permission_prompt', 'worker_permission_prompt']);
```

The hook script parses `notification_type` from the stdin JSON and includes it in the payload, so the server ignores types that are not in the whitelist (e.g. idle notifications) without transitioning state.

### Hook Script

`~/.purplemux/status-hook.sh` is generated from `HOOK_SCRIPT_CONTENT` in `hook-settings.ts`. Core behavior:

- Looks up the session name with `tmux display-message` (so the server knows which tab)
- If `event === 'notification'`, parses `notification_type` from stdin JSON and includes it in the payload
- POSTs `{ event, session, notificationType? }` to `/api/status/hook` via `curl`

### Synthetic Interrupt Event

Claude CLI aborts a streaming turn locally when the user presses Esc and writes `[Request interrupted by user]` into the transcript JSONL without firing any hook (`query.ts:createUserInterruptionMessage`). To recover `busy → idle` without leaving the tab stuck, `onJsonlFileChange` synthesizes a hook-equivalent `interrupt` event:

1. `scanLines` sets `interrupted: true` when the last non-sidechain user entry's first content block starts with `[Request interrupted by user` (see `INTERRUPT_PREFIX`). This naturally handles the "user typed a new prompt right after Esc" case — the new user entry becomes the last match and suppresses the synthesis.
2. `onJsonlFileChange` fires `updateTabFromHook(tmuxSession, 'interrupt')` when **all** of the following hold:
   - `entry.cliState === 'busy'`
   - `scan.lastEntryTs > entry.lastInterruptTs` (dedup: new interrupt line, not a previously processed one)
   - `scan.lastEntryTs > entry.lastEvent.at` (race guard: no real hook arrived after the interrupt was written)
3. `updateTabFromHook` goes through the usual path — bump `eventSeq`, broadcast `status:hook-event`, apply `deriveStateFromEvent → 'idle'`, `persistToLayout`, `status:update`. Push notifications are skipped because only `ready-for-review`/`needs-input` trigger push.

The `lastEvent.at` comparison protects against a narrow race: `prompt-submit` hook POST arriving at the server before the JSONL FS event fires for the interrupt line. Without the guard, the synthetic interrupt could fire after `prompt-submit` was already processed and drag the state back to `idle`.

After transitioning to `idle`, `applyCliState` stops the JSONL watcher (idle is not a watched state). It will be restarted by the next `prompt-submit` hook.

### Grok Hook Mapping

Grok Build reaches the same endpoint with `?provider=grok`, and its payload is translated by
`src/lib/providers/grok/hook-payload.ts`. The envelope's keys are camelCase (`hookEventName`,
`sessionId`, `notificationType`, `toolResult`) while the `hookEventName` VALUE is snake_case
(`session_start`, `stop_cancelled`); the translator normalises both spellings.

| grok hook | Sent event | Result |
| --- | --- | --- |
| `SessionStart` | `session-start` | → `idle`, and publishes session info (`sessionId`, `cwd`) |
| `UserPromptSubmit` | `prompt-submit` | → `busy`; the prompt becomes `lastUserMessage` + the tab summary |
| `Stop` | `stop` | → `ready-for-review` |
| `StopFailure` | `stop` | → `ready-for-review` |
| `StopCancelled` | `interrupt` | → `idle` |
| `SessionEnd` | `interrupt` | → `idle` |
| `PreCompact` | `pre-compact` | → `compactingSince = now` (cliState unchanged) |
| `PostCompact` | `post-compact` | → `compactingSince = null` (cliState unchanged) |
| `PostToolUse` | _(no state event)_ | feeds `handleToolActivity`, like Claude's `post-tool` |
| `Notification` `permission_prompt` | `notification` | → `needs-input` |
| `Notification` `idle_prompt` / `task_complete` | `stop`, **only while the tab is busy** | → `ready-for-review` |

Three rules are specific to grok and are deliberate:

- **`StopCancelled` runs INSTEAD of `Stop`** when a turn ends without completing — a user interrupt,
  a declined permission prompt, the turn limit, or a no-progress bail-out — so it is the interrupt
  signal, not a second stop.
- **`idle_prompt` is a backstop, not a turn end.** grok fires it about a minute after a session
  settles, after interrupted and errored turns too, and it is the only report for the turns that
  produce none of the three stop events. Settling on it unconditionally would drag a tab the user has
  since re-prompted back out of `busy`, so `shouldEmitGrokHookEvent` only lets it through while the
  tab is still `busy`.
- **A subagent's events are dropped.** Every event that can fire inside a subagent carries
  `subagentType`, and a background subagent outlives the parent turn; reporting its stop would settle
  the tab while the session is still working.

purplemux registers no blocking `Stop` gate, so grok's `Stop` fire is a genuine turn end rather than
a continuation round.

Codex's TUI-ready detector (`checkCodexTuiReady`) is **not** applied to grok. Whether grok needs the
same synthetic `session-start` has not been measured on a live tab, and copying it blind would put a
tab into `idle` on a signal that may not mean the same thing.

### Agent Tab Hooks (Reference)

Normal tabs go through the shell script above, but **agent tabs / brain sessions** use `type: 'http'` hooks generated by `buildAgentTabHookSettings` / `buildAgentBrainHookSettings`, which POST directly to `/api/agent-rpc/{agentId}/...` (only `Stop` / `StopFailure`). They are separate from the StatusManager path and are out of scope here.

### Hook API Endpoint

`/api/status/hook` — requires `x-pmux-token` header (same CLI token as `/api/cli/*`). Pure forward: emits the raw payload onto the per-provider EventEmitter (`globalThis.__ptClaudeHookEvents` for Claude, `globalThis.__ptCodexHookEvents` for Codex). The provider observer (attached per tab via `IAgentProvider.attachWorkStateObserver`) is the sole listener — it translates the payload, applies any provider-specific meta side effects, and forwards a `TAgentWorkStateEvent` to `StatusManager.handleObserverEvent`, which dispatches into `updateTabFromHook`. If `event` is `poll` or `session` is missing on the Claude path, the endpoint triggers a full poll directly.

### Processing Flow (`updateTabFromHook`)

```
hook received
  │
  ├─ look up tabId/entry (return if missing)
  ├─ check event whitelist (session-start/prompt-submit/notification/stop)
  │
  ├─ entry.eventSeq += 1
  ├─ entry.lastEvent = { name, at: Date.now(), seq }
  ├─ broadcast status:hook-event (seq + name + at)
  │
  ├─ newState = deriveStateFromEvent(entry.lastEvent, prevState)
  │   (if prevState === 'cancelled', stays the same)
  │
  └─ if prevState !== newState:
      ├─ applyCliState(tabId, entry, newState)
      ├─ persistToLayout(entry)
      └─ broadcast status:update
```

After a `stop` event, `refreshSnippet` asynchronously reads the final JSONL state and broadcasts `currentAction` / `lastAssistantSnippet` (with a 500ms delay).

### Event Shadowing (`status:hook-event`)

`status:hook-event` is **always** broadcast even if `cliState` doesn't change (e.g. consecutive `notification` while already in `needs-input`). The client only applies it in `applyHookEvent` when `event.seq > prev.eventSeq`, preventing reordering.

`PermissionPromptItem` subscribes to `lastEvent.seq` as a `useEffect` dep so that consecutive permission prompts auto-refetch new options:

```
Consecutive permission prompts:
prompt-submit → lastEvent{name:'prompt-submit', seq:1} → busy
notification  → lastEvent{name:'notification', seq:2}  → needs-input
user selection
notification  → lastEvent{name:'notification', seq:3}  → needs-input (same cliState, seq++)
stop          → lastEvent{name:'stop', seq:4}          → ready-for-review
```

---

## Server Restart Policy

The only state that can be lost across a server restart is `busy` (Claude might fire `stop`/`notification` while the server is down). All other states have "the ball in the user's court", so no automatic transitions occur and the persisted value can stay as-is.

`StatusManager.scanAll` reads the persisted `cliState` from the layout:

| Persisted cliState | After restart | Follow-up |
| --- | --- | --- |
| `busy` | **`unknown`** | `resolveUnknown` scheduled immediately |
| `needs-input` | unchanged | JSONL watcher started |
| Others | unchanged | — |

### `resolveUnknown` — Background Recovery for Unknown Tabs

For tabs converted to `unknown` from `busy`, only definitive signals are used to promote:

1. **Claude process check** — `isClaudeRunning(panePid)` fails → confirm `idle` (silent, no push)
2. **JSONL tail check** — `checkJsonlIdle` returns `idle && !stale && lastAssistantSnippet` → confirm `ready-for-review` (silent)
3. **Otherwise** → keep `unknown`, wait for the next hook

**Pane capture is not used.** A previous permission prompt left in the scrollback could be misread as the current one.

JSONL watcher is also started in the `unknown` state — it does not change `cliState`, but `currentAction` / `lastAssistantMessage` metadata keep updating.

### Busy Stuck Safety Net

If a `busy` state lasts longer than `BUSY_STUCK_MS` (**10 minutes**) and the agent process has died, silently recover to `idle`. Performed inside the metadata poll loop. Designed to handle dropped `stop` hooks (e.g. SIGKILL).

### Agent-Gone Inactive Guard (F1/F2)

For agent tabs in any active state (`busy` / `idle` / `needs-input` / `ready-for-review`), the metadata poll silently transitions to `inactive` only when **all** of the following hold:

1. The agent process is not running for the pane (`provider.isAgentRunning(panePid)` returns `false`).
2. **F1 — recent-launch grace fails**: `lastResumeOrStartedAt` is undefined or older than 5 seconds. The stamp is refreshed by auto-resume `sendKeysSeparated`, the synthetic and real `session-start` hooks, and any other path that calls `StatusManager.markAgentLaunch`. This blocks the brief boot window where the Rust binary (e.g. Codex) has spawned but the process tree has not yet caught up.
3. **F2 — pane title is shell-style**: the title looks like `<cmd>|<path>` (i.e. tmux's `set-titles-string` default) or is empty. Agent CLIs override this to their own format, so a non-shell title is treated as "agent still owns the pane" and skips the transition. This blocks the false negative when an agent forks a transient child mid-poll.

Together these guards keep the `cliState` stable through the boot/fork windows that previously caused indicator ping-pong, while still recognizing a clean exit (`/quit`, `/exit`) within one poll cycle.

---

## JSONL Watcher (Metadata Only)

For tabs in `busy` / `needs-input` / `unknown` / `ready-for-review`, an `fs.watch` is set on the JSONL file and `checkJsonlIdle` is called on file changes.

| Trigger | Action |
| --- | --- |
| Start | Entering `busy`/`needs-input`/`unknown` (hook path or scanAll) |
| Process | Updates only `currentAction`, `lastAssistantMessage`, reset signals → broadcast `status:update` |
| Release | Transition to `idle`/`inactive`, tab deletion, shutdown |

**Key**: the JSONL watcher normally touches only metadata. The one exception is the synthetic `interrupt` event (see "Synthetic Interrupt Event") — it is the only path where the JSONL watcher drives a `cliState` transition, and it does so by going through the standard `updateTabFromHook` pipeline rather than bypassing it. There used to be an automatic `busy → ready-for-review` promotion path, but that was removed; only the `stop` hook triggers `ready-for-review`.

---

## Metadata Poll

A **metadata-only** poll that does not touch `cliState`.

### Cadence

| Tab count | Interval |
| --- | --- |
| 1–10 | 30s |
| 11–20 | 45s |
| 21+ | 60s |

### Cost per poll

| Operation | Count |
| --- | --- |
| `tmux list-panes -a` | 1 (single batch) |
| Filesystem reads (workspace/layout JSON) | workspace count + α |
| Process check (`pgrep`/`ps`) | only for tabs caught by the busy stuck check |
| JSONL tail read | 1 per newly discovered tab (existing tabs go through the watcher path) |

### What Each Poll Does

- New tab found → `readTabMetadata` loads initial metadata + creates entry
  - Persisted `cliState === 'busy'` → converted to `'unknown'` + `resolveUnknown` scheduled
- Existing tab → updates process/ports/title/summary (cliState untouched)
- Busy stuck check → 10 minutes elapsed + Claude process dead → silent `idle`
- Deleted tabs → cleanup + `broadcastRemove`

Removing the `cliState` decision and the `hasPermissionPrompt` check has reduced poll cost by roughly 80% compared to pre-Phase 1.

---

## Data Flow

```
[Claude Code Hook]
  ~/.purplemux/status-hook.sh
  └─ curl POST /api/status/hook
     │
     ▼
[/api/status/hook] (x-pmux-token required)
  └─ globalThis.__pt<Provider>HookEvents.emit('hook', ...)
     │
     ▼
[Provider observer] (attached per tab via attachWorkStateObserver)
  ├─ filter by tmuxSession
  ├─ apply provider-specific meta (codex applyCodexHookMeta)
  └─ translate → emit(TAgentWorkStateEvent)
     │
     ▼
[StatusManager.handleObserverEvent → updateTabFromHook]
     │
     ├─ entry.eventSeq++
     ├─ entry.lastEvent = { name, at, seq }
     ├─ broadcast status:hook-event
     ├─ deriveStateFromEvent → newState
     └─ if prevState !== newState:
         ├─ applyCliState (idempotent guard + push notification)
         ├─ persistToLayout (layout JSON)
         └─ broadcast status:update
             │
             ▼
[JSONL Watcher] (parallel)
  Watches only busy/needs-input/unknown/ready-for-review tabs
  On file change: checkJsonlIdle → updates currentAction/lastAssistantSnippet
  └─ broadcast status:update (cliState unchanged)
             │
             ▼
[Metadata Poll] (parallel, 30–60s)
  - Detect new / removed tabs
  - Update process/ports/summary
  - Busy stuck safety net
  - Persisted busy → unknown conversion + resolveUnknown
             │
             ▼
[Status WebSocket] /api/status
  Server → client: status:sync / status:update / status:hook-event
  Client → server: status:tab-dismissed / status:ack-notification / status:request-sync
             │
             ▼
[Zustand store] useTabStore
  syncAllFromServer / updateFromServer (metadata + cliState)
  applyHookEvent (lastEvent/eventSeq, prevents seq reordering)
  dismissTab / cancelTab (local actions)
             │
             ▼
[UI components]
  TabStatusIndicator         tab-bar indicator
  WorkspaceStatusIndicator   sidebar workspace
  PermissionPromptItem       timeline, re-fetched via lastEvent.seq
  NotificationSheet          notification sheet
  Bell icon                  sidebar + app header
  useBrowserTitle            browser tab title
```

### Terminal WS Path (Process Detection, Independent of cliState)

```
tmux title change → onTitleChange
  ├─ formatTabTitle → updates tab display name
  └─ fetch /api/check-claude
      └─ isClaudeRunning(panePid)
          └─ setAgentProcess(tabId, true | false)
              (auto-transitions: check→timeline on true, timeline→session-list on false)
```

### Timeline WS Path (Sessions + Entries)

```
Timeline WS connects → server runs detectActiveSession
  ├─ session-changed → reflected in agentProcess
  ├─ timeline:init → entries received, isTimelineLoading = false
  └─ timeline:append → entries appended
      └─ useTimeline.onSync callback
          ├─ setAgentProcess(tabId, true | false)
          ├─ setAgentInstalled(tabId, false) (if not-installed)
          └─ setTimelineLoading(tabId, loading)
```

`useTimeline` **no longer derives `cliState` locally** (the old `deriveCliState` was removed). The timeline WS handles only metadata (entries, summaries); `cliState` is updated solely via the hook path.

---

## Logging Configuration

### Global Level

```bash
LOG_LEVEL=debug pnpm dev      # all groups
```

### Per-module Level

The `LOG_LEVELS` env var splits levels per group. `createLogger(name)` applies the group's level to a child logger.

```bash
# Trace only the Claude Code hook behavior in debug
LOG_LEVELS=hooks=debug pnpm dev

# Multiple groups at once
LOG_LEVELS=hooks=debug,status=warn pnpm dev
```

Main groups:

| Group | Source | Debugging target |
| --- | --- | --- |
| `hooks` | `api/status/hook.ts`, `status-manager.ts` (`hookLog`) | Hook receive/process/transition |
| `status` | `status-manager.ts` (`log`) | Poll, JSONL watcher, broadcast |
| `tmux` | `lib/tmux.ts` | tmux command execution |

With `hooks=debug` you see, for example:

- `[hooks] received { event, session }` — hook endpoint received
- `[hooks] no tabId for session` / `no entry for tab` — failure cases
- `[hooks] processed { tabId, event, seq, prevState, newState, transition }` — processing result

### How It Works

`src/lib/logger.ts` parses `LOG_LEVELS`, sets the root logger's level to the minimum across groups, then `createLogger(name)` applies each group's level to its child logger. Pino requires the root to be open down to the lowest level for child filtering to work.

---

## Related Files

### Types

| File | Description |
| --- | --- |
| `src/types/status.ts` | `ITabStatusEntry`, `ILastEvent`, `TEventName`, `TTabDisplayStatus`, WebSocket messages |
| `src/types/timeline.ts` | `TCliState`, `TSessionDetectionStatus` (server-only) |

### Server

| File | Description |
| --- | --- |
| `src/lib/status-manager.ts` | `deriveStateFromEvent`, `updateTabFromHook`, `applyCliState`, `resolveUnknown`, `readTabMetadata`, busy stuck safety net, metadata poll, JSONL watcher |
| `src/lib/status-server.ts` | `/api/status` WebSocket handler |
| `src/lib/hook-settings.ts` | Hook settings file generation, script management |
| `src/pages/api/status/hook.ts` | Hook API endpoint (x-pmux-token required) |
| `src/lib/session-detection.ts` | `detectActiveSession`, `isClaudeRunning` |
| `src/pages/api/check-claude.ts` | Claude process detection API |
| `src/lib/layout-store.ts` | `updateTabCliStatus`, etc. (layout JSON writes) |
| `src/lib/logger.ts` | `LOG_LEVELS` parsing + per-group pino child |

### Client

| File | Description |
| --- | --- |
| `src/hooks/use-tab-store.ts` | Zustand tab store, `applyHookEvent`, `selectTabDisplayStatus` |
| `src/hooks/use-agent-status.ts` | Status WebSocket, `status:hook-event` / `status:update` / `standup:update` handling, `dismissTab` |
| `src/hooks/use-standup-store.ts` | Zustand standup store (latest tick per workspace) |
| `src/hooks/use-timeline.ts` | Timeline WS data (no cliState derivation) |
| `src/hooks/use-web-input.ts` | Input mode decision (`unknown` allows input) |
| `src/hooks/use-native-notification.ts` | Desktop native notifications |
| `src/hooks/use-browser-title.ts` | Browser title attention count |

### UI Components

| File | Role |
| --- | --- |
| `src/components/features/workspace/tab-status-indicator.tsx` | Tab-bar indicator |
| `src/components/features/workspace/workspace-status-indicator.tsx` | Sidebar workspace dot |
| `src/components/features/mobile/mobile-workspace-tab-bar.tsx` | Mobile tab bar |
| `src/components/features/timeline/permission-prompt-item.tsx` | Permission prompt UI (`lastEvent.seq` subscriber) |
| `src/components/features/workspace/notification-sheet.tsx` | Notification sheet + `useNotificationCount` |
| `src/components/features/workspace/workspace-standup.tsx` | Sidebar standup chip + popover panel |

---

## Standup Ticks

Orchestrators post a structured "standup tick" per workspace — a mini-standup answering
"where are things at, are we progressing, any blockers, am I needed" without opening a pane.

### Data flow

```
orchestrator tab
  purplemux standup report -w WS --json '{...}'
    → POST /api/cli/workspaces/{wsId}/standup   (authorizeWorkspace: own-workspace token suffices)
    → parseStandupReport (src/lib/standup.ts — clamps text, drops malformed rows)
    → StatusManager.reportStandup
        ├─ standups map (in-memory, keyed by wsId, newest-at wins)
        ├─ standup-store.addStandup → ~/.purplemux/workspaces/{wsId}/standups.json (history, cap 50)
        └─ broadcast { type: 'standup:update', standup }
             → use-agent-status.ts → useStandupStore
             → workspace-standup.tsx (sidebar chip + popover)
```

`status:sync` carries `standups` (latest per workspace) so a fresh client starts populated;
`StatusManager.init` hydrates the map from disk so ticks survive a server restart.

### When ticks are posted

The kickoff template (`DEFAULT_KICKOFF_TEMPLATE`) instructs the orchestrator to post one
after every nudge it handles, and the idle keeper heartbeat asks for one on every beat —
each heartbeat is thereby a standup tick. A final tick (state `done` or `awaiting-human`)
is requested before `orchestration off`.

### Shape

`IWorkspaceStandup` (`src/types/status.ts`): `state` (`on-track | at-risk | blocked |
awaiting-human | done`), `headline`, `items[]` (`label`, `status: done | active | blocked |
todo`, `note?`), `blockers[]` (`what`, `needs` — the exact input that clears it),
`needsHuman`, `next[]`. The sidebar chip shows the state dot, done-count, and headline;
ticks older than `STANDUP_STALE_MS` (20 min) render as stale.

## Notification System

### Notification Sheet (`NotificationSheet`)

Shown as a Sheet when the Bell icon is clicked. Four sections: in-progress (`busy`), awaiting input (`needs-input`), review (`ready-for-review`), done (`done`).

The done section shows tabs that were acknowledged via `dismissTab` (have a `dismissedAt` value and `cliState` is `idle`/`inactive`), excluding the currently active tab, sorted by recency. When new work starts on such a tab, `dismissedAt` is reset and the tab leaves the list.

### Count Aggregation Scope

The `useNotificationCount` hook walks all tabs and aggregates `busy` / `needs-input` / `ready-for-review`. The currently active tab is included, so the sidebar, app header, and notification sheet share the same count and the number does not drop just because you opened the tab.

### `unknown` Handling

Tabs in `unknown` are **excluded** from both attention and busy counts. This is intentional, so the indeterminate state right after a restart does not raise a notification. Only the sidebar badge shows quietly as a gray dot.

### Alert Policy (`src/lib/alert-policy.ts`)

One predicate decides every alert, for every channel — web push, the `/api/status` socket, the Electron native notification (`use-native-notification.ts`) and the in-app toast (`use-toast-notification.ts`). `alert-policy.ts` is browser-safe, so the hooks import the same function the server calls.

```ts
shouldAlert({ id: tabId }, workspace, config)
```

| `alertsOrchestratorOnly` | Workspace | Result |
| --- | --- | --- |
| `true` (default) | orchestrated | only the orchestrator tab alerts |
| `true` | not orchestrated | nothing alerts |
| `false` | orchestrated | orchestrator alerts, workers stay muted |
| `false` | not orchestrated | every agent tab alerts (the pre-dispatcher rule) |

`alertsOrchestratorOnly` is a `config.json` key (`ALERTS_ORCHESTRATOR_ONLY_DEFAULT`), toggled in Settings → Notifications.

### Alert Kinds

| Kind | Title | Fired from |
| --- | --- | --- |
| `needs-input` | Input Required | `applyCliState` → `needs-input` |
| `review` | Task Complete | `applyCliState` → `ready-for-review` |
| `standup-needs-human` | Standup Needs You | `reportStandup` when `needsHuman` (or state `blocked`/`awaiting-human`); addressed to the orchestrator tab, body is the headline |
| `orchestrator-stalled` | Orchestrator Stalled | `runOrchestratorKeeper` on the `ORCH_MAX_HEARTBEATS` beat, once per stall episode |

The idempotent guard at the top of `applyCliState` (`prevState === newState`) blocks duplicate calls, so callers don't have to track state.

"Silent" paths such as `resolveUnknown` / `dismissTab` / busy-stuck safety net / server restart recovery suppress the alert by passing `{ silent: true }`.

### NotificationDispatcher (`src/lib/notification-dispatcher.ts`)

`getNotificationDispatcher()` (registry on `globalThis.__ptNotificationDispatcher`) fans one alert out to every registered channel. `getStatusManager()` registers the two defaults plus `fcm` when it is configured; a failing channel is logged and never blocks the others. Each dispatch stamps the alert with an `id` and a monotonic `seq`.

- **`status-socket`** — broadcasts `{ type: 'notification:alert', alert }` to every `/api/status` client. Always broadcast; clients decide what to show. The web client ignores unknown frame types, so this is safe for older clients.
- **`web-push`** — sends the VAPID payload. Visibility is checked **per subscription**: a subscription bound to a `deviceId` is muted only when that device reports visible (`POST /api/push/visibility`), so a focused desktop no longer mutes the phone. Unbound legacy rows keep the old global gate. `404`/`410` reap the subscription.

- **`fcm`** — POSTs a **data-only** FCM HTTP v1 message per registration (`src/lib/fcm-channel.ts`), so the app renders the alert itself and keeps its kinds, actions and deep link; an FCM `notification` block would be rendered by Play services instead and is never sent. `data` carries the whole `notification:alert` payload as strings, plus `agentSessionId` / `workspaceDir` when the dispatch had them. `android.priority` is `high` for `needs-input` and `normal` otherwise. The visibility gate is the Web Push gate. An `UNREGISTERED` or `INVALID_ARGUMENT` response reaps the token, as `404`/`410` reap a Web Push endpoint — **except** when the error carries a `google.rpc.BadRequest` detail (`fieldViolations`). FCM answers `INVALID_ARGUMENT` both for a dead registration and for a message it cannot parse, and only the second carries field violations; reaping on our own malformed message would unsubscribe every device on the first dispatch. That case reaps nothing and logs at `error` with the offending field paths. Registered only when `FCM_SERVICE_ACCOUNT_PATH` names a readable service-account key file — otherwise one log line and no channel (ADR-011). Access tokens are minted from that key with a JWT-bearer grant (`src/lib/fcm-auth.ts`, `jose`) and cached until expiry.

The socket `notification:alert` broadcast is untouched by the FCM channel: foreground banners still come from `status-socket`, and `fcm` covers the backgrounded phone.

The push payload keeps its existing shape and adds `kind`, `isOrchestrator`, `alertId`, and `agentSessionId`. `claudeSessionId` stays as-is for `public/sw.js` back-compat.
