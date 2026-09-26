#!/usr/bin/env bash
# deploy-live.sh — deploy a purplemux commit to the live service on this host
# through a release directory, a quiet wait, a health gate and rollback
# (ADR-0017, docs/DEPLOY.md).
#
# usage: deploy-live.sh <git-ref> [--quiet-timeout SECONDS] [--force-after-timeout]
#                       [--ignore-tab WS/TAB]... [--outside-tab] [--dry-run]
#        deploy-live.sh --rollback [--quiet-timeout SECONDS] [--force-after-timeout]
#                       [--ignore-tab WS/TAB]... [--outside-tab]
#
# Steps: build ~/.purplemux/releases/<sha> (a detached worktree of the primary
# repository) → take the deploy:purplemux lease when the running server has
# leases → wait until no agent tab is mid-turn (the tab in PMUX_TAB_ID and every
# --ignore-tab are excluded) → back up ~/.purplemux state → point `current` at
# the release, `previous` at the old one → restart → health gate → rollback on
# failure. The script never types into a tab.
#
# Exit codes:
#   0  deployed, rolled back on demand, or dry run finished
#   1  unexpected error (lease probe or acquire failed, backup failed)
#   2  refused before the live service was touched (usage, ref, disk, build,
#      own tab unknown, drop-in drift)
#   3  refused by state: quiet timeout, deploy lease held, another deploy running
#   4  restart or health gate failed and the previous release was restored
#
# From the first link change to the end of the gate or rollback, INT and TERM
# are deferred, so a signal never leaves the service on an unverified release.
#
# Every external binary is injectable: DEPLOY_SYSTEMCTL, DEPLOY_PNPM,
# DEPLOY_CURL, DEPLOY_TMUX, DEPLOY_PURPLEMUX, DEPLOY_JOURNALCTL, DEPLOY_GIT.
# Paths: DEPLOY_REPO (primary checkout), DEPLOY_DROPIN, DEPLOY_UNIT_FILE,
# DEPLOY_CLI_LINK, DEPLOY_SQLITE_MODULE, DEPLOY_PORT, DEPLOY_PROC_ROOT (/proc). Timing: DEPLOY_POLL_S (15),
# DEPLOY_HEALTH_TIMEOUT_S (90), DEPLOY_HEALTH_INTERVAL_S (3), DEPLOY_MIN_FREE_GIB (5).

set -u
set -o pipefail

usage() {
  sed -n '6,9p' "$0" | sed 's/^# //' >&2
  exit 2
}

REF=""
QUIET_TIMEOUT=900
FORCE_AFTER_TIMEOUT=0
DRY_RUN=0
ROLLBACK=0
OUTSIDE_TAB=0
IGNORE_TABS=()

while (($#)); do
  case "$1" in
    --quiet-timeout) [[ $# -ge 2 && "$2" =~ ^[0-9]+$ ]] || usage; QUIET_TIMEOUT="$2"; shift 2 ;;
    --force-after-timeout) FORCE_AFTER_TIMEOUT=1; shift ;;
    --ignore-tab) [[ $# -ge 2 && "$2" == */* ]] || usage; IGNORE_TABS+=("$2"); shift 2 ;;
    --outside-tab) OUTSIDE_TAB=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --rollback) ROLLBACK=1; shift ;;
    -h|--help) usage ;;
    -*) echo "unknown option: $1" >&2; usage ;;
    *) [[ -z "$REF" ]] || usage; REF="$1"; shift ;;
  esac
done
if ((ROLLBACK)); then
  [[ -z "$REF" && $DRY_RUN -eq 0 ]] || usage
else
  [[ -n "$REF" ]] || usage
fi

SYSTEMCTL="${DEPLOY_SYSTEMCTL:-systemctl}"
PNPM="${DEPLOY_PNPM:-pnpm}"
CURL="${DEPLOY_CURL:-curl}"
TMUX_BIN="${DEPLOY_TMUX:-tmux}"
JOURNALCTL="${DEPLOY_JOURNALCTL:-journalctl}"
GIT="${DEPLOY_GIT:-git}"
SERVICE="purplemux.service"

