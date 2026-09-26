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
#     would then reach the LIVE server.
# It refuses (exit 2) before starting anything when the candidate is not built, when the scratch HOME
# or socket directory would resolve to the live ones, when the socket path is over the unix limit,
# or when the port answers. Then it creates two workspaces and writes FILE (JSON) for checks.cjs.
#
# `down` stops only processes whose /proc environ carries the scratch HOME, kills the scratch tmux
# server only through the scratch socket, and removes the scratch directory (unless --keep).
#
# Injectable for tests: ACCEPT_NODE, ACCEPT_CURL, ACCEPT_TMUX, ACCEPT_PROC_ROOT (/proc),
# ACCEPT_SCRATCH_PARENT (/tmp), ACCEPT_LIVE_TMUX_TMPDIR (${TMUX_TMPDIR:-/tmp}),
# ACCEPT_START_TIMEOUT_S (90).

set -euo pipefail

NODE="${ACCEPT_NODE:-$(command -v node || true)}"
CURL="${ACCEPT_CURL:-curl}"
TMUX_BIN="${ACCEPT_TMUX:-tmux}"
PROC_ROOT="${ACCEPT_PROC_ROOT:-/proc}"
SCRATCH_PARENT="${ACCEPT_SCRATCH_PARENT:-/tmp}"
LIVE_TMUX_TMPDIR="${ACCEPT_LIVE_TMUX_TMPDIR:-${TMUX_TMPDIR:-/tmp}}"
START_TIMEOUT_S="${ACCEPT_START_TIMEOUT_S:-90}"
SOCKET_MAX=100

refuse() {
  echo "REFUSED $1" >&2
  echo "  measured: $2" >&2
  echo "  expected: $3" >&2
  exit 2
}

usage() {
  echo "usage: isolated-instance.sh up --candidate DIR --state FILE [--port N]" >&2
  echo "       isolated-instance.sh down --state FILE [--keep]" >&2
  exit 2
}

