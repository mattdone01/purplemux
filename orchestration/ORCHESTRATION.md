# purplemux agent orchestration runbook

How to run an epic with a Fable orchestrator delegating to worker agents
(Opus 4.8 claude-code tabs, Codex codex-cli tabs) inside purplemux, without
things silently stalling.

Fork basis: `subicura/purplemux` (installed 0.4.5). Everything here uses the
CLI/HTTP API (`purplemux help`, `purplemux api-guide`).

## How purplemux actually tracks agents (why things stall today)

purplemux installs Claude Code hooks (`~/.purplemux/hooks.json` → `status-hook.sh`)
and a Codex notify hook (`codex-hook.sh`). Those feed `POST /api/status/hook`,
which drives a per-tab **`cliState`** you can read any time:

| cliState | Meaning |
|---|---|
| `busy` | Agent is mid-turn, working |
| `needs-input` | Agent asked a question / hit a permission prompt — **it will sit forever until someone answers** |
| `ready-for-review` | Agent finished its turn — **it will sit forever until someone reads the result and sends the next task** |
| `inactive` | CLI exited (codex) |
| `unknown` | State lost (e.g. after crash); server has a recovery path but don't rely on it |

Built-in stuck detection: `busy` with no events for **10 min** (`BUSY_STUCK_MS`)
is flagged internally, but nothing *acts* on it for you.

So "things just sit there" is almost always one of:
1. a worker in `needs-input` that nobody answered,
2. a worker in `ready-for-review` that the orchestrator never read,
3. the **orchestrator itself** ended its turn (or asked *you* a question) and
   nothing ever woke it again.

The fix for all three is the same: a dumb, deterministic watchdog outside any
LLM — `pmux-watch.sh` — that polls tab states and **sends a nudge message into
the orchestrator tab** on every transition. A `tab send` is a new user turn,
so the orchestrator wakes up, reads the nudge, and acts. No model in the loop
for the wake-up path = nothing to stall.

## Kickoff (step by step)

```bash
export PMUX_PORT=$(cat ~/.purplemux/port)
export PMUX_TOKEN=$(cat ~/.purplemux/cli-token)

# 1. Pick/create the workspace (one per epic; add per-story worktree dirs as you go)
purplemux workspaces

# 2. Create the orchestrator tab (Fable — your Claude Code default)
purplemux tab create -w WS_ID -n orchestrator -t claude-code
# note the tabId it prints, e.g. tab-Abc123

# 3. Start the watchdog in a plain terminal (same box; a purplemux terminal tab is fine)
~/code/ai-server/orchestration/pmux-watch.sh -w WS_ID -o ORCH_TAB_ID

# 4. Send the orchestrator its kickoff prompt (template below)
purplemux tab send -w WS_ID ORCH_TAB_ID "$(cat kickoff-prompt.md)"
```

Watch progress any time:

```bash
watch -n 5 ~/code/ai-server/orchestration/pmux-board.sh -w WS_ID
```

## Orchestrator kickoff prompt template

Fill in the ALL-CAPS parts and send as the first message. The two things that
make this robust: the orchestrator gets the **full purplemux API up front**
(so it never flails), and it is told its loop is **event-driven off
`[pmux-watch]` nudges** (so it never needs to busy-wait or "remember" to check).