PMUX_HOME="$HOME/.purplemux"
RELEASES="$PMUX_HOME/releases"
BACKUPS="$PMUX_HOME/backups"
FIRST_INSTALL_SAVE="$RELEASES/first-install-rollback"
CURRENT="$RELEASES/current"
PREVIOUS="$RELEASES/previous"
REPO="${DEPLOY_REPO:-$HOME/code/purplemux}"
DROPIN="${DEPLOY_DROPIN:-$HOME/.config/systemd/user/purplemux.service.d/50-mission-control.conf}"
UNIT_FILE="${DEPLOY_UNIT_FILE:-$HOME/.config/systemd/user/purplemux.service}"
CLI_LINK="${DEPLOY_CLI_LINK:-$HOME/.local/bin/purplemux}"
POLL_S="${DEPLOY_POLL_S:-15}"
HEALTH_TIMEOUT_S="${DEPLOY_HEALTH_TIMEOUT_S:-90}"
HEALTH_INTERVAL_S="${DEPLOY_HEALTH_INTERVAL_S:-3}"
MIN_FREE_GIB="${DEPLOY_MIN_FREE_GIB:-5}"
HELPERS="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)/deploy-live-helpers.cjs"
OWN_TAB="${PMUX_TAB_ID:-}"
PROC_ROOT="${DEPLOY_PROC_ROOT:-/proc}"

WORK="$(mktemp -d)"
LEASE_HELD=0
CLI_DIR=""
INTERRUPTED=0

S_RELEASE="-"
S_PREVIOUS="-"
S_SESSIONS="-"
S_HEALTH="-"
S_ROLLBACK_HEALTH=""
S_QUIET="-"
S_LEASE="-"
S_BACKUP="-"

purplemux_cli() {
  if [[ -n "${DEPLOY_PURPLEMUX:-}" ]]; then
    "$DEPLOY_PURPLEMUX" "$@"
  else
    node "$CLI_DIR/bin/purplemux.js" "$@"
  fi
}

# The deploy lease belongs to the admin token (holder `admin`), so any
# orchestrator-authorised shell can deploy; a tab token would bind it to a tab.
admin_cli() { token_cli "$ADMIN_TOKEN" "$@"; }

token_cli() {
  local token="$1"
  shift
  (unset PMUX_TAB_TOKEN; PMUX_TOKEN="$token" purplemux_cli "$@")
}

finish() {
  local code="$1" verdict="$2"
  if ((LEASE_HELD)); then
    if admin_cli lease release deploy:purplemux >"$WORK/lease-release.out" 2>&1; then
      S_LEASE="acquired, released"
    else
      S_LEASE="acquired, release failed (expires by TTL): $(tr '\n' ' ' <"$WORK/lease-release.out")"
    fi
    LEASE_HELD=0
  fi
  echo "---- deploy-live summary ----"
  echo "RELEASE=$S_RELEASE"
  echo "PREVIOUS=$S_PREVIOUS"
  echo "SESSIONS=$S_SESSIONS"
  echo "HEALTH=$S_HEALTH"
  [[ -n "$S_ROLLBACK_HEALTH" ]] && echo "ROLLBACK_HEALTH=$S_ROLLBACK_HEALTH"
  echo "QUIET=$S_QUIET"
  echo "LEASE=$S_LEASE"
  echo "BACKUP=$S_BACKUP"
  ((INTERRUPTED)) && echo "INTERRUPTED=deferred until the swap window closed"
  echo "VERDICT=$verdict"
  rm -rf "$WORK"
  exit "$code"
}

refuse() {
  local code="$1" token="$2" measured="$3" expected="$4"
  echo "REFUSED $token" >&2
  echo "  measured: $measured" >&2
  echo "  expected: $expected" >&2
  finish "$code" "refused ($token)"
}

trap 'finish 1 "interrupted"' INT TERM

port() {
  if [[ -n "${DEPLOY_PORT:-}" ]]; then echo "$DEPLOY_PORT"; else head -n 1 "$PMUX_HOME/port" 2>/dev/null; fi
}

# http_get PATH OUTFILE [TOKEN] -> prints the HTTP status (000 = unreachable)
http_get() {
  local code
  code=$("$CURL" -sS -m 10 -o "$2" -w '%{http_code}' -H "X-Pmux-Token: ${3:-$ADMIN_TOKEN}" \
    "http://127.0.0.1:$(port)/$1" 2>/dev/null) || true
  echo "${code:-000}"
}