json_field() { "$NODE" -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=s[process.argv[2]];process.stdout.write(v==null?"":String(v));' "$1" "$2"; }

# The HOME a running process was started with, from its environ; empty when unreadable.
proc_home() { tr '\0' '\n' <"$PROC_ROOT/$1/environ" 2>/dev/null | sed -n 's/^HOME=//p' | head -n 1; }

port_answers() { "$CURL" -s -m 2 -o /dev/null "http://127.0.0.1:$1/" 2>/dev/null; }

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
  [[ -n "$NODE" && -x "$NODE" ]] || refuse NODE-MISSING "node=${NODE:-<none>}" "an executable node (ACCEPT_NODE or PATH)"
  candidate="$(cd "$candidate" && pwd -P)"
  for f in server.ts bin/purplemux.js node_modules/.bin/tsx .next/BUILD_ID; do
    [[ -e "$candidate/$f" ]] || refuse CANDIDATE-UNBUILT "no $candidate/$f" "a built candidate (pnpm install && pnpm build)"
  done

  local scratch
  scratch="$(mktemp -d "$SCRATCH_PARENT/pmxa.XXXXXX")"
  mkdir -p "$scratch/home/.claude" "$scratch/tmux" "$scratch/work/a" "$scratch/work/b" "$scratch/bin"
  # A stand-in `claude` for the story 15 checks: `claude --resume <uuid>` is how purplemux finds a
  # tab's transcript, and it answers --version so agent tabs pass the availability check. The real
  # CLI never runs in the isolated instance.
  printf '#!/bin/sh\n[ "$1" = --version ] && { echo "2.1.283 (Claude Code, acceptance stand-in)"; exit 0; }\nsleep 3600\n' >"$scratch/bin/claude"
  chmod +x "$scratch/bin/claude"
  local home="$scratch/home" tmuxdir="$scratch/tmux"
  local sock="$tmuxdir/tmux-$(id -u)/purple"
  local live_home live_sock_dir
  live_home="$(cd "$HOME" && pwd -P)"
  live_sock_dir="$(cd "$LIVE_TMUX_TMPDIR" 2>/dev/null && pwd -P || echo "$LIVE_TMUX_TMPDIR")/tmux-$(id -u)"
  [[ "$(cd "$home" && pwd -P)" != "$live_home" ]] || { rm -rf "$scratch"; refuse LIVE-HOME "scratch HOME resolves to $live_home" "a HOME other than the live one"; }
  [[ "$(cd "$tmuxdir" && pwd -P)/tmux-$(id -u)" != "$live_sock_dir" ]] || { rm -rf "$scratch"; refuse LIVE-SOCKET "scratch socket dir resolves to $live_sock_dir" "a tmux socket directory other than the live one"; }
  ((${#sock} <= SOCKET_MAX)) || { rm -rf "$scratch"; refuse SOCKET-PATH-LONG "$sock is ${#sock} bytes" "at most $SOCKET_MAX (the unix socket limit is 108)"; }

  local live_port=""
  live_port="$(head -n 1 "$HOME/.purplemux/port" 2>/dev/null || true)"
  if [[ -n "$port" ]]; then
    [[ "$port" != "$live_port" ]] || { rm -rf "$scratch"; refuse LIVE-PORT "port $port is the live service's" "a spare port"; }
    ! port_answers "$port" || { rm -rf "$scratch"; refuse PORT-BUSY "127.0.0.1:$port answers" "a free port"; }
  else
    local tries=0
    while :; do
      port=$((18000 + RANDOM % 1000))
      [[ "$port" != "$live_port" ]] && ! port_answers "$port" && break
      ((++tries < 50)) || { rm -rf "$scratch"; refuse NO-FREE-PORT "50 ports in 18000-18999 answered" "a free port"; }
    done
  fi

  (
    cd "$candidate"
    exec setsid env -i \
      PATH="$scratch/bin:$(dirname "$NODE"):/usr/local/bin:/usr/bin:/bin" \
      HOME="$home" TMUX_TMPDIR="$tmuxdir" PORT="$port" HOST=localhost NODE_ENV=production \
      LANG="${LANG:-C.UTF-8}" TERM=xterm-256color USER="${USER:-$(id -un)}" SHELL=/bin/bash \
      "$candidate/node_modules/.bin/tsx" server.ts
  ) >"$scratch/server.log" 2>&1 </dev/null &
  local pid=$!

  local waited=0 actual=""
  while ((waited < START_TIMEOUT_S)); do
    actual="$(head -n 1 "$home/.purplemux/port" 2>/dev/null || true)"
    if [[ -n "$actual" ]] && "$CURL" -s -m 2 "http://127.0.0.1:$actual/api/health" 2>/dev/null | grep -q '"app":"purplemux"'; then
      break
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      tail -n 20 "$scratch/server.log" >&2
      refuse START-FAILED "the candidate server exited (log $scratch/server.log)" "a running candidate"
    fi
    sleep 1
    waited=$((waited + 1))
  done
  ((waited < START_TIMEOUT_S)) || { kill "$pid" 2>/dev/null; refuse START-TIMEOUT "no health answer within ${START_TIMEOUT_S}s (log $scratch/server.log)" "GET /api/health app=purplemux"; }
  [[ "$actual" != "$live_port" ]] || { kill "$pid" 2>/dev/null; refuse LIVE-PORT "the candidate fell back to the live port $actual" "a spare port"; }

  local lock_pid
  lock_pid="$("$NODE" -e 'try{process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).pid))}catch{}' "$home/.purplemux/pmux.lock")"
  [[ -n "$lock_pid" && "$(proc_home "$lock_pid")" == "$home" ]] \
    || { kill "$pid" 2>/dev/null; refuse NOT-ISOLATED "server pid ${lock_pid:-?} runs with HOME=$(proc_home "${lock_pid:-0}")" "HOME=$home"; }

  local token ws_a ws_b
  token="$(head -n 1 "$home/.purplemux/cli-token")"
  create_ws() {
    "$CURL" -s -m 20 -X POST -H "X-Pmux-Token: $token" -H 'Content-Type: application/json' \
      -d "{\"directory\":\"$scratch/work/$1\",\"name\":\"acc-$1\"}" "http://127.0.0.1:$actual/api/workspace" \
      | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).id||"")}catch{}})'
  }
  ws_a="$(create_ws a)"
  ws_b="$(create_ws b)"
  [[ -n "$ws_a" && -n "$ws_b" ]] || { kill "$pid" 2>/dev/null; refuse WORKSPACES "workspace ids a=${ws_a:-<none>} b=${ws_b:-<none>}" "two workspaces created"; }

  "$NODE" -e 'const [f,...v]=process.argv.slice(1);const k=["scratch","home","tmuxTmpdir","candidate","node","port","pid","lockPid"];const o={};k.forEach((x,i)=>o[x]=v[i]);o.port=Number(o.port);o.pid=Number(o.pid);o.lockPid=Number(o.lockPid);o.workspaces={a:v[8],b:v[9]};require("fs").writeFileSync(f,JSON.stringify(o,null,2)+"\n");' \
    "$state" "$scratch" "$home" "$tmuxdir" "$candidate" "$NODE" "$actual" "$pid" "$lock_pid" "$ws_a" "$ws_b"
  echo "ISOLATED scratch=$scratch port=$actual pid=$pid server=$lock_pid workspaces=$ws_a,$ws_b"
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
  [[ -f "$state" ]] || refuse STATE "no state file $state" "the file isolated-instance.sh up wrote"
  local scratch home tmuxdir p
  scratch="$(json_field "$state" scratch)"
  home="$(json_field "$state" home)"
  tmuxdir="$(json_field "$state" tmuxTmpdir)"
  [[ "$scratch" == "$SCRATCH_PARENT"/pmxa.* && "$home" == "$scratch/home" && "$tmuxdir" == "$scratch/tmux" ]] \
    || refuse STATE "scratch=$scratch home=$home tmux=$tmuxdir" "paths under $SCRATCH_PARENT/pmxa.*"
  for p in "$(json_field "$state" lockPid)" "$(json_field "$state" pid)"; do
    [[ -n "$p" && -e "$PROC_ROOT/$p" ]] || continue
    if [[ "$(proc_home "$p")" != "$home" ]]; then
      echo "NOT-OURS pid $p runs with HOME=$(proc_home "$p"); left running" >&2
      continue
    fi
    kill "$p" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do [[ -e "$PROC_ROOT/$p" ]] || break; sleep 1; done
    [[ -e "$PROC_ROOT/$p" && "$(proc_home "$p")" == "$home" ]] && kill -9 "$p" 2>/dev/null || true
  done
  local sock="$tmuxdir/tmux-$(id -u)/purple"
  if [[ -S "$sock" ]]; then
    env -u TMUX TMUX_TMPDIR="$tmuxdir" "$TMUX_BIN" -L purple kill-server 2>/dev/null || true
  fi
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