```
You are the ORCHESTRATOR for epic EPIC_NAME. You delegate all implementation
to worker agents in purplemux tabs; you never implement stories yourself.

## Environment
export PMUX_PORT=$(cat ~/.purplemux/port); export PMUX_TOKEN=$(cat ~/.purplemux/cli-token)
Workspace: WS_ID. Your own tab: ORCH_TAB_ID (never send to yourself).

purplemux commands you use:
- purplemux tab create -w WS_ID -n story-NN -t claude-code   (or -t codex-cli)
- purplemux tab send -w WS_ID TAB_ID "message"                (submits with Enter)
- purplemux tab status -w WS_ID TAB_ID                        (JSON incl. cliState)
- purplemux tab result -w WS_ID TAB_ID                        (capture pane text)
- purplemux tab close -w WS_ID TAB_ID

## Spawning a worker
1. Create the tab (name it story-NN). For an Opus worker, first send: /model claude-opus-4-8
2. Send ONE self-contained brief: story goal, exact file paths, acceptance
   criteria, commands to run for verification, and this output protocol:
   "Work autonomously. Make reasonable assumptions and note them instead of
   asking, except for destructive/irreversible actions. When finished, end
   with a line 'DONE: <one-line summary>'. If truly blocked, end with
   'BLOCKED: <single specific question>' and stop."
3. Record TAB_ID -> story in your tracking table.

## Event loop (this is your whole job)
A watchdog process sends you '[pmux-watch] ...' messages. On each one:
- NEEDS INPUT  -> tab result to read the question/prompt in full, answer it
  yourself from epic context via tab send. Only escalate to the human if it is
  a real product/scope decision; then say so in your reply and continue other work.
- READY FOR REVIEW -> tab result, check for DONE:/BLOCKED:, run the story's
  verification commands yourself (or spawn a reviewer tab), then either accept
  (update status, close tab or assign next story) or send concrete fix-up
  instructions to the same tab.
- STALLED (busy >10 min) -> tab result to see what it's doing. If genuinely
  working (long build/tests), note it and wait. If looping/hung: send Escape
  via tmux (tmux send-keys -t SESSION_NAME Escape), then re-prompt with a
  tighter instruction; if that fails, close the tab and respawn with an
  amended brief that includes what went wrong.
- DEAD/INACTIVE -> respawn the tab and re-issue the story with prior progress noted.
After handling every nudge, update STATUS_FILE (story -> state, tab, last event)
and end your turn. Do not busy-wait; the watchdog will wake you.

## Rules
- Max N_PARALLEL concurrent workers. One story per worker tab.
- Each story runs in its own git worktree: WORKTREE_PATTERN.
- Never assume a worker's state — always capture the pane before acting.
- Every reply you produce must end with the current status table so the human
  can read progress from your tab at a glance.

Epic context: EPIC_CONTEXT_PATHS (status file: STATUS_FILE).
Begin: read the epic status, then spawn workers for the first N_PARALLEL stories.
```

## Stall playbook (symptom → action)

| Symptom | Detection | Action |
|---|---|---|
| Worker asked a question | `cliState=needs-input`, watch nudges | Orchestrator reads pane, answers via `tab send` |
| Worker finished, nothing happens | `cliState=ready-for-review` | Orchestrator reviews + assigns next work |
| Worker spinning >10 min | watch "STALLED" nudge | Capture pane; wait / Escape+re-prompt / kill+respawn |
| Worker CLI crashed | `alive=false` / `inactive` | Respawn tab, re-issue story |
| Orchestrator asked the human | orchestrator tab shows question; watch keeps nudging so other stories still advance | Answer in the orchestrator tab; it merges your answer next turn |
| Orchestrator went quiet | any next watch nudge re-wakes it | Nothing to do — that's the watchdog's job |

## Preventing stalls at the source

Most `needs-input` events are **missing context in the brief**. The template's
worker protocol ("assume + note instead of asking", `DONE:`/`BLOCKED:` output
contract) removes ~90% of them. Also already in your config:
`dangerouslySkipPermissions: true` — Claude tabs won't stall on permission
prompts (fine on a dedicated box; it's why the worktree-per-story isolation
matters).

Optional: set `notificationsEnabled: true` in `~/.purplemux/config.json` to
get desktop notifications on needs-input; or add an ntfy/Telegram curl inside
`pmux-watch.sh`'s `nudge()` for orchestrator-level `needs-input` (i.e. when
the question is for *you*).

## Visibility cheat-sheet

- `pmux-board.sh -w WS` (or under `watch -n 5`) — every tab, its cliState, and
  the last line it printed.
- **agent-sessions tab**: `purplemux tab create -w WS -t agent-sessions` — the
  built-in UI dashboard over all agent sessions in the app.
- The app's timeline (WebSocket `/api/timeline`) shows a live activity feed;
  `~/.purplemux/session-history.json` keeps prompt→result pairs per session.
- `purplemux tab result -w WS TAB_ID` — snapshot any pane from anywhere
  (works over Tailscale: `networkAccess: "tailscale"` is already set).
- Server logs: `~/.purplemux/logs/`; run with `LOG_LEVELS=hooks=debug` when
  debugging state tracking.
- Orchestrator tab itself: the template makes it end every reply with the
  status table, so it doubles as the epic dashboard.