helper() { node "$HELPERS" "$@"; }

dropin_workdir() { [[ -f "$1" ]] && sed -n 's/^WorkingDirectory=//p' "$1" | tail -n 1; }

link_target() { [[ -L "$1" ]] && readlink "$1"; }

# Replace a symlink in one rename, so no reader sees it missing.
swap_link() {
  ln -sfn "$1" "$2.tmp.$$" && mv -Tf "$2.tmp.$$" "$2"
}

write_file_atomic() {
  cat >"$2.tmp.$$" <<<"$1" && mv -f "$2.tmp.$$" "$2"
}

# ---- preflight: every refusal here leaves the live service untouched ----

ADMIN_TOKEN="$(head -n 1 "$PMUX_HOME/cli-token" 2>/dev/null || true)"
[[ -n "$ADMIN_TOKEN" ]] || refuse 2 ADMIN-TOKEN-MISSING "no $PMUX_HOME/cli-token" "the live server's admin token file"
[[ -n "$(port)" ]] || refuse 2 PORT-UNKNOWN "no $PMUX_HOME/port and no DEPLOY_PORT" "the live server's port"

if [[ -z "$OWN_TAB" && ${#IGNORE_TABS[@]} -eq 0 && $OUTSIDE_TAB -eq 0 ]]; then
  refuse 2 OWN-TAB-UNKNOWN "PMUX_TAB_ID unset and no --ignore-tab" \
    "PMUX_TAB_ID, or --ignore-tab <own ws/tab> (tabs created before story 01), or --outside-tab from a shell outside every tab"
fi

exec 9>"$PMUX_HOME/deploy-live.lock"
flock -n 9 || refuse 3 DEPLOY-RUNNING "$PMUX_HOME/deploy-live.lock is held" "one deploy-live.sh at a time"

FIRST_INSTALL=0
[[ -L "$CURRENT" ]] || FIRST_INSTALL=1

if ((FIRST_INSTALL)); then
  LIVE_DIR="$(dropin_workdir "$DROPIN")"
  [[ -n "$LIVE_DIR" ]] || LIVE_DIR="$(dropin_workdir "$UNIT_FILE")"
  [[ -n "$LIVE_DIR" ]] || refuse 2 LIVE-DIR-UNKNOWN "no WorkingDirectory in $DROPIN or $UNIT_FILE" \
    "the directory the service runs today"
  # A drop-in that already names a release while `current` is gone is a half
  # finished install; saving it as the rollback target would lose the real one.
  [[ "$LIVE_DIR" != "$RELEASES" && "$LIVE_DIR" != "$RELEASES/"* ]] || refuse 2 FIRST-INSTALL-STATE \
    "no $CURRENT but the service runs WorkingDirectory=$LIVE_DIR" \
    "restore the drop-in from $FIRST_INSTALL_SAVE/drop-in.conf by hand"
  if [[ -f "$DROPIN" ]]; then
    old_dropin="$(cat "$DROPIN")"
    NEW_DROPIN="${old_dropin//"$LIVE_DIR"/"$CURRENT"}"
  else
    exec_start="$(sed -n 's/^ExecStart=\(..*\)$/\1/p' "$UNIT_FILE" | tail -n 1)"
    NEW_DROPIN="$(printf '[Service]\nWorkingDirectory=%s\nExecStart=\nExecStart=%s\n' "$CURRENT" "${exec_start//"$LIVE_DIR"/"$CURRENT"}")"
  fi
  if ! grep -qxF "WorkingDirectory=$CURRENT" <<<"$NEW_DROPIN" || [[ $'\n'"$NEW_DROPIN" != *$'\n'"ExecStart=$CURRENT/"* ]]; then
    refuse 2 DROPIN-REWRITE "the rewritten drop-in does not run $CURRENT: $(tr '\n' ' ' <<<"$NEW_DROPIN")" \
      "WorkingDirectory=$CURRENT and an ExecStart under $CURRENT/"
  fi
else
  running="$(dropin_workdir "$DROPIN")"
  [[ "$running" == "$CURRENT" ]] || refuse 2 DROPIN-DRIFT "$DROPIN WorkingDirectory=${running:-<none>}" \
    "WorkingDirectory=$CURRENT (a release install); restore the drop-in by hand before any deploy or rollback"
fi

# ---- rollback on demand ----

# Restores the drop-in and CLI link saved by the first install; returns the
# daemon-reload status.
rollback_first_install() {
  if [[ -f "$FIRST_INSTALL_SAVE/drop-in.conf" ]]; then
    cp -f "$FIRST_INSTALL_SAVE/drop-in.conf" "$DROPIN.tmp.$$" && mv -f "$DROPIN.tmp.$$" "$DROPIN"
  else
    rm -f "$DROPIN"
  fi
  local cli_target
  cli_target="$(cat "$FIRST_INSTALL_SAVE/cli-link-target" 2>/dev/null || true)"
  if [[ -n "$cli_target" ]]; then swap_link "$cli_target" "$CLI_LINK"; else rm -f "$CLI_LINK"; fi
  rm -f "$CURRENT" "$PREVIOUS"
  "$SYSTEMCTL" --user daemon-reload
}

if ((ROLLBACK)); then
  cur="$(link_target "$CURRENT")"
  prev="$(link_target "$PREVIOUS")"
  [[ -n "$cur" && -n "$prev" ]] || refuse 2 NOTHING-TO-ROLL-BACK "current=${cur:-<none>} previous=${prev:-<none>}" \
    "both $CURRENT and $PREVIOUS"
  if [[ "$prev" != "$RELEASES/"* && ! -d "$FIRST_INSTALL_SAVE" ]]; then
    refuse 2 ROLLBACK-STATE-UNKNOWN "previous=$prev is not a release and $FIRST_INSTALL_SAVE is missing" \
      "the first-install save that restores the drop-in and CLI link"
  fi
  [[ -f "$prev/.next/standalone/server.js" ]] || refuse 2 ROLLBACK-TARGET-UNBUILT \
    "no $prev/.next/standalone/server.js" "a built rollback target"
  CLI_DIR="$cur"
  S_RELEASE="$prev"
  S_PREVIOUS="$cur"
fi

# ---- release build ----

if ((!ROLLBACK)); then
  SHA="$("$GIT" -C "$REPO" rev-parse --verify --quiet "$REF^{commit}" 2>/dev/null)" \
    || refuse 2 REF-NOT-COMMIT "'$REF' does not resolve to a commit in $REPO" "a branch, tag or sha of $REPO"
  SHORT="${SHA:0:12}"
  RELEASE_DIR="$RELEASES/$SHORT"
  CLI_DIR="$RELEASE_DIR"
  S_RELEASE="$RELEASE_DIR"
  if ((!FIRST_INSTALL)) && [[ "$(readlink -f "$CURRENT")" == "$(readlink -f "$RELEASE_DIR")" ]]; then
    refuse 2 ALREADY-CURRENT "$CURRENT -> $RELEASE_DIR" "a commit other than the running release"
  fi

  free_gib="$(df -Pk "$PMUX_HOME" | awk 'NR==2 { print int($4 / 1048576) }')"
  ((free_gib >= MIN_FREE_GIB)) || refuse 2 DISK-FREE "$free_gib GiB free on $PMUX_HOME" "at least $MIN_FREE_GIB GiB"

  mkdir -p "$RELEASES" "$PMUX_HOME/logs"
  BUILD_LOG="$PMUX_HOME/logs/deploy-live-$(date -u +%Y%m%dT%H%M%SZ)-$SHORT.log"
  echo "BUILD_LOG=$BUILD_LOG"
  reused=0
  if [[ -e "$RELEASE_DIR" ]]; then
    [[ "$("$GIT" -C "$RELEASE_DIR" rev-parse HEAD 2>/dev/null)" == "$SHA" ]] \
      || refuse 2 RELEASE-DIR-CONFLICT "$RELEASE_DIR exists and is not a worktree at $SHA" "an absent or matching release directory"
    reused=1
  elif ! "$GIT" -C "$REPO" worktree add --detach "$RELEASE_DIR" "$SHA" >>"$BUILD_LOG" 2>&1; then
    refuse 2 BUILD-FAILED "git worktree add failed (see $BUILD_LOG)" "a release worktree at $RELEASE_DIR"
  fi
  if ! (cd "$RELEASE_DIR" && env -u NODE_ENV "$PNPM" install --frozen-lockfile && env -u NODE_ENV "$PNPM" build) >>"$BUILD_LOG" 2>&1; then
    tail -n 40 "$BUILD_LOG" >&2
    ((reused)) || "$GIT" -C "$REPO" worktree remove --force "$RELEASE_DIR" >>"$BUILD_LOG" 2>&1
    refuse 2 BUILD-FAILED "pnpm install/build failed in $RELEASE_DIR (see $BUILD_LOG)" "a clean build; the live service is untouched"
  fi
fi

# ---- lease ----

TTL_MIN=$(((QUIET_TIMEOUT + 59) / 60 + 15))
((TTL_MIN < 30)) && TTL_MIN=30
((TTL_MIN > 120)) && TTL_MIN=120

# A rollback must not depend on the lease feature of the release it escapes:
# only a live holder elsewhere (exit 3) stops it.
lease_code="$(http_get api/cli/leases "$WORK/leases.json")"
case "$lease_code" in
  404) S_LEASE="unavailable (server predates leases)" ;;
  200)
    if ((DRY_RUN)); then
      S_LEASE="available (not acquired: dry run)"
    elif admin_cli lease acquire deploy:purplemux --ttl "${TTL_MIN}m" >"$WORK/lease.out" 2>&1; then
      LEASE_HELD=1
      S_LEASE="acquired"
    else
      rc=$?
      cat "$WORK/lease.out" >&2
      if ((rc == 3)); then
        S_LEASE="held elsewhere"
        finish 3 "lease-held"
      fi
      ((ROLLBACK)) || refuse 1 LEASE-ACQUIRE-FAILED "lease acquire exited $rc" "exit 0 (acquired) or 3 (held elsewhere)"
      S_LEASE="unavailable (lease acquire exited $rc; rollback proceeds)"
    fi
    ;;
  *)
    ((ROLLBACK)) || refuse 1 LEASE-PROBE-FAILED "GET /api/cli/leases answered HTTP $lease_code (000 = unreachable)" \
      "HTTP 200 (leases) or 404 (server predates leases)"
    S_LEASE="unavailable (GET /api/cli/leases HTTP $lease_code; rollback proceeds)"
    ;;
esac

# ---- quiet wait (read-only) ----

echo '{"tabs":[]}' >"$WORK/tabs.json"

# One poll: writes $WORK/midturn.tsv; returns 1 when the tab list is unreadable.
poll_midturn() {
  local code
  code="$(http_get api/cli/tabs "$WORK/tabs.next.json")"
  if [[ "$code" != 200 ]]; then
    LIST_ERROR="GET /api/cli/tabs answered HTTP $code"
    return 1
  fi
  mv -f "$WORK/tabs.next.json" "$WORK/tabs.json"
  rm -rf "$WORK/status" && mkdir -p "$WORK/status"
  if [[ "$(helper shape "$WORK/tabs.json")" == old ]]; then
    local ws tab scode
    while IFS=$'\t' read -r ws tab; do
      scode="$(http_get "api/cli/tabs/$tab/status?workspaceId=$ws" "$WORK/status/$tab.json")"
      case "$scode" in
        200) ;;
        404) echo '{"gone":true}' >"$WORK/status/$tab.json" ;;
        *) echo "{\"error\":\"HTTP $scode\"}" >"$WORK/status/$tab.json" ;;
      esac
    done < <(helper agent-tabs "$WORK/tabs.json")
  fi
  helper midturn "$WORK/tabs.json" "$WORK/status" "$OWN_TAB" "${IGNORE_TABS[@]}" >"$WORK/midturn.tsv"
}

