#!/usr/bin/env bash
# isolated-instance.sh — run a candidate purplemux build beside the live service, sharing nothing.
#
#   isolated-instance.sh up --candidate DIR --state FILE [--port N]
#   isolated-instance.sh down --state FILE [--keep]
#
# `up` starts DIR's server (`tsx server.ts`, NODE_ENV=production — the way the service runs it) with:
#   * HOME=<scratch>/home, so ~/.purplemux (tokens, leases, workspaces, the lock) is throwaway;
#   * TMUX_TMPDIR=<scratch>/tmux, so `tmux -L purple` is a socket of its own;
#   * HOST=localhost and a free port >= 18000;
#   * `env -i` plus a short whitelist: a shell inside a live tab carries PMUX_TOKEN, TMUX and the
#     live __PMUX_PRISTINE_ENV, and the candidate would hand those to its own tabs, whose CLI calls
#     would then reach the LIVE server. After the start it reads the server processes' environ and
#     refuses (NOT-ISOLATED) if any live key got through.
# It refuses (exit 2) before starting anything when the candidate is not built, when the scratch HOME
# or socket directory would resolve to the live ones, when the socket path is over the unix limit,
# or when the port is the live one or answers. It writes FILE (JSON) as soon as the server starts, so
# a caller can always tear it down; and any failure after the start tears it down itself.
#
# `down` stops every process whose /proc environ carries the scratch HOME (the server's process
# group first), kills the scratch tmux server only through the scratch socket, and removes the scratch
# directory (unless --keep). It never signals a process started with any other HOME.
#
# Injectable for tests: ACCEPT_NODE, ACCEPT_CURL, ACCEPT_TMUX, ACCEPT_TSX (the server launcher,
# default <candidate>/node_modules/.bin/tsx), ACCEPT_PROC_ROOT (/proc), ACCEPT_SCRATCH_PARENT (/tmp),
# ACCEPT_LIVE_TMUX_TMPDIR (${TMUX_TMPDIR:-/tmp}), ACCEPT_START_TIMEOUT_S (90).

set -uo pipefail

NODE="${ACCEPT_NODE:-$(command -v node || true)}"
CURL="${ACCEPT_CURL:-curl}"
TMUX_BIN="${ACCEPT_TMUX:-tmux}"
PROC_ROOT="${ACCEPT_PROC_ROOT:-/proc}"
SCRATCH_PARENT="${ACCEPT_SCRATCH_PARENT:-/tmp}"
LIVE_TMUX_TMPDIR="${ACCEPT_LIVE_TMUX_TMPDIR:-${TMUX_TMPDIR:-/tmp}}"
START_TIMEOUT_S="${ACCEPT_START_TIMEOUT_S:-90}"
SOCKET_MAX=100
# Keys that must never reach the candidate: each points a process at the LIVE service.
LIVE_KEYS=(PMUX_TOKEN PMUX_TAB_TOKEN PMUX_TAB_ID PMUX_WORKSPACE_ID PMUX_PORT TMUX TMUX_PANE CLAUDE_CONFIG_DIR GROK_HOME)

usage() {
  echo "usage: isolated-instance.sh up --candidate DIR --state FILE [--port N]" >&2
  echo "       isolated-instance.sh down --state FILE [--keep]" >&2
  exit 2
}

say_refusal() {
  echo "REFUSED $1" >&2
  echo "  measured: $2" >&2
  echo "  expected: $3" >&2
}

json_field() {
  "$NODE" -e 'try{const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=s[process.argv[2]];process.stdout.write(v==null?"":String(v))}catch{}' "$1" "$2"
}

# One environ variable of a running process, from /proc; empty when unreadable or absent.
proc_env() { tr '\0' '\n' 2>/dev/null <"$PROC_ROOT/$1/environ" | sed -n "s/^$2=//p" | head -n 1; }
proc_has() { tr '\0' '\n' 2>/dev/null <"$PROC_ROOT/$1/environ" | grep -q "^$2="; }
proc_home() { proc_env "$1" HOME; }

port_answers() { "$CURL" -s -m 2 -o /dev/null "http://127.0.0.1:$1/" 2>/dev/null; }

realdir() { (cd "$1" 2>/dev/null && pwd -P); }

