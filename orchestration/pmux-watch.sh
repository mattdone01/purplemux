#!/usr/bin/env bash
# pmux-watch — deterministic babysitter for a purplemux agent workspace.
#
# Polls every claude-code / codex-cli tab in a workspace and, on any state
# change that needs attention, sends a one-line nudge INTO the orchestrator
# tab (which starts a new turn for it). This breaks every deadlock class:
#   - worker hits needs-input while orchestrator is idle  -> orchestrator woken
#   - worker finishes (ready-for-review) and nobody looks  -> orchestrator woken
#   - worker dies / tab exits                              -> orchestrator woken
#   - worker sits "busy" too long (default 10 min)         -> orchestrator woken
#
# Usage:
#   pmux-watch.sh -w WS_ID -o ORCH_TAB_ID [-i POLL_SECS] [-s STUCK_SECS]
#
# Run it in a plain terminal tab in the same workspace (or under systemd).
# Requires: jq, curl, a running purplemux (reads ~/.purplemux/{port,cli-token}).
set -u

WS="" ORCH="" INTERVAL=20 STUCK=600
while getopts "w:o:i:s:" opt; do
  case "$opt" in
    w) WS="$OPTARG" ;;
    o) ORCH="$OPTARG" ;;
    i) INTERVAL="$OPTARG" ;;
    s) STUCK="$OPTARG" ;;
    *) exit 2 ;;
  esac
done
[ -n "$WS" ] && [ -n "$ORCH" ] || { echo "usage: $0 -w WS_ID -o ORCH_TAB_ID [-i secs] [-s stuck_secs]" >&2; exit 2; }
command -v jq >/dev/null || { echo "pmux-watch: jq is required" >&2; exit 1; }

PORT=$(cat "$HOME/.purplemux/port") || exit 1
TOKEN=$(cat "$HOME/.purplemux/cli-token") || exit 1
API="http://localhost:${PORT}/api/cli"

STATE_DIR="${TMPDIR:-/tmp}/pmux-watch-${WS}"
mkdir -p "$STATE_DIR"

log() { printf '%s %s\n' "$(date '+%H:%M:%S')" "$*"; }

nudge() {
  # $1 = message. Lands as a new user turn in the orchestrator tab.
  jq -n --arg c "[pmux-watch] $1" '{content:$c}' |
    curl -s -o /dev/null -X POST -H "x-pmux-token: $TOKEN" -H 'Content-Type: application/json' \
      --data-binary @- "${API}/tabs/${ORCH}/send?workspaceId=${WS}"
  log "NUDGE -> orchestrator: $1"
}

log "watching workspace=$WS orchestrator=$ORCH every ${INTERVAL}s (stuck after ${STUCK}s)"

while :; do
  NOW=$(date +%s)
  TABS=$(curl -s -H "x-pmux-token: $TOKEN" "${API}/tabs?workspaceId=${WS}" |
    jq -r '.tabs[] | select(.panelType=="claude-code" or .panelType=="codex-cli") | [.tabId,.name] | @tsv') || TABS=""

  while IFS=$'\t' read -r TAB NAME; do
    [ -z "$TAB" ] && continue
    [ "$TAB" = "$ORCH" ] && continue

    S=$(curl -s -H "x-pmux-token: $TOKEN" "${API}/tabs/${TAB}/status?workspaceId=${WS}")
    STATE=$(jq -r '.cliState // "unknown"' <<<"$S")
    ALIVE=$(jq -r '.alive' <<<"$S")
    [ "$ALIVE" = "true" ] || STATE="dead"

    F="$STATE_DIR/$TAB"
    PREV=$(cat "$F" 2>/dev/null || echo "")

    if [ "$STATE" != "$PREV" ]; then
      echo "$STATE" > "$F"
      echo "$NOW" > "$F.since"
      rm -f "$F.alerted"
      log "$TAB ($NAME): ${PREV:-new} -> $STATE"
      case "$STATE" in
        needs-input)
          nudge "worker $TAB ($NAME) NEEDS INPUT. Capture it with: purplemux tab result -w $WS $TAB — then answer via tab send." ;;
        ready-for-review)
          nudge "worker $TAB ($NAME) is READY FOR REVIEW. Capture output, verify, then accept or send follow-up work." ;;
        idle)
          # busy -> idle without ready-for-review also means the turn ended
          [ "$PREV" = "busy" ] && nudge "worker $TAB ($NAME) finished its turn (busy -> idle). Capture output, verify, then accept or send follow-up work." ;;
        dead|inactive)
          nudge "worker $TAB ($NAME) is $STATE (process gone or CLI exited). Decide: respawn the tab or mark its story blocked." ;;
      esac
    elif [ "$STATE" = "busy" ] || [ "$STATE" = "unknown" ]; then
      SINCE=$(cat "$F.since" 2>/dev/null || echo "$NOW")
      if [ $((NOW - SINCE)) -ge "$STUCK" ] && [ ! -f "$F.alerted" ]; then
        touch "$F.alerted"
        nudge "worker $TAB ($NAME) has been '$STATE' for over $((STUCK/60)) min with no state change — possibly stalled. Capture the pane (tab result) and decide: keep waiting, interrupt+re-prompt, or kill+respawn."
      fi
    fi
  done <<<"$TABS"

  sleep "$INTERVAL"
done