print_midturn() {
  local ws tab name busy reason
  while IFS=$'\t' read -r ws tab name busy reason; do
    echo "MID-TURN $ws $tab $name busy-for=$busy ($reason)"
  done <"$WORK/midturn.tsv"
}

LIST_ERROR=""
if ((DRY_RUN)); then
  if poll_midturn; then
    if [[ -s "$WORK/midturn.tsv" ]]; then
      print_midturn
      S_QUIET="not quiet ($(wc -l <"$WORK/midturn.tsv") mid-turn)"
    else
      S_QUIET="quiet"
    fi
  else
    S_QUIET="unknown ($LIST_ERROR)"
  fi
  S_BACKUP="skipped (dry run)"
  finish 0 "dry-run"
fi

if ((ROLLBACK)) && ! poll_midturn; then
  S_QUIET="skipped (rollback; $LIST_ERROR)"
else
  deadline=$((SECONDS + QUIET_TIMEOUT))
  quiet_polls=0
  : >"$WORK/midturn.tsv"
  while :; do
    if poll_midturn; then
      LIST_ERROR=""
      if [[ -s "$WORK/midturn.tsv" ]]; then quiet_polls=0; else quiet_polls=$((quiet_polls + 1)); fi
    else
      quiet_polls=0
    fi
    if ((quiet_polls >= 2)); then
      S_QUIET="quiet"
      break
    fi
    # A quiet poll at the deadline earns the confirming poll; the wait is
    # bounded by one extra interval.
    if ((SECONDS >= deadline && quiet_polls == 0)); then
      [[ -n "$LIST_ERROR" ]] && echo "tab list unreadable: $LIST_ERROR" >&2
      print_midturn
      blockers="$(wc -l <"$WORK/midturn.tsv")"
      if ((FORCE_AFTER_TIMEOUT)); then
        S_QUIET="forced after timeout ($blockers mid-turn${LIST_ERROR:+; $LIST_ERROR})"
        break
      fi
      S_QUIET="timeout after ${QUIET_TIMEOUT}s ($blockers mid-turn${LIST_ERROR:+; $LIST_ERROR})"
      finish 3 "quiet-timeout"
    fi
    sleep "$POLL_S"
  done