# Every pid whose environ carries exactly HOME=$1: one grep over every environ (NUL-separated),
# never a fork per process — the live host runs thousands.
pids_with_home() {
  grep -l -z -x -F "HOME=$1" "$PROC_ROOT"/[0-9]*/environ 2>/dev/null | sed -e "s#^$PROC_ROOT/##" -e 's#/environ$##'
}

# Stop everything that runs with the scratch HOME, then the scratch tmux server. Signals only pids
# whose environ proves they are ours; a process group is signalled only when its leader is ours.
teardown() {
  local home="$1" tmuxdir="$2" p pgid round
  for round in TERM TERM TERM TERM TERM KILL; do
    local ours=()
    mapfile -t ours < <(pids_with_home "$home")
    ((${#ours[@]})) || break
    for p in "${ours[@]}"; do
      pgid="$(ps -o pgid= -p "$p" 2>/dev/null | tr -d ' ')"
      if [[ -n "$pgid" && "$pgid" == "$p" ]]; then
        kill "-$round" -- "-$p" 2>/dev/null || true
      else
        kill "-$round" "$p" 2>/dev/null || true
      fi
    done
    sleep 1
  done
  local sock="$tmuxdir/tmux-$(id -u)/purple"
  if [[ -S "$sock" ]]; then
    env -u TMUX TMUX_TMPDIR="$tmuxdir" "$TMUX_BIN" -L purple kill-server 2>/dev/null || true
  fi
  local left=()
  mapfile -t left < <(pids_with_home "$home")
  ((${#left[@]} == 0)) || echo "WARN still running with the scratch HOME: ${left[*]}" >&2
}

up() {
  local candidate="" state="" port=""
  while (($#)); do
    case "$1" in
      --candidate) candidate="$2"; shift 2 ;;
      --state) state="$2"; shift 2 ;;
      --port) port="$2"; shift 2 ;;
      *) usage ;;
    esac
  done
  [[ -n "$candidate" && -n "$state" ]] || usage
  [[ -n "$NODE" && -x "$NODE" ]] || { say_refusal NODE-MISSING "node=${NODE:-<none>}" "an executable node (ACCEPT_NODE or PATH)"; exit 2; }
  candidate="$(realdir "$candidate")" || { say_refusal CANDIDATE-UNBUILT "no directory" "a built candidate"; exit 2; }
  local f
  for f in server.ts bin/purplemux.js node_modules/.bin/tsx .next/BUILD_ID; do
    [[ -e "$candidate/$f" ]] || { say_refusal CANDIDATE-UNBUILT "no $candidate/$f" "a built candidate (pnpm install && pnpm build)"; exit 2; }
  done
  local tsx="${ACCEPT_TSX:-$candidate/node_modules/.bin/tsx}"

  local scratch
  scratch="$(mktemp -d "$SCRATCH_PARENT/pmxa.XXXXXX")" || { say_refusal SCRATCH "mktemp failed under $SCRATCH_PARENT" "a scratch directory"; exit 2; }
  local home="$scratch/home" tmuxdir="$scratch/tmux"
  local sock="$tmuxdir/tmux-$(id -u)/purple"
  local started_pid="" ok=0

  # From here every exit that is not success tears down what exists and removes the scratch dir.
  on_exit() {
    local rc=$?
    trap '' INT TERM HUP
    ((ok)) && return
    if [[ -n "$started_pid" ]]; then
      [[ -f "$scratch/server.log" ]] && { echo "---- candidate server.log (tail) ----" >&2; tail -n 20 "$scratch/server.log" >&2; }
      teardown "$home" "$tmuxdir"
    fi
    rm -rf "$scratch"
    : >"$state" 2>/dev/null || true
    exit "$((rc == 0 ? 2 : rc))"
  }
  trap on_exit EXIT
  trap 'exit 130' INT TERM HUP

  mkdir -p "$home/.claude" "$tmuxdir" "$scratch/work/a" "$scratch/work/b" "$scratch/bin"
  # A stand-in `claude` for the story 15 checks: `claude --resume <uuid>` is how purplemux finds a
  # tab's transcript, and it answers --version so agent tabs pass the availability check. The real
  # CLI never runs in the isolated instance.
  printf '#!/bin/sh\n[ "$1" = --version ] && { echo "2.1.283 (Claude Code, acceptance stand-in)"; exit 0; }\nsleep 3600\n' >"$scratch/bin/claude"
  chmod +x "$scratch/bin/claude"

  local live_home live_sock_dir
  live_home="$(realdir "$HOME" || echo "$HOME")"
  live_sock_dir="$(realdir "$LIVE_TMUX_TMPDIR" || echo "$LIVE_TMUX_TMPDIR")/tmux-$(id -u)"
  [[ "$(realdir "$home")" != "$live_home" ]] || { say_refusal LIVE-HOME "scratch HOME resolves to $live_home" "a HOME other than the live one"; exit 2; }
  [[ "$(realdir "$tmuxdir")/tmux-$(id -u)" != "$live_sock_dir" ]] || { say_refusal LIVE-SOCKET "scratch socket dir resolves to $live_sock_dir" "a tmux socket directory other than the live one"; exit 2; }
  ((${#sock} <= SOCKET_MAX)) || { say_refusal SOCKET-PATH-LONG "$sock is ${#sock} bytes" "at most $SOCKET_MAX (the unix socket limit is 108)"; exit 2; }

  local live_port=""
  live_port="$(head -n 1 "$HOME/.purplemux/port" 2>/dev/null || true)"
  if [[ -n "$port" ]]; then
    [[ "$port" != "$live_port" ]] || { say_refusal LIVE-PORT "port $port is the live service's" "a spare port"; exit 2; }
    ! port_answers "$port" || { say_refusal PORT-BUSY "127.0.0.1:$port answers" "a free port"; exit 2; }
  else
    local tries=0
    while :; do
      port=$((18000 + RANDOM % 1000))
      [[ "$port" != "$live_port" ]] && ! port_answers "$port" && break
      ((++tries < 50)) || { say_refusal NO-FREE-PORT "50 ports in 18000-18999 answered" "a free port"; exit 2; }
    done
  fi

  (
    cd "$candidate" || exit 1
    exec setsid env -i \
      PATH="$scratch/bin:$(dirname "$NODE"):/usr/local/bin:/usr/bin:/bin" \
      HOME="$home" TMUX_TMPDIR="$tmuxdir" PORT="$port" HOST=localhost NODE_ENV=production \
      LANG="${LANG:-C.UTF-8}" TERM=xterm-256color USER="${USER:-$(id -un)}" SHELL=/bin/bash \
      "$tsx" server.ts
  ) >"$scratch/server.log" 2>&1 </dev/null 9>&- &
  started_pid=$!
  write_state() {
    "$NODE" -e 'const [f,...v]=process.argv.slice(1);const k=["scratch","home","tmuxTmpdir","candidate","node","port","pid","lockPid","wsA","wsB"];const o={};k.forEach((x,i)=>o[x]=v[i]||null);const s={scratch:o.scratch,home:o.home,tmuxTmpdir:o.tmuxTmpdir,candidate:o.candidate,node:o.node,port:Number(o.port),pid:Number(o.pid),lockPid:Number(o.lockPid)||null,workspaces:o.wsA?{a:o.wsA,b:o.wsB}:null};require("fs").writeFileSync(f,JSON.stringify(s,null,2)+"\n");' \
      "$state" "$scratch" "$home" "$tmuxdir" "$candidate" "$NODE" "$1" "$started_pid" "${2:-}" "${3:-}" "${4:-}"
  }
  write_state "$port"

  local waited=0 actual=""
  while ((waited < START_TIMEOUT_S)); do
    actual="$(head -n 1 "$home/.purplemux/port" 2>/dev/null || true)"
    if [[ -n "$actual" ]] && "$CURL" -s -m 2 "http://127.0.0.1:$actual/api/health" 2>/dev/null | grep -q '"app":"purplemux"'; then
      break
    fi
    kill -0 "$started_pid" 2>/dev/null || { say_refusal START-FAILED "the candidate server exited (log $scratch/server.log)" "a running candidate"; exit 2; }
    sleep 1
    waited=$((waited + 1))
  done
  ((waited < START_TIMEOUT_S)) || { say_refusal START-TIMEOUT "no health answer within ${START_TIMEOUT_S}s" "GET /api/health app=purplemux"; exit 2; }
  [[ "$actual" != "$live_port" ]] || { say_refusal LIVE-PORT "the candidate fell back to the live port $actual" "a spare port"; exit 2; }

  local lock_pid
  lock_pid="$("$NODE" -e 'try{process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).pid))}catch{}' "$home/.purplemux/pmux.lock")"
  write_state "$actual" "$lock_pid"
  local p key
  for p in "$started_pid" "$lock_pid"; do
    [[ -n "$p" && "$(proc_home "$p")" == "$home" ]] \
      || { say_refusal NOT-ISOLATED "pid ${p:-?} runs with HOME=$(proc_home "${p:-0}")" "HOME=$home"; exit 2; }
    for key in "${LIVE_KEYS[@]}"; do
      ! proc_has "$p" "$key" || { say_refusal NOT-ISOLATED "pid $p carries $key" "none of: ${LIVE_KEYS[*]}"; exit 2; }
    done
    # The server's own children carry the pristine env it captured; it must be the scratch one.
    if proc_has "$p" __PMUX_PRISTINE_ENV; then
      local pristine_home
      pristine_home="$(proc_env "$p" __PMUX_PRISTINE_ENV | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).HOME||"<no HOME>")}catch{process.stdout.write("<unparseable>")}})')"
      [[ "$pristine_home" == "$home" ]] \
        || { say_refusal NOT-ISOLATED "pid $p carries a pristine env with HOME=$pristine_home" "none, or HOME=$home"; exit 2; }
    fi
  done

  local token ws_a ws_b
  token="$(head -n 1 "$home/.purplemux/cli-token" 2>/dev/null || true)"
  [[ -n "$token" ]] || { say_refusal NO-TOKEN "no $home/.purplemux/cli-token" "the candidate's admin token"; exit 2; }
  create_ws() {
    "$CURL" -s -m 20 -X POST -H "X-Pmux-Token: $token" -H 'Content-Type: application/json' \
      -d "{\"directory\":\"$scratch/work/$1\",\"name\":\"acc-$1\"}" "http://127.0.0.1:$actual/api/workspace" 2>/dev/null \
      | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).id||"")}catch{}})'
  }
  ws_a="$(create_ws a || true)"
  ws_b="$(create_ws b || true)"
  [[ -n "$ws_a" && -n "$ws_b" ]] || { say_refusal WORKSPACES "workspace ids a=${ws_a:-<none>} b=${ws_b:-<none>}" "two workspaces created"; exit 2; }

  write_state "$actual" "$lock_pid" "$ws_a" "$ws_b"
  ok=1
  trap - EXIT INT TERM HUP
  echo "ISOLATED scratch=$scratch port=$actual pid=$started_pid server=$lock_pid workspaces=$ws_a,$ws_b"
}

down() {
  local state="" keep=0
  while (($#)); do
    case "$1" in
      --state) state="$2"; shift 2 ;;
      --keep) keep=1; shift ;;
      *) usage ;;
    esac
  done
  [[ -s "$state" ]] || { echo "NOTHING-TO-DO no state in ${state:-<none>}"; return 0; }
  local scratch home tmuxdir parent
  scratch="$(json_field "$state" scratch)"
  home="$(json_field "$state" home)"
  tmuxdir="$(json_field "$state" tmuxTmpdir)"
  parent="$(realdir "$SCRATCH_PARENT" || echo "$SCRATCH_PARENT")"
  # Resolved, not string-matched: `pmxa.X/../x` must not pass.
  if [[ ! "${scratch##*/}" =~ ^pmxa\.[A-Za-z0-9]{6}$ || "$(realdir "$(dirname "$scratch")" || echo "?")" != "$parent" \
    || "$home" != "$scratch/home" || "$tmuxdir" != "$scratch/tmux" ]]; then
    say_refusal STATE "scratch=$scratch home=$home tmux=$tmuxdir" "a directory $parent/pmxa.XXXXXX with home/ and tmux/"
    exit 2
  fi
  teardown "$home" "$tmuxdir"
  if ((keep)); then
    echo "KEPT $scratch"
  else
    rm -rf "$scratch"
    echo "REMOVED $scratch"
  fi
}

cmd="${1:-}"
shift || true
case "$cmd" in
  up) up "$@" ;;
  down) down "$@" ;;
  *) usage ;;
esac
