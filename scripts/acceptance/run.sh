#!/usr/bin/env bash
# run.sh — the wave-1 acceptance gate: isolated instance up, checks, down, leak check.
#
#   run.sh --candidate DIR [--log FILE] [--bash-guard PATH] [--require-bash-guard] [--keep]
#
# Exit 0 only when every check passed and nothing leaked onto the live tmux socket; 1 when a check
# failed or a leak was found; 2 when the instance could not be started (a refusal, the live service
# untouched either way). The last line is always `ACCEPTANCE=PASS|FAIL|REFUSED ...`.
#
# Leak check: the live socket (`tmux -L purple` under ACCEPT_LIVE_TMUX_TMPDIR, default
# ${TMUX_TMPDIR:-/tmp}) must hold no session of the isolated workspaces. A session COUNT is not
# compared: agents on the live host open and close tabs while the gate runs.
#
# deploy-live.sh runs this against the built release directory before it touches the live service.

set -uo pipefail

HERE="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
INSTANCE="${ACCEPT_INSTANCE:-$HERE/isolated-instance.sh}"
CHECKS="${ACCEPT_CHECKS:-$HERE/checks.cjs}"
NODE="${ACCEPT_NODE:-$(command -v node || true)}"
TMUX_BIN="${ACCEPT_TMUX:-tmux}"
LIVE_TMUX_TMPDIR="${ACCEPT_LIVE_TMUX_TMPDIR:-${TMUX_TMPDIR:-/tmp}}"

candidate="" log="" keep=() check_args=()
while (($#)); do
  case "$1" in
    --candidate) candidate="$2"; shift 2 ;;
    --log) log="$2"; shift 2 ;;
    --bash-guard) check_args+=(--bash-guard "$2"); shift 2 ;;
    --require-bash-guard) check_args+=(--require-bash-guard); shift ;;
    --keep) keep=(--keep); shift ;;
    *) echo "usage: run.sh --candidate DIR [--log FILE] [--bash-guard PATH] [--require-bash-guard] [--keep]" >&2; exit 2 ;;
  esac
done
[[ -n "$candidate" ]] || { echo "usage: run.sh --candidate DIR [--log FILE] ..." >&2; exit 2; }
[[ -n "$log" ]] || log="$(mktemp "${TMPDIR:-/tmp}/acceptance-XXXXXX.log")"
mkdir -p "$(dirname "$log")"
: >"$log"

say() { echo "$*" | tee -a "$log"; }

state="$(mktemp "${TMPDIR:-/tmp}/acceptance-state-XXXXXX.json")"
started=0
cleanup() {
  if ((started)); then
    "$INSTANCE" down --state "$state" "${keep[@]}" >>"$log" 2>&1 || say "WARN down failed (see the log)"
  fi
  rm -f "$state"
}
trap cleanup EXIT
trap 'say "ACCEPTANCE=FAIL interrupted log=$log"; exit 1' INT TERM

say "ACCEPTANCE-START $(date -u +%Y-%m-%dT%H:%M:%SZ) candidate=$candidate"
if ! "$INSTANCE" up --candidate "$candidate" --state "$state" >>"$log" 2>&1; then
  say "ACCEPTANCE=REFUSED the isolated instance did not start log=$log"
  exit 2
fi
started=1
ws_a="$("$NODE" -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).workspaces.a)' "$state")"
ws_b="$("$NODE" -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).workspaces.b)' "$state")"

"$NODE" "$CHECKS" --state "$state" "${check_args[@]}" 2>&1 | tee -a "$log"
checks_rc=${PIPESTATUS[0]}

leaked="$(env -u TMUX TMUX_TMPDIR="$LIVE_TMUX_TMPDIR" "$TMUX_BIN" -L purple ls -F '#{session_name}' 2>/dev/null \
  | grep -E "^pt-(${ws_a}|${ws_b})-" || true)"
if [[ -n "$leaked" ]]; then
  say "FAIL live-socket-untouched — isolated sessions reached the live tmux socket — measured: ${leaked//$'\n'/ } — expected: none"
else
  say "PASS live-socket-untouched — no isolated session on the live tmux socket"
fi

if ((checks_rc == 0)) && [[ -z "$leaked" ]]; then
  say "ACCEPTANCE=PASS log=$log"
  exit 0
fi
say "ACCEPTANCE=FAIL checks_exit=$checks_rc leaked=$([[ -n "$leaked" ]] && echo yes || echo no) log=$log"
exit 1