fi

# ---- backup (after the quiet wait, so it holds the state at the restart) ----

backup_state() {
  local dir="$BACKUPS/$(date -u +%Y%m%dT%H%M%SZ)-$1" module="${DEPLOY_SQLITE_MODULE:-$CLI_DIR/node_modules/better-sqlite3}"
  mkdir -p -m 700 "$BACKUPS" && mkdir -p -m 700 "$dir" || return 1
  local f
  for f in "$PMUX_HOME"/*.json; do
    [[ -f "$f" ]] && { cp -p "$f" "$dir/" || return 1; }
  done
  if [[ -f "$PMUX_HOME/mission-control.sqlite" ]]; then
    helper backup "$PMUX_HOME/mission-control.sqlite" "$dir/mission-control.sqlite" "$module" || return 1
  fi
  S_BACKUP="$dir"
  local old
  while read -r old; do
    [[ -n "$old" && "$old" != */* ]] && rm -rf "${BACKUPS:?}/$old"
  done < <(ls -1 "$BACKUPS" | sort | head -n -5)
}

backup_state "${SHORT:-rollback}" || refuse 1 BACKUP-FAILED "backup into $BACKUPS failed" \
  "a copy of $PMUX_HOME/*.json and mission-control.sqlite before the restart"

# ---- swap, restart, health gate ----

