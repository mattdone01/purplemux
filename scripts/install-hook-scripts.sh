#!/usr/bin/env bash
# install-hook-scripts.sh — write THIS checkout's hook scripts (status-hook.sh, statusline.sh,
# codex-hook.sh, grok-hook.sh), rendered by its own templates, into a directory.
#
#   install-hook-scripts.sh [--dir DIR]   (default ~/.purplemux)
#
# Prints one `WROTE <path>` or `SAME <path>` line per script. Each script is replaced in one
# rename, so a hook that runs meanwhile reads the old file or the new one, never a mix.
# deploy-live.sh runs it after the quiet wait and before the restart, so hooks that fire while no
# server answers already spool their events for the new server to replay (ADR-0020).

set -euo pipefail

HERE="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
ROOT="$(dirname "$HERE")"
# tsx resolves the `@/` alias from the tsconfig in its working directory.
cd "$ROOT"
exec "$ROOT/node_modules/.bin/tsx" "$HERE/install-hook-scripts.ts" "$@"
