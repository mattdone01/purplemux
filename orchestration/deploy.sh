#!/usr/bin/env bash
# deploy.sh — roll out the purplemux fork on this box WITHOUT touching running agents.
#
# Safe while agents run: tmux sessions (claude/codex tabs) live on their own
# socket (`tmux -L purple`), outside the purplemux server process. Restarting
# the service drops the web UI for a few seconds; agents keep running and the
# UI reattaches. In-memory extras (nudge history, keeper counters, pending
# kickoffs) reset; workspaces, layouts, orchestration config, and session
# history are files in ~/.purplemux and are untouched.
#
# Pulls over https (repo is public-read), so no SSH agent is needed.
set -euo pipefail

cd "$(dirname "$0")/.."
BEFORE=$(tmux -L purple ls 2>/dev/null | wc -l || echo 0)

git pull --ff-only https://github.com/mattdone01/purplemux.git main
pnpm install --frozen-lockfile
pnpm build
systemctl --user restart purplemux.service
sleep 3

systemctl --user is-active purplemux.service
AFTER=$(tmux -L purple ls 2>/dev/null | wc -l || echo 0)
echo "deployed $(git rev-parse --short HEAD) — agent sessions before/after: ${BEFORE}/${AFTER}"
[ "$BEFORE" = "$AFTER" ] || echo "WARNING: session count changed — check tmux -L purple ls"