# Session names; "no server" is an empty list, any other failure is an error.
list_sessions() {
  if "$TMUX_BIN" -L purple list-sessions -F '#{session_name}' 2>"$WORK/tmux.err" | sort -u >"$1"; then
    return 0
  fi
  if grep -qiE 'no server running|error connecting' "$WORK/tmux.err"; then
    : >"$1"
    return 0
  fi
  SESSIONS_ERROR="tmux list-sessions failed: $(tr '\n' ' ' <"$WORK/tmux.err")"
  return 1
}

main_pid() { "$SYSTEMCTL" --user show -p MainPID --value "$SERVICE" 2>/dev/null | head -n 1; }

list_sessions "$WORK/sessions.before" || refuse 1 SESSIONS-UNREADABLE "$SESSIONS_ERROR" \
  "the tmux session names before the restart (the health gate compares them)"

# health_gate EXPECTED_DIR PID_BEFORE: a new MainPID running in EXPECTED_DIR,
# /api/health, every pre-restart session name, a workspace-token tab list.
health_gate() {
  local expected="$1" pid_before="$2" deadline=$((SECONDS + HEALTH_TIMEOUT_S))
  local pid cwd code app missing before reason ws_token ws token tablist
  before="$(wc -l <"$WORK/sessions.before")"
  while :; do
    reason=""
    tablist=""
    pid="$(main_pid)"
    if [[ -z "$pid" || "$pid" == 0 ]]; then
      reason="no MainPID for $SERVICE"
    elif [[ "$pid" == "$pid_before" ]]; then
      reason="MainPID $pid unchanged by the restart"
    else
      cwd="$(readlink -f "$PROC_ROOT/$pid/cwd" 2>/dev/null)"
      [[ "$cwd" == "$expected" ]] || reason="MainPID $pid runs in ${cwd:-<unreadable>}, expected $expected"
    fi
    if [[ -z "$reason" ]]; then
      code="$(http_get api/health "$WORK/health.json")"
      app="$(helper field "$WORK/health.json" app 2>/dev/null)"
      [[ "$code" == 200 && "$app" == purplemux ]] || reason="GET /api/health: HTTP $code app=${app:-<none>}"
    fi
    if list_sessions "$WORK/sessions.after"; then
      comm -23 "$WORK/sessions.before" "$WORK/sessions.after" >"$WORK/sessions.missing"
      missing="$(wc -l <"$WORK/sessions.missing")"
      S_SESSIONS="$((before - missing))/$before"
      if [[ -z "$reason" ]] && ((missing > 0)); then
        reason="$missing tmux session(s) missing after the restart"
      fi
    else
      : >"$WORK/sessions.missing"
      S_SESSIONS="unreadable/$before"
      [[ -n "$reason" ]] || reason="$SESSIONS_ERROR"
    fi
    if [[ -z "$reason" ]]; then
      ws_token="$(helper ws-token "$WORK/tabs.json" "$PMUX_HOME/workspace-tokens.json")"
      if [[ -n "$ws_token" ]]; then
        ws="${ws_token%%$'\t'*}"
        token="${ws_token#*$'\t'}"
        token_cli "$token" tab list -w "$ws" >/dev/null 2>"$WORK/tablist.err" \
          || reason="workspace-token tab list failed: $(tr '\n' ' ' <"$WORK/tablist.err")"
      else
        tablist=" (tab-list skipped: no workspace token)"
      fi
    fi
    if [[ -z "$reason" ]]; then
      HEALTH_RESULT="pass$tablist"
      return 0
    fi
    if ((SECONDS >= deadline)); then
      HEALTH_RESULT="fail ($reason)"
      while read -r name; do echo "SESSION-MISSING $name" >&2; done <"$WORK/sessions.missing"
      return 1
    fi
    sleep "$HEALTH_INTERVAL_S"
  done
}

