# Deploying purplemux on the live host

`scripts/deploy-live.sh` is the only deploy path. `orchestration/deploy.sh` is superseded. The decision record is [ADR-0017](adr/0017-deploys-through-releases-quiet-wait-and-rollback.md).

## Layout

| Path | Holds |
|---|---|
| `~/.purplemux/releases/<sha12>/` | a detached worktree of `~/code/purplemux`, built |
| `~/.purplemux/releases/current` | symlink to the running release |
| `~/.purplemux/releases/previous` | symlink to the rollback target |
| `~/.purplemux/releases/first-install-rollback/` | the drop-in and CLI link target from before the first release install |
| `~/.purplemux/backups/<stamp>-<sha12>/` | `*.json` stores and `mission-control.sqlite`, newest 5 |
| `~/.purplemux/logs/deploy-live-<stamp>-<sha12>.log` | build output |
| `~/.config/systemd/user/purplemux.service.d/50-mission-control.conf` | runs `releases/current` after the first install |
| `~/.local/bin/purplemux` | symlink to `releases/current/bin/purplemux.js` |

## Run a deploy

The run takes longer than the 10-minute foreground limit of an agent's shell tool. Start it with the host's background mechanism (Claude Code: `run_in_background`) and read the summary when it exits.

```bash
~/code/purplemux/.worktrees/<worktree>/scripts/deploy-live.sh <git-ref>
```

Options:

| Option | Effect |
|---|---|
| `--dry-run` | build and report the quiet state; no backup, no swap, no restart |
| `--quiet-timeout SECONDS` | bound of the quiet wait (default 900) |
| `--force-after-timeout` | deploy even if tabs are still mid-turn at the timeout |
| `--ignore-tab WS/TAB` | exclude one more tab from the quiet wait (repeatable) |
| `--outside-tab` | the shell runs outside every purplemux tab, so there is no own tab to exclude |
| `--rollback` | swap `current` and `previous`, restart, health-check |

The tab in `PMUX_TAB_ID` is always excluded from the quiet wait. A tab created before story 01 has no `PMUX_TAB_ID`; the script then refuses with `REFUSED OWN-TAB-UNKNOWN` until you name your own tab with `--ignore-tab <ws>/<tab>` (or pass `--outside-tab` from a plain shell).

## Exit codes

| Exit | Meaning | Live service |
|---|---|---|
| 0 | deployed, rolled back on demand, or dry run | new release (or unchanged on dry run) |
| 1 | lease probe or acquire failed, backup failed, tmux sessions unreadable | unchanged |
| 2 | refused: usage, ref, disk, build, own tab unknown, drop-in drift or rewrite, half-finished first install, rollback target missing or unbuilt | unchanged |
| 3 | quiet timeout, deploy lease held, another deploy running | unchanged |
| 4 | restart, `daemon-reload` or health gate failed; the previous release was restored (`VERDICT=rolled-back`), or an on-demand rollback failed its gate (`VERDICT=rollback-unhealthy`) | previous release |

The last lines are one summary block: `RELEASE=`, `PREVIOUS=`, `SESSIONS=kept/before`, `HEALTH=`, `ROLLBACK_HEALTH=` (after a rollback), `QUIET=`, `LEASE=`, `BACKUP=`, `INTERRUPTED=` (when a signal arrived in the swap window), `VERDICT=`.

## Health gate

Within 90 s after the restart, all of these must hold:

1. `systemctl --user restart` exited 0.
2. The service has a new `MainPID`, and `/proc/<pid>/cwd` resolves to the release directory. `/api/health` answers the same for every release, so this check is what proves the new code runs.
3. `GET /api/health` answers `app: purplemux`.
4. Every tmux session name recorded before the restart still exists. New sessions are allowed.
5. A workspace-token `purplemux tab list` answers. With no workspace token on the host the check is reported as skipped (`HEALTH=pass (tab-list skipped: no workspace token)`).

From the first link change until the gate or the rollback ends, the script defers INT and TERM. A `SIGKILL` in that window can still leave the links swapped; run `--rollback` or check `releases/current` by hand.

## The first install

The first run finds no `releases/current`. It then:

1. links `releases/previous` to the directory the drop-in runs today (`.worktrees/mission-control-human-escalation` on 2026-09-26);
2. saves the drop-in and the `~/.local/bin/purplemux` target to `releases/first-install-rollback/`;
3. rewrites the drop-in to `releases/current` and prints the diff;
4. runs `systemctl --user daemon-reload` before the restart.

The first wave-1 deploy runs against the b428f4d1 server: `LEASE=unavailable (server predates leases)` is expected, and the quiet wait reads each agent tab's status route because that tab list has no `cliState`.

## Roll back

- Automatic: a failed health gate restores the links from before the run and exits 4. The summary and the journal lines show why.
- On demand: `scripts/deploy-live.sh --rollback` from `releases/current/scripts/`. Right after a first install it restores the saved drop-in and CLI link and removes `current` and `previous`. It continues past a broken lease route or lease CLI (`LEASE=unavailable (…; rollback proceeds)`); only a live `deploy:purplemux` holder elsewhere stops it.
- A rollback swaps code only and never restores a backup. Restore a backup by hand only with the service stopped.
- **bash-guard coupling.** Rolling back to a build without leases while the engineering bash-guard lease rules are live makes every merge fail closed. Set `MERGE_LEASE_OK=1` for the orchestrator (fleet-wide if needed) or revert the engineering change until a lease-capable release runs again.

## Old releases

Each successful deploy keeps `current` and `previous` and removes other release worktrees under `releases/` by exact path (`git worktree remove`). A directory under `releases/` that is not a worktree of the primary repository is reported as `PRUNE-SKIPPED` and left alone. The live worktree that `previous` names after a first install is outside `releases/` and is never removed.

## Testing

`tests/unit/scripts/deploy-live.test.ts` runs the script against fake `systemctl`, `pnpm`, `curl`, `tmux`, `purplemux` and `journalctl` binaries (`DEPLOY_*` overrides), a temporary `HOME` and a real git repository. It never reaches the live service.
