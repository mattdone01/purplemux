#!/usr/bin/env bash
# pmux-board — one-glance status board for purplemux agent tabs.
#
# Shows every tab's cliState plus the last non-blank line of its pane, so you
# can see at a terminal what each agent is actually doing without opening the UI.
#
# Usage:
#   pmux-board.sh [-w WS_ID]        one shot (all workspaces if -w omitted)
#   watch -n 5 pmux-board.sh -w WS  live board
# Requires: jq, curl, a running purplemux.
set -u

WS=""
while getopts "w:" opt; do case "$opt" in w) WS="$OPTARG" ;; *) exit 2 ;; esac; done
command -v jq >/dev/null || { echo "pmux-board: jq is required" >&2; exit 1; }

PORT=$(cat "$HOME/.purplemux/port") || exit 1
TOKEN=$(cat "$HOME/.purplemux/cli-token") || exit 1
API="http://localhost:${PORT}/api/cli"
Q=""; [ -n "$WS" ] && Q="?workspaceId=${WS}"

printf '%-12s %-11s %-22s %-16s %s\n' "TAB" "TYPE" "NAME" "STATE" "LAST PANE LINE"
printf '%-12s %-11s %-22s %-16s %s\n' "---" "----" "----" "-----" "--------------"

curl -s -H "x-pmux-token: $TOKEN" "${API}/tabs${Q}" |
  jq -r '.tabs[] | [.tabId,.workspaceId,.panelType,.name] | @tsv' |
while IFS=$'\t' read -r TAB TWS TYPE NAME; do
  S=$(curl -s -H "x-pmux-token: $TOKEN" "${API}/tabs/${TAB}/status?workspaceId=${TWS}")
  STATE=$(jq -r '.cliState // "-"' <<<"$S")
  ALIVE=$(jq -r '.alive' <<<"$S")
  [ "$ALIVE" = "true" ] || STATE="dead"
  LAST=""
  if [ "$TYPE" = "claude-code" ] || [ "$TYPE" = "codex-cli" ] || [ "$TYPE" = "terminal" ]; then
    LAST=$(curl -s -H "x-pmux-token: $TOKEN" "${API}/tabs/${TAB}/result?workspaceId=${TWS}" |
      jq -r '.content // ""' | grep -v '^[[:space:]]*$' | tail -1 | cut -c1-90)
  fi
  printf '%-12s %-11s %-22s %-16s %s\n' "$TAB" "$TYPE" "${NAME:0:22}" "$STATE" "$LAST"
done