# restart_and_gate EXPECTED_DIR: a restart that systemctl refuses is a failed gate.
restart_and_gate() {
  local pid_before
  pid_before="$(main_pid)"
  if ! "$SYSTEMCTL" --user restart "$SERVICE"; then
    HEALTH_RESULT="fail (systemctl --user restart $SERVICE exited non-zero)"
    return 1
  fi
  health_gate "$1" "$pid_before"
}

print_journal() {
  echo "---- journalctl --user -u purplemux -n 80 ----" >&2
  "$JOURNALCTL" --user -u purplemux -n 80 --no-pager >&2 2>&1 || true
}

OLD_CURRENT="$(link_target "$CURRENT")"
OLD_PREVIOUS="$(link_target "$PREVIOUS")"

# From here to the verdict a signal would strand the service on an unverified
# release, so INT and TERM wait for the gate or the rollback.
trap 'INTERRUPTED=1; echo "deploy-live: signal deferred until the health gate or rollback finishes" >&2' INT TERM

if ((ROLLBACK)); then
  back_dir="$(readlink -f "$prev")"
  rolled=1
  if [[ "$prev" == "$RELEASES/"* ]]; then
    swap_link "$prev" "$CURRENT"
    swap_link "$cur" "$PREVIOUS"
  else
    rollback_first_install || { HEALTH_RESULT="fail (systemctl --user daemon-reload exited non-zero)"; rolled=0; }
  fi
  if ((rolled)) && restart_and_gate "$back_dir"; then
    S_HEALTH="$HEALTH_RESULT"
    finish 0 "rolled-back"
  fi
  S_HEALTH="$HEALTH_RESULT"
  print_journal
  finish 4 "rollback-unhealthy"
