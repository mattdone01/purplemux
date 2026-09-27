# ADR-0020: Hooks spool what no server answers; the next server replays it

## Status
Accepted (2026-09-27), h-selfimprove item `hook-gap`. Amends ADR-0017 (a deploy step before the restart).

## Context
Every agent state change reaches the server as a hook POST (`status-hook.sh`, `codex-hook.sh`, `grok-hook.sh`). The scripts ran `curl -s … 2>/dev/null` and exited 0 on any failure, and exited at once when `~/.purplemux/port` was absent. The server removes the port file on shutdown. So every event that fired between the stop and the new server's port file was lost: a turn that ended during a restart left its tab `busy` with no stop, and its orchestrator was never told. Measured 27 Sep ~15:00Z: the watchdog fix d1fd69bd was held back because a mid-turn tab in another workspace would have lost its events to the restart.

## Decision
1. **Spool on failure, in the hook.** Each script POSTs as before. When no server answers, it writes the event to `~/.purplemux/hook-spool/<epoch-ms>-<pid>-<rand>.json` (dir 0700): a dot-named temporary, then one rename. "No server answers" is: no port or token file; curl exit 7; curl exit 28 with `time_connect` 0 (the connect never finished); or an HTTP 5xx. A 2xx-4xx answer, or a timeout after the connect, is never spooled, because the server may have applied the event. Only purplemux sessions (`pt-*`) spool: the Codex hook is global and fires outside purplemux too. A `poll` is never spooled. There is no retry: one round trip, then the file.
2. **The file contract** (one JSON object):

   | Field | Value |
   |---|---|
   | `v` | `1` |
   | `at` | when the hook fired, epoch ms, taken before the POST (`date +%s%N` cut to ms; whole seconds where `%N` is absent) |
   | `session` | the tmux session name |
   | `query` | the route query string, e.g. `kind=tool&session=…` or `provider=codex&tmuxSession=…&generation=…`; empty for a Claude work-state event |
   | `body` | the exact POST body, embedded as JSON; `null` for an empty body |

3. **Replay in the server, through the route's own code.** The route's handler is `dispatchHook({ query, body, replayedAt? })` (`src/lib/hook-dispatch.ts`); the route calls it without `replayedAt`, the drain with the file's `at` (never later than now). The status manager drains at boot after the tab scan and before the first poll, on every poll, and once more after the port file is written. One drain runs at a time. Files are applied oldest first (by the time in the name) and deleted when applied. A file that does not parse, a stray name, or a replay that throws moves to `hook-spool/bad/` with one log line, so it is kept and never retried in a loop. Bound: a file older than 7 days, then the oldest beyond 10 000 files, is dropped unreplayed with one log line.
4. **Order against live events.** The status manager keeps, per tab, the time of the latest applied hook event (a live event's receipt time, a replayed event's `at`, a restored watchdog stop's `at`). That time is not persisted, so a replay window bounds what a new server can trust: an event older than one hour is treated the same way (a spool file that old can predate events a rolled-back server without the spool received live; a long outage is recovered by the poll and `resolveUnknown` from the process and the transcript, as before). A replayed event older than either changes no state: it is recorded in the tab's hook history (`getHookHistory`, the last 32 events, live and replayed, each marked `stale` or not) and nothing else; a Codex or Grok metadata patch returns `stale` and applies nothing. An event that is not older is applied as a live one would be, dated at `at`: `lastEvent.at`, and a replayed stop's `turnEnd.at`, so it is classified normally and may nudge, and the idle clock counts from when the turn really ended.
5. **Pre-install before a restart.** `deploy-live.sh` runs the release's own `scripts/install-hook-scripts.sh --dir ~/.purplemux` after the quiet wait and the backup and before the swap. It renders the release's templates (`src/lib/hook-scripts.ts`) and replaces each script in one rename. The old server keeps answering until it stops: the POST is unchanged and it never reads the spool. A forward deploy without the installer refuses (`HOOK-INSTALL-MISSING`, exit 2); a failed pre-install refuses before the swap (`HOOK-PREINSTALL-FAILED`, exit 1); `--dry-run` renders into a scratch directory; `--rollback` runs the target's installer when it has one and skips the step otherwise.

## Consequences
- A restart through `deploy-live.sh` loses no hook event from a purplemux tab; events that fire while the server is down arrive late, in order, dated when they happened.
- A replayed event is applied at most once per file, but a 5xx after a partial apply can apply twice; the stale check and the turn-end dedupe (a repeated end line is not re-sent) bound the effect.
- Anyone who can write `~/.purplemux/hook-spool/` can inject hook events without the CLI token. That user can already read `~/.purplemux/cli-token`, so the spool adds no new authority.
- A rollback to a release older than this ADR runs scripts that do not spool again once that server starts; spool files written meanwhile wait for the next server that drains.
- Script writes are now atomic everywhere (`writeScriptAtomic`): `sh` reads a script while it runs it, so an in-place rewrite could run half of each version.
