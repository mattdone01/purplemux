#!/usr/bin/env bash
# run.sh — the wave-1 acceptance gate: isolated instance up, checks, down, leak check.
#
#   run.sh --candidate DIR [--log FILE] [--bash-guard PATH] [--require-bash-guard] [--keep]
#
# Exit 0 only when every check passed and nothing leaked onto the live tmux socket; 1 when a check
# failed, a leak was found or the live socket could not be read; 2 when the instance could not be
# started (a refusal; the live service untouched either way). The last line is always
# `ACCEPTANCE=PASS|FAIL|REFUSED ...`.
#
# Teardown runs on every path, a signal included: `up` writes its state file as soon as the server
# starts, and `down` runs whenever that file is non-empty. `up` runs in the background and is waited
# on, so INT/TERM reach this script at once and not only after `up` returns.
#
# Leak check: the live socket (`tmux -L purple` under ACCEPT_LIVE_TMUX_TMPDIR, default
# ${TMUX_TMPDIR:-/tmp}) must hold no session of the isolated workspaces. A session COUNT is not
# compared: agents on the live host open and close tabs while the gate runs. No live tmux server at
# all is a pass that says so; any other read failure is a FAIL, never a silent pass.
#
# deploy-live.sh runs this against the built release directory before it touches the live service.

set -uo pipefail

HERE="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
INSTANCE="${ACCEPT_INSTANCE:-$HERE/isolated-instance.sh}"
CHECKS="${ACCEPT_CHECKS:-$HERE/checks.cjs}"
NODE="${ACCEPT_NODE:-$(command -v node || true)}"
TMUX_BIN="${ACCEPT_TMUX:-tmux}"
LIVE_TMUX_TMPDIR="${ACCEPT_LIVE_TMUX_TMPDIR:-${TMUX_TMPDIR:-/tmp}}"

usage() { echo "usage: run.sh --candidate DIR [--log FILE] [--bash-guard PATH] [--require-bash-guard] [--keep]" >&2; exit 2; }

candidate="" log="" keep=() check_args=()
while (($#)); do
  case "$1" in
    --candidate) candidate="$2"; shift 2 ;;
    --log) log="$2"; shift 2 ;;
    --bash-guard) check_args+=(--bash-guard "$2"); shift 2 ;;
    --require-bash-guard) check_args+=(--require-bash-guard); shift ;;
    --keep) keep=(--keep); shift ;;
    *) usage ;;
  esac
done
[[ -n "$candidate" ]] || usage
[[ -n "$log" ]] || log="$(mktemp "${TMPDIR:-/tmp}/acceptance-XXXXXX.log")"
mkdir -p "$(dirname "$log")"
: >"$log"

say() { echo "$*" | tee -a "$log"; }

state="$(mktemp "${TMPDIR:-/tmp}/acceptance-state-XXXXXX.json")"
child=""
cleanup() {
  # A second signal must not cut the teardown short; children inherit the ignore, so `down` finishes.
  trap '' INT TERM HUP
  [[ -n "$child" ]] && kill "$child" 2>/dev/null && wait "$child" 2>/dev/null
  if [[ -s "$state" ]]; then
    "$INSTANCE" down --state "$state" "${keep[@]}" >>"$log" 2>&1 || say "WARN down failed (see the log)"
  fi
  rm -f "$state"
}
trap cleanup EXIT
trap 'say "ACCEPTANCE=FAIL interrupted log=$log"; exit 1' INT TERM HUP

say "ACCEPTANCE-START $(date -u +%Y-%m-%dT%H:%M:%SZ) candidate=$candidate"
"$INSTANCE" up --candidate "$candidate" --state "$state" >>"$log" 2>&1 &
child=$!
wait "$child"
up_rc=$?
child=""
if ((up_rc != 0)); then
  say "ACCEPTANCE=REFUSED the isolated instance did not start (exit $up_rc) log=$log"
  exit 2
fi
ws_a="$("$NODE" -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).workspaces.a)' "$state")"
ws_b="$("$NODE" -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).workspaces.b)' "$state")"

"$NODE" "$CHECKS" --state "$state" "${check_args[@]}" > >(tee -a "$log") 2>&1 &
child=$!
wait "$child"
checks_rc=$?
child=""

live_ok=0
sessions="$(env -u TMUX TMUX_TMPDIR="$LIVE_TMUX_TMPDIR" "$TMUX_BIN" -L purple ls -F '#{session_name}' 2>"$state.tmux-err")"
tmux_rc=$?
tmux_err="$(cat "$state.tmux-err" 2>/dev/null)"
rm -f "$state.tmux-err"
if ((tmux_rc != 0)) && [[ "$tmux_err" != *"no server running"* ]]; then
  say "FAIL live-socket-untouched — the live tmux socket could not be read — measured: exit $tmux_rc ${tmux_err%%$'\n'*} — expected: a session list (or no server)"
else
  leaked="$(printf '%s\n' "$sessions" | grep -E "^pt-(${ws_a}|${ws_b})-" || true)"
  if [[ -n "$leaked" ]]; then
    say "FAIL live-socket-untouched — isolated sessions reached the live tmux socket — measured: ${leaked//$'\n'/ } — expected: none"
  elif ((tmux_rc != 0)); then
    say "PASS live-socket-untouched — no live tmux server is running, so no session can have reached it"
    live_ok=1
  else
    say "PASS live-socket-untouched — no isolated session among $(printf '%s\n' "$sessions" | grep -c .) live sessions"
    live_ok=1
  fi
fi

if ((checks_rc == 0 && live_ok)); then
  say "ACCEPTANCE=PASS log=$log"
  exit 0
fi
say "ACCEPTANCE=FAIL checks_exit=$checks_rc live_socket=$([[ $live_ok == 1 ]] && echo ok || echo fail) log=$log"
exit 1