fi

if ((FIRST_INSTALL)); then
  mkdir -p "$FIRST_INSTALL_SAVE"
  rm -f "$FIRST_INSTALL_SAVE/drop-in.conf" "$FIRST_INSTALL_SAVE/cli-link-target"
  [[ -f "$DROPIN" ]] && cp -p "$DROPIN" "$FIRST_INSTALL_SAVE/drop-in.conf"
  if [[ -L "$CLI_LINK" ]]; then readlink "$CLI_LINK" >"$FIRST_INSTALL_SAVE/cli-link-target"; else : >"$FIRST_INSTALL_SAVE/cli-link-target"; fi
  swap_link "$LIVE_DIR" "$PREVIOUS"
  mkdir -p "$(dirname "$DROPIN")"
  write_file_atomic "$NEW_DROPIN" "$DROPIN"
  if [[ -f "$FIRST_INSTALL_SAVE/drop-in.conf" ]]; then
    diff -u "$FIRST_INSTALL_SAVE/drop-in.conf" "$DROPIN"
  else
    diff -u /dev/null "$DROPIN"
  fi
  back_dir="$(readlink -f "$LIVE_DIR")"
else
  swap_link "$OLD_CURRENT" "$PREVIOUS"
  back_dir="$(readlink -f "$OLD_CURRENT")"
fi
S_PREVIOUS="$(link_target "$PREVIOUS")"
swap_link "$RELEASE_DIR" "$CURRENT"
mkdir -p "$(dirname "$CLI_LINK")"
swap_link "$CURRENT/bin/purplemux.js" "$CLI_LINK"

deployed=1
if ((FIRST_INSTALL)) && ! "$SYSTEMCTL" --user daemon-reload; then
  HEALTH_RESULT="fail (systemctl --user daemon-reload exited non-zero)"
  deployed=0
fi
((deployed)) && { restart_and_gate "$(readlink -f "$RELEASE_DIR")" || deployed=0; }

# ---- rollback: restore the links exactly as they were before this run ----

if ((!deployed)); then
  S_HEALTH="$HEALTH_RESULT"
  deploy_sessions="$S_SESSIONS"
  rolled=1
  if ((FIRST_INSTALL)); then
    rollback_first_install || { HEALTH_RESULT="fail (systemctl --user daemon-reload exited non-zero)"; rolled=0; }
  else
    swap_link "$OLD_CURRENT" "$CURRENT"
    if [[ -n "$OLD_PREVIOUS" ]]; then swap_link "$OLD_PREVIOUS" "$PREVIOUS"; else rm -f "$PREVIOUS"; fi
  fi
  if ((rolled)) && restart_and_gate "$back_dir"; then S_ROLLBACK_HEALTH="pass"; else S_ROLLBACK_HEALTH="$HEALTH_RESULT"; fi
  S_SESSIONS="$deploy_sessions"
  S_PREVIOUS="${OLD_PREVIOUS:--}"
  print_journal
  finish 4 "rolled-back"
fi
S_HEALTH="$HEALTH_RESULT"

# ---- keep current and previous; prune older releases by exact path ----

keep_current="$(readlink -f "$CURRENT")"
keep_previous="$(readlink -f "$PREVIOUS")"
for dir in "$RELEASES"/*; do
  name="${dir##*/}"
  [[ -d "$dir" && ! -L "$dir" && "$name" =~ ^[0-9a-f]{7,40}$ ]] || continue
  real="$(readlink -f "$dir")"
  [[ "$real" == "$keep_current" || "$real" == "$keep_previous" ]] && continue
  if "$GIT" -C "$REPO" worktree remove --force "$dir" >/dev/null 2>&1; then
    echo "PRUNED $dir"
  else
    echo "PRUNE-SKIPPED $dir (not a worktree of $REPO)"
  fi
done

finish 0 "deployed"
