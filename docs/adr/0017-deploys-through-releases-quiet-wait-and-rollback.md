# ADR-0017: Deploys go through releases, a quiet wait, a health gate and rollback

## Status
Accepted (2026-09-26), epic `purplemux-portfolio-coordination`, story 06. Story 13 adds the announce step. Supersedes the deploy half of purplemux-mobile ADR-008.

## Context
A purplemux restart runs under every tab. It drops in-flight hook events, nudge history and kickoffs. On 2026-09-25 the live service ran an unmerged feature worktree through a systemd drop-in, `orchestration/deploy.sh` pulled `main` (wrong for a stacked branch), and three restarts (08:06–08:09Z) were manual `systemctl` calls with no drain, no health gate and no rollback.

## Options
1. **Keep `deploy.sh` and add checks.** It builds in the directory the service runs from, so a failed build or a bad commit breaks the live checkout, and there is no older build to go back to.
2. **Build into a release directory and switch a symlink.** The live service is untouched until the switch; the old build stays on disk as the rollback target.
3. **Two instances behind a proxy (zero downtime).** The server is one process that owns the tmux sessions, the hooks and the SQLite writer; two copies would race on all three.

## Decision
Option 2, as `scripts/deploy-live.sh <ref>`:

1. **Preflight** refuses (exit 2) before any change: the own tab is unknown (`PMUX_TAB_ID` unset and no `--ignore-tab` / `--outside-tab`), the drop-in no longer runs `releases/current`, a first-install drop-in rewrite would not run `releases/current`, the ref is not a commit, or free space is under 5 GiB. Another run that holds the lock refuses with exit 3.
2. **Build** a detached worktree of the primary repository at `~/.purplemux/releases/<sha12>`, then `pnpm install --frozen-lockfile` and `pnpm build`. A build failure removes the new worktree and exits 2.
3. **Lease.** Probe `GET /api/cli/leases` on the running server: 404 = the server predates leases (`LEASE=unavailable`); 200 = acquire `deploy:purplemux` with the admin token through the new release's CLI (exit 3 if another holder has it); anything else exits 1. An error is never read as "predates". A `--rollback` continues past every lease failure except a live holder: the release it escapes may be the one whose lease feature is broken.
4. **Quiet wait**, read-only, every 15 s: proceed after two consecutive polls with no agent tab mid-turn. Mid-turn = `cliState: busy` with a last event other than `stop`; a tab kept busy only by open background work after a stop does not block. The tab in `PMUX_TAB_ID` and each `--ignore-tab` are excluded. Against the b428f4d1 server (no `cliState` in the tab list) the script reads each agent tab's status route and counts every `busy`. On timeout (default 900 s) it lists the mid-turn tabs and exits 3, unless `--force-after-timeout`.
5. **Backup** of `~/.purplemux/*.json` and of `mission-control.sqlite` through the SQLite backup API (the WAL holds most rows) into `~/.purplemux/backups/<stamp>-<sha12>/`, newest 5 kept. The backup runs after the quiet wait, so it holds the state at the restart.
6. **Swap.** `previous` → the old `current`, `current` → the new release, `~/.local/bin/purplemux` → `current/bin/purplemux.js`, restart. **First install** (no `current`): `previous` is seeded with the directory the drop-in runs today, the drop-in and the CLI link target are saved to `releases/first-install-rollback/`, and the drop-in is rewritten to `releases/current` (diff printed, `daemon-reload`).
7. **Health gate** (90 s): `systemctl restart` succeeded; the service has a new `MainPID` whose `/proc/<pid>/cwd` is the release directory (`/api/health` answers the same for every release, so it cannot prove which one runs); `/api/health` answers `app: purplemux`; every tmux session name recorded before the restart still exists (new sessions are allowed); and a workspace-token `tab list` answers. From the first link change until the gate or the rollback ends, INT and TERM are deferred.
8. **Rollback** on a failed restart, `daemon-reload` or gate restores the exact pre-deploy links (on a first install also the saved drop-in and CLI link, and removes `current`/`previous`), restarts, re-checks health and exits 4 with the last 80 journal lines. `--rollback` swaps `current` and `previous` on demand.
9. **Rotation** keeps `current` and `previous` and removes other release worktrees by exact path with `git worktree remove`. Only directories under `releases/` qualify, so the live worktree that `previous` names after a first install is never removed.

## Consequences
- One restart per deploy, drained and health-gated; tmux sessions survive (`KillMode=process`) and the gate proves it by name.
- A rollback swaps code only. It never restores the backup: a newer binary may have written state that the older one reads as unknown fields, and restoring a stale file would lose those writes. The backup is for a manual recovery.
- Rolling back to a build without leases while the engineering bash-guard rules are live blocks merges until `MERGE_LEASE_OK=1` is set fleet-wide or the engineering change is reverted (architecture "Migration strategy").
- The quiet wait is bounded and reports its blockers; the operator decides with `--force-after-timeout`. Story 13's announcement makes quiet arrive sooner.
- The script runs longer than the 10-minute foreground limit of an agent's shell tool; it must run under the host's background mechanism.

## Amendment (story 07, 2026-09-26): an isolated acceptance gate before any switch
Between the build (step 2) and the lease (step 3), the script runs the release's own
`scripts/acceptance/run.sh`: the release on a spare port with a throwaway HOME and tmux socket,
checked end to end for the wave-1 surfaces and ADR-0018 (docs/DEPLOY.md "Acceptance gate"). A failure
refuses with exit 2 before the live service is touched. The restart of a live host touches every
worker tab, so a defect found on a throwaway instance costs nothing that a defect found live does.
