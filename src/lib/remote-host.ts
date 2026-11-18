import { execFile } from 'child_process';
import os from 'os';
import { readFleetConfig, valueOf } from '@/lib/fleet-config-store';
import { readServerPort } from '@/lib/server-port';
import type { IReapedProcess, IReapResult } from '@/lib/tab-reaper';
import type { IOrphanHostFacts } from '@/lib/tab-orphans';
import { SSH_CONNECT_TIMEOUT_S, remoteBudget, remoteTimeoutMs } from '@/lib/remote-timeouts';

/**
 * Remote tabs (ADR-0022): a tab whose tmux session runs on another host, driven
 * from this server over ssh. This module owns the host registry, the ssh
 * invocation and the scripts that run on the remote host; `tmux.ts` decides
 * which calls go there.
 */

export const REMOTE_HOSTS_KEY = 'remote.hosts';

// An ssh alias, never an option: no leading '-', no whitespace, no shell syntax.
const HOST_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

export const isValidRemoteHostName = (value: unknown): value is string =>
  typeof value === 'string' && HOST_NAME.test(value);

export const parseRemoteHosts = (raw: string | null | undefined): string[] =>
  [...new Set((raw ?? '').split(',').map((h) => h.trim()).filter(isValidRemoteHostName))];

/** The registered hosts. Throws when the fleet config is unreadable (ADR-0019: never read as empty). */
export const readRemoteHosts = async (): Promise<string[]> =>
  parseRemoteHosts(valueOf(await readFleetConfig(), REMOTE_HOSTS_KEY)?.value);

export const REMOTE_CALLBACK_URL_KEY = 'remote.callback-url';

/**
 * One remote host's own callback URL (PMUX-REMOTE-URL): `remote.callback-url.<ssh alias>` wins over the fleet key, as
 * `remote.timeout-ms.<ssh alias>` does. A host whose resolver cannot read this server's name (curl exit 6, measured
 * 2026-11-09) is given an address it can reach, and only that host changes.
 */
export const remoteCallbackUrlKeyFor = (host: string): string => `${REMOTE_CALLBACK_URL_KEY}.${host}`;

export const REMOTE_CALLBACK_ALLOW_HOSTS_KEY = 'remote.callback-allow-hosts';

/**
 * The tailnet's MagicDNS suffix (ADR-0047), admin-only: a Portfolio Scrum Master's `remote.callback-url.<host>` may
 * name `<name>.<suffix>`. Unset, it may name no host name at all, only a 100.64.0.0/10 address.
 */
export const REMOTE_TAILNET_SUFFIX_KEY = 'remote.tailnet-suffix';

const DNS_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const TAILNET_SUFFIX = new RegExp(`^${DNS_LABEL}(?:\\.${DNS_LABEL})+$`);

/**
 * Two or more lower-case DNS labels, at most 253 characters, no leading or trailing dot, and never `ts.net` itself:
 * every tailnet's names end in it, so it would let the Scrum Master name a host of any tailnet.
 */
export const isValidTailnetSuffix = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 253 && TAILNET_SUFFIX.test(value) && value !== 'ts.net';

const URL_SHAPE = /^(https?):\/\/([^/?#@\s]+)\/?$/;
const AUTHORITY = /^(\[[0-9A-Fa-f:.]+\]|[^:[\]]+)(?::\d{1,5})?$/;
const BARE_NAME = /^[a-z][a-z0-9-]{0,62}$/;

export const isValidBareHostName = (value: unknown): value is string => typeof value === 'string' && BARE_NAME.test(value);

export const parseCallbackAllowHosts = (raw: string | null | undefined): string[] =>
  (raw ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(isValidBareHostName);

const isLoopback = (host: string): boolean => host === 'localhost' || host === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);

const OCTET = '(?:0|[1-9][0-9]{0,2})';
const DOTTED_QUAD = new RegExp(`^${OCTET}\\.${OCTET}\\.${OCTET}\\.${OCTET}$`);

/**
 * A 100.64.0.0/10 address in its one canonical spelling (ADR-0047, r2 #2): four decimal octets 0..255, no leading
 * zero, so 100.064.0.1 is no tailnet address here. The Portfolio Scrum Master's guard holds on its own with it; it
 * does not lean on the general check running first.
 */
export const isCanonicalTailnetAddress = (host: string): boolean => {
  if (!DOTTED_QUAD.test(host)) return false;
  const [a, b, c, d] = host.split('.').map(Number);
  return a === 100 && b >= 64 && b <= 127 && c <= 255 && d <= 255;
};

export const isTailnetAddress = (host: string): boolean => {
  const ip = host.match(/^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  return !!ip && Number(ip[1]) >= 64 && Number(ip[1]) <= 127;
};

/**
 * Why a callback URL is refused, or null (review r3 nit 4, r4). A tab's token
 * rides every hook and CLI call to it. The host is read as `new URL()` reads it
 * and must be written in that canonical form, so 2130706433, 0x7f000001 or
 * 0177.0.0.1 cannot pass as 127.0.0.1. Plain http only to loopback,
 * 100.64.0.0/10, `*.ts.net`, or a bare name on `remote.callback-allow-hosts`
 * (a MagicDNS name looks like an intranet name, so the admin names it);
 * anything else must be https.
 */
export const callbackUrlRefusal = (value: unknown, allowHosts: readonly string[] = []): string | null => {
  const shape = typeof value === 'string' ? value.match(URL_SHAPE) : null;
  const authority = shape?.[2].match(AUTHORITY);
  if (!shape || !authority) return `${REMOTE_CALLBACK_URL_KEY} must be http(s)://host[:port], with no user, path or query`;
  let host: string;
  try {
    host = new URL(value as string).hostname;
  } catch {
    return `${REMOTE_CALLBACK_URL_KEY} is not a URL`;
  }
  if (host !== authority[1].toLowerCase()) return `${REMOTE_CALLBACK_URL_KEY} host must be written in canonical form: ${JSON.stringify(authority[1])} reads as ${JSON.stringify(host)}`;
  if (host.endsWith('.')) return `${REMOTE_CALLBACK_URL_KEY} host must not end with a dot`;
  if (shape[1] === 'https') return null;
  if (isLoopback(host) || isTailnetAddress(host) || /^(?:[a-z0-9-]+\.)+ts\.net$/.test(host)) return null;
  if (BARE_NAME.test(host)) {
    return allowHosts.includes(host) ? null : `${REMOTE_CALLBACK_URL_KEY}: the bare name ${host} is allowed over plain http only once an admin lists it in ${REMOTE_CALLBACK_ALLOW_HOSTS_KEY}`;
  }
  return `${REMOTE_CALLBACK_URL_KEY} over plain http must name loopback, a 100.64.0.0/10 address, a *.ts.net name or a bare name on ${REMOTE_CALLBACK_ALLOW_HOSTS_KEY}; use https otherwise`;
};


/**
 * Why the Portfolio Scrum Master may not write this callback URL, or null (ADR-0047). The key decides where a host's
 * hooks POST, with each tab's token, so the Scrum Master's value names the tailnet only:
 * `http(s)://<name>.<remote.tailnet-suffix>:<port>`, or `http(s)://<100.64.0.0/10 address>:<port>`. The admin token
 * writes any value {@link callbackUrlRefusal} takes; that check runs first for every writer.
 */
export const scrumMasterCallbackRefusal = (value: string, tailnetSuffix: string | null): string | null => {
  const m = value.match(/^https?:\/\/([^/:?#@\s]+):(\d{1,5})\/?$/);
  if (!m) return 'the Portfolio Scrum Master writes http(s)://<host>:<port>, with the port';
  const port = Number(m[2]);
  if (port < 1 || port > 65535) return `port ${m[2]} is out of range`;
  const host = m[1];
  if (isCanonicalTailnetAddress(host)) return null;
  if (/^[0-9.]+$/.test(host) || host.startsWith('[')) return `${host} is not in 100.64.0.0/10`;
  if (!tailnetSuffix) {
    return `${host} is a name, and ${REMOTE_TAILNET_SUFFIX_KEY} is unset: the Portfolio Scrum Master names a 100.64.0.0/10 address, or the admin token sets the suffix`;
  }
  const escaped = tailnetSuffix.replace(/[.]/g, '\\.');
  return new RegExp(`^${DNS_LABEL}\\.${escaped}$`).test(host) ? null : `${host} is not <name>.${tailnetSuffix} (${REMOTE_TAILNET_SUFFIX_KEY})`;
};

/**
 * Where a remote tab's hooks and CLI on `host` reach this server: fleet config
 * `remote.callback-url.<host>`, else `remote.callback-url`, else `http://<this hostname>:<port>` (a Tailscale
 * name answers on the tailnet), with no trailing `/`. Throws when the fleet config is unreadable or the URL is refused.
 */
export const resolveCallbackUrl = async (host?: string): Promise<string> => {
  const state = await readFleetConfig();
  const hostKey = host !== undefined ? remoteCallbackUrlKeyFor(host) : null;
  const hostValue = hostKey !== null ? valueOf(state, hostKey)?.value : undefined;
  const key = hostValue !== undefined ? hostKey : REMOTE_CALLBACK_URL_KEY;
  const configured = hostValue ?? valueOf(state, REMOTE_CALLBACK_URL_KEY)?.value;
  const url = configured ?? `http://${os.hostname().toLowerCase()}:${readServerPort()}`;
  const refusal = callbackUrlRefusal(url, parseCallbackAllowHosts(valueOf(state, REMOTE_CALLBACK_ALLOW_HOSTS_KEY)?.value));
  if (refusal) throw new Error(`${refusal} (${configured === undefined ? 'the default from this hostname' : `fleet config ${key}`}: ${JSON.stringify(url)})`);
  return normalizeCallbackUrl(url);
};

/**
 * A callback URL with no trailing `/` (PMUX-REMOTE-URL r3). The validator takes `http://host:port/`, and the hook and
 * the CLI append `/api/...`: `//api/status/hook` answers 308, so the base never ends in `/`.
 */
export const normalizeCallbackUrl = (url: string): string => url.replace(/\/+$/, '');

/** This server's name on a remote host: it keys the remote socket and config directory. */
export const originName = (): string => {
  const name = os.hostname().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return name || 'origin';
};

/**
 * Never `purple`: the remote host may run its own purplemux on that socket, and
 * its scans must not see this server's sessions.
 */
export const remoteSocketName = (): string => `pmux-${originName()}`;

export const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

export const remoteTmuxCommand = (args: readonly string[]): string =>
  ['tmux', '-L', remoteSocketName(), ...args].map(shQuote).join(' ');

/** The remote script exits with this when the session name is already taken: never touch that session. */
export const REMOTE_SESSION_EXISTS_EXIT = 17;

/**
 * Guards of a remote create (ADR-0022 §8). A name that already exists is never
 * replaced; the created session carries this call's nonce, and a failed create
 * kills a session only when it carries that nonce, so a failure can never end
 * a live session of the same name (review r1, B2).
 */
export const remoteSessionExistsGuard = (session: string): string =>
  `if ${remoteTmuxCommand(['has-session', '-t', `=${session}`])} 2>/dev/null; then echo ${shQuote(`pmux: session ${session} already exists`)} >&2; exit ${REMOTE_SESSION_EXISTS_EXIT}; fi`;

/**
 * Appended to the `new-session` arguments: tmux runs it in the same client
 * command, so no dropped connection can leave the new session untagged
 * (review r2 nit 1).
 */
export const remoteTagArgs = (session: string, nonce: string): string[] =>
  [';', 'set-option', '-t', `=${session}:`, '@pmux-create', nonce];

export const remoteKillIfTagged = (session: string, nonce: string): string =>
  `[ "$(${remoteTmuxCommand(['show-options', '-qv', '-t', `=${session}:`, '@pmux-create'])} 2>/dev/null)" = ${shQuote(nonce)} ] && ${remoteTmuxCommand(['kill-session', '-t', `=${session}`])}; true`;

const TMUX_ABSENCE = /^(can't find (session|window)|no such session|no server running on |error connecting to .*\(No such file or directory\))/;

/**
 * tmux's own word that a session or server does not exist (exit 1), as opposed
 * to ssh or a timeout failing. Any stderr line counts: ssh or the remote
 * shell's start-up may print before it (review r2 nit 2).
 */
export const isTmuxAbsence = (err: unknown): boolean => {
  const e = err as IRemoteExecError | null;
  if (!e || e.code !== 1 || e.killed || e.signal) return false;
  return (e.stderr ?? '').split('\n').some((line) => TMUX_ABSENCE.test(line.trim()));
};

export const sshArgv = (host: string, remoteCommand: string, opts: { tty?: boolean; connectTimeoutS?: number } = {}): string[] => {
  if (!isValidRemoteHostName(host)) throw new Error(`invalid remote host name: ${JSON.stringify(host)}`);
  return [
    ...(opts.tty ? ['-tt'] : []),
    '-o', 'BatchMode=yes',
    '-o', `ConnectTimeout=${opts.connectTimeoutS ?? SSH_CONNECT_TIMEOUT_S}`,
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    // No ControlMaster (ADR-0022 §5): a first multiplexed connection exited 255 with no stderr in 1
    // of 10 fresh control directories, and a dead master stalls every call until ServerAlive gives up.
    '-o', 'ControlMaster=no',
    '-o', 'ControlPath=none',
    '--', host, remoteCommand,
  ];
};

/** ssh's own failure status. Not proof that nothing ran: a connection lost after the command started also ends in 255. */
export const SSH_FAILURE_EXIT = 255;

export interface IRemoteExecError extends Error {
  code?: number | string;
  killed?: boolean;
  signal?: NodeJS.Signals | null;
  stdout?: string;
  stderr?: string;
}

/** What failed, without the command line (it can carry a whole script): exit status, timeout, stderr. */
export const describeRemoteFailure = (err: unknown): string => {
  const e = (err ?? {}) as IRemoteExecError;
  const status = e.killed ? 'timed out' : e.signal ? `signal ${e.signal}` : `exit ${e.code ?? 'unknown'}`;
  const stderr = e.stderr?.trim();
  return stderr ? `${status}: ${stderr.slice(-500)}` : status;
};

export const isSshFailure = (err: unknown): boolean => {
  const e = err as IRemoteExecError | null;
  return !!e && (e.code === SSH_FAILURE_EXIT || e.killed === true || typeof e.code === 'string');
};

/**
 * Run one command on `host`. Rejects like `execFile`: `code` is the remote exit
 * status, or 255 when ssh itself failed; `stdout`/`stderr` are attached.
 * `timeoutMs` is the call's budget at the default; the host's `remote.timeout-ms`
 * scales it and ssh's ConnectTimeout (vel-D61).
 */
export const runSsh = async (
  host: string,
  command: string,
  opts: { timeoutMs: number; input?: string },
): Promise<{ stdout: string; stderr: string }> => {
  const budget = remoteBudget(opts.timeoutMs, await remoteTimeoutMs(host));
  return new Promise((resolve, reject) => {
    const child = execFile(
      'ssh',
      sshArgv(host, command, { connectTimeoutS: budget.connectTimeoutS }),
      { timeout: budget.timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(Object.assign(err, { stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }));
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
    child?.stdin?.on('error', () => {});
    child?.stdin?.end(opts.input ?? '');
  });
};

/** `runSsh` with stdout as bytes: a transcript chunk can end inside a multi-byte character. */
export const runSshBuffer = async (
  host: string,
  command: string,
  opts: { timeoutMs: number; maxBytes: number },
): Promise<Buffer> => {
  const budget = remoteBudget(opts.timeoutMs, await remoteTimeoutMs(host));
  return new Promise((resolve, reject) => {
    const child = execFile(
      'ssh',
      sshArgv(host, command, { connectTimeoutS: budget.connectTimeoutS }),
      { timeout: budget.timeoutMs, maxBuffer: opts.maxBytes + 64 * 1024, encoding: 'buffer' },
      (err, stdout, stderr) => {
        if (err) {
          reject(Object.assign(err, { stderr: Buffer.isBuffer(stderr) ? stderr.toString('utf-8') : String(stderr ?? '') }));
          return;
        }
        resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout)));
      },
    );
    child?.stdin?.on('error', () => {});
    child?.stdin?.end();
  });
};

export class RemoteHostError extends Error {
  constructor(readonly host: string, message: string) {
    super(message);
    this.name = 'RemoteHostError';
  }
}

/**
 * The close step on the remote host (ADR-0016 rules, ADR-0022 §9), as one
 * `sh -s -- SOCKET SESSION TAB KEEP` run. The tab-owned set is the pane's
 * descendants plus every process of the user whose environment holds exactly
 * `PMUX_TAB_ID=<TAB>`. Never signalled: this script, the remote tmux server and
 * pid 1. SIGTERM (+ SIGCONT), up to 3 s of grace, SIGKILL, one rescan for late
 * forks. `KEEP=1` signals the pane's process group only.
 *
 * Output, one line each: `marker\t<present|absent|unknown>`, then
 * `killed\t<pid>\t<comm>\t<args>` or `survivor\t…`, then `session\t<gone|present>`.
 */
export const REMOTE_REAP_SCRIPT = `sock=$1; session=$2; tab=$3; keep=$4; origin=$5
[ -n "$tab" ] && [ -n "$origin" ] && rm -f "$HOME/.purplemux-remote/$origin/tabs/$tab.env"
srv=$(tmux -L "$sock" display-message -p '#{pid}' 2>/dev/null)
pane=$(tmux -L "$sock" display-message -p -t "=$session:" '#{pane_pid}' 2>/dev/null)
marker=unknown
if [ -n "$pane" ] && [ -n "$tab" ] && [ -r "/proc/$pane/environ" ]; then
  if grep -qzxF "PMUX_TAB_ID=$tab" "/proc/$pane/environ" 2>/dev/null; then marker=present; else marker=absent; fi
fi
descendants() {
  for c in $(cat /proc/"$1"/task/*/children 2>/dev/null); do echo "$c"; descendants "$c"; done
}
marked() {
  [ -n "$tab" ] || return 0
  grep -lzxF "PMUX_TAB_ID=$tab" /proc/[0-9]*/environ 2>/dev/null | sed 's#^/proc/##; s#/environ$##'
}
eligible() {
  case "$1" in ''|0|1|"$$"|"$srv"|"$pane") return 1 ;; esac
  case "$1" in *[!0-9]*) return 1 ;; esac
  return 0
}
alive() {
  st=$(sed 's/.*) //' "/proc/$1/stat" 2>/dev/null | cut -d' ' -f1)
  [ -n "$st" ] && [ "$st" != Z ] && [ "$st" != X ]
}
targets=""
if [ "$keep" != 1 ]; then
  for p in $( [ -n "$pane" ] && descendants "$pane"; marked ); do
    eligible "$p" || continue
    case " $targets " in *" $p "*) continue ;; esac
    targets="$targets $p"
  done
fi
describe() {
  comm=$(cat "/proc/$1/comm" 2>/dev/null)
  args=$(tr '\\0' ' ' < "/proc/$1/cmdline" 2>/dev/null | cut -c1-200)
  printf '%s\\t%s\\t%s' "$1" "$comm" "$args"
}
descs=""
for p in $targets; do descs="$descs$(describe "$p")
"; done
[ -n "$pane" ] && kill -TERM -- "-$pane" 2>/dev/null
for p in $targets; do kill -TERM "$p" 2>/dev/null; kill -CONT "$p" 2>/dev/null; done
tmux -L "$sock" kill-session -t "=$session" 2>/dev/null
i=0
left="$targets"
while [ -n "$left" ] && [ $i -lt 30 ]; do
  next=""
  for p in $left; do alive "$p" && next="$next $p"; done
  left="$next"
  [ -n "$left" ] && sleep 0.1
  i=$((i + 1))
done
for p in $left; do kill -KILL "$p" 2>/dev/null; done
if [ "$keep" != 1 ]; then
  for p in $(marked); do
    eligible "$p" || continue
    case " $targets " in *" $p "*) continue ;; esac
    descs="$descs$(describe "$p")
"
    targets="$targets $p"
    kill -KILL "$p" 2>/dev/null
  done
fi
[ -n "$targets" ] && sleep 0.3
printf 'marker\\t%s\\n' "$marker"
printf '%s' "$descs" | while IFS= read -r line; do
  [ -n "$line" ] || continue
  p=\${line%%\t*}
  if alive "$p"; then printf 'survivor\\t%s\\n' "$line"; else printf 'killed\\t%s\\n' "$line"; fi
done
if tmux -L "$sock" has-session -t "=$session" 2>/dev/null; then printf 'session\\tpresent\\n'; else printf 'session\\tgone\\n'; fi
`;

/** At most this many processes are walked down from the tmux server before the tree counts as unread. */
export const ORPHAN_TREE_BOUND = 8192;

/**
 * Shell helpers both orphan scripts share, builtins only where they run per process. `statf PID` reads
 * /proc/PID/stat into `s_state`, `s_ppid` and `s_start`. `held_of` is " <pid>:<session> ..." for every descendant
 * of this server's tmux server, walked down from it through each thread's `children`: the session is the one whose
 * pane holds the process (`-` for none). `self_anc` is this script and its ancestors.
 *
 * `tree_bad` names why that walk cannot be trusted. "No server" is the local `TMUX_ABSENCE` rule only, on tmux's
 * non-zero exit: `no server running on`, or `error connecting to … (No such file or directory)`; and even then no
 * tmux process of this user may still name this socket (`-L <name>` or `-S <path>`): a socket file deleted under a
 * live server reads as "no server" while its seats still carry this server's PMUX_URL. Only `comm` tmux processes
 * have their argv read, and only their pids are printed. Every other tmux failure (a connect error such as
 * `(Permission denied)`), a server pid that is no number, a server or a walked process whose `stat` or `children`
 * cannot be read, or the walk's bound is a tree that was not read. A seat's agent then looks unheld, so nothing on
 * the host may be reaped.
 */
const ORPHAN_SCRIPT_HELPERS = `statf() {
  s_line=
  { read -r s_line < "/proc/$1/stat"; } 2>/dev/null || return 1
  [ -n "$s_line" ] || return 1
  s_rest=\${s_line##*) }
  set -- $s_rest
  s_state=$1; s_ppid=$2; s_start=\${20}
  [ -n "$s_start" ]
}
kids() {
  k=
  for f in /proc/"$1"/task/*/children; do
    if [ ! -r "$f" ]; then
      [ -e /proc/"$1" ] && return 1
      continue
    fi
    r=; { read -r r < "$f"; } 2>/dev/null
    k="$k $r"
  done
  return 0
}
no_server() {
  printf '%s\\n' "$1" | grep -Eq '^[[:space:]]*(no server running on |error connecting to .*\\(No such file or directory\\))'
}
tmux_failed() {
  tree_bad="tmux failed: $(printf '%s' "$1" | tr '\\t\\n' '  ' | cut -c1-200)"
}
uses_socket='NR == 1 { next }
w != "" { if ((w == "L" && $0 == n) || (w == "S" && $0 == s)) { hit = 1; exit } w = ""; next }
$0 == "--" || substr($0, 1, 1) != "-" || length($0) < 2 { exit }
{ o = substr($0, 2); for (i = 1; i <= length(o); i++) { ch = substr(o, i, 1); if (index("cfLST", ch)) { r = substr(o, i + 1); if (r == "") w = ch; else if ((ch == "L" && r == n) || (ch == "S" && r == s)) { hit = 1; exit }; break } } }
END { exit !hit }'
tree_bad=
srv=
out=$(tmux -L "$sock" display-message -p '#{pid}' 2>&1)
if [ $? -eq 0 ]; then
  case "$out" in ''|*[!0-9]*) tree_bad='tmux server pid unreadable' ;; *) srv=$out ;; esac
elif ! no_server "$out"; then
  tmux_failed "$out"
fi
tab=$(printf '\\t')
nl='
'
panes=" "
plist=
if [ -n "$srv" ]; then
  plist=$(tmux -L "$sock" list-panes -a -F '#{pane_pid} #{session_created} #{session_name}' 2>&1)
  if [ $? -ne 0 ]; then
    if no_server "$plist"; then srv=; else tmux_failed "$plist"; fi
    plist=
  fi
fi
spath=$(tmux -L "$sock" display-message -p '#{socket_path}' 2>/dev/null)
[ -n "$spath" ] || spath="\${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)/$sock"
if [ -z "$srv" ] && [ -z "$tree_bad" ]; then
  live=
  for d in /proc/[0-9]*; do
    [ -O "$d" ] || continue
    c=; { read -r c < "$d/comm"; } 2>/dev/null
    case "$c" in tmux|tmux:*) ;; *) continue ;; esac
    if tr '\\0' '\\n' 2>/dev/null < "$d/cmdline" | awk -v n="$sock" -v s="$spath" "$uses_socket"; then live="$live \${d#/proc/}"; fi
  done
  [ -n "$live" ] && tree_bad="socket gone, server alive (pid$live)"
fi
while read -r pp created sname; do
  [ -n "$pp" ] || continue
  case "$pp$created" in *[!0-9]*) tree_bad='tmux list-panes unreadable'; continue ;; esac
  panes="$panes$pp:$sname "
done <<PMUX_PANES
$plist
PMUX_PANES
held_of=" "
if [ -n "$srv" ]; then
  [ -r /proc/"$srv"/stat ] && [ -r /proc/"$srv"/task/"$srv"/children ] || tree_bad='process table unreadable'
fi
if [ -n "$srv" ] && [ -z "$tree_bad" ]; then
  front="$srv:-"; count=0
  while [ -n "$front" ] && [ -z "$tree_bad" ]; do
    next=
    for item in $front; do
      q=\${item%%:*}; lab=\${item#*:}
      case "$panes" in *" $q:"*) lab=\${panes#*" $q:"}; lab=\${lab%% *} ;; esac
      [ "$q" = "$srv" ] || held_of="$held_of$q:$lab "
      kids "$q" || { tree_bad='process table unreadable'; break; }
      for c in $k; do
        count=$((count + 1))
        [ $count -gt ${ORPHAN_TREE_BOUND} ] && { tree_bad='process inventory bound exceeded'; break; }
        next="$next $c:$lab"
      done
    done
    front=$next
  done
fi
self_anc=" $$ "
a=; statf $$ && a=$s_ppid
while [ -n "$a" ] && [ "$a" -gt 1 ] 2>/dev/null; do self_anc="$self_anc$a "; statf "$a" || break; a=$s_ppid; done
`;

/**
 * The orphan scan on a remote host (one `sh -s -- SOCKET URL` run): facts only, judged by `classifyOrphans` on this
 * server with the same rules as the local scan. A host without a readable /proc answers `unavailable`. The
 * candidates are the user's processes that carry PMUX_TAB_ID, carry this server's PMUX_URL, or run under its tmux
 * server; never this script, its ancestors, pid 1 or the tmux server. A marked one is reported when this server
 * started it: its PMUX_URL, its socket in TMUX, or its tmux server above it. An unmarked one only when it is an
 * agent; its environment is read for the presence of PMUX_TAB_ID and the PMUX_URL match, nothing else. No argv is
 * printed. Output, one line each, then `end`: `tree\tcomplete` or `tree\tunreadable\t<reason>`,
 * `session\t<age ms>\t<name>` and
 * `proc\t<pid>\t<ppid>\t<start>\t<age ms>\t<agent 0|1>\t<-|=tab id>\t<url 0|1>\t<socket 0|1>\t<under 0|1>\t<held>\t<above 0|1>\t<comm>\t<cwd>`,
 * where `above` is 1 when another agent sits between a held agent and its pane.
 */
export const REMOTE_ORPHAN_SCAN_SCRIPT = `sock=$1; url=$2
if [ ! -r /proc/self/stat ] || [ ! -r /proc/uptime ]; then printf 'unavailable\\nend\\n'; exit 0; fi
${ORPHAN_SCRIPT_HELPERS}if [ -n "$tree_bad" ]; then printf 'tree\\tunreadable\\t%s\\n' "$tree_bad"; else printf 'tree\\tcomplete\\n'; fi
now=$(date +%s)
hz=$(getconf CLK_TCK 2>/dev/null); [ -n "$hz" ] || hz=100
up=; { read -r up _ < /proc/uptime; } 2>/dev/null
frac=\${up#*.}; frac=\${frac#0}; [ -n "$frac" ] || frac=0
upms=$(( \${up%.*} * 1000 + frac * 10 ))
seen=" "
while read -r pp created sname; do
  [ -n "$sname" ] || continue
  case "$pp$created" in *[!0-9]*) continue ;; esac
  case "$seen" in *" $sname "*) continue ;; esac
  seen="$seen$sname "
  printf 'session\\t%s\\t%s\\n' "$(( (now - created) * 1000 ))" "$sname"
done <<PMUX_PANES
$plist
PMUX_PANES
agentof() {
  agent=0
  a_comm=; { read -r a_comm < "/proc/$1/comm"; } 2>/dev/null
  a_argv=$(tr '\\0' '\\n' 2>/dev/null < "/proc/$1/cmdline" | head -n 2)
  a_argv0=\${a_argv%%"$nl"*}; a_entry=
  case "$a_argv" in *"$nl"*) a_entry=\${a_argv#*"$nl"} ;; esac
  a_exe=\${a_argv0##*/}
  case "$a_exe" in claude|codex|grok) agent=1 ;; esac
  case "$a_comm" in claude|codex|grok) agent=1 ;; esac
  case "$a_exe" in node|bun) case "$a_entry" in */claude.js|*/codex.js|*/grok.js|*/@anthropic-ai/claude-code/*|*/@openai/codex/*|*/grok-cli/*) agent=1 ;; esac ;; esac
}
marked=$(grep -Hz '^PMUX_TAB_ID=' /proc/[0-9]*/environ 2>/dev/null | tr '\\n\\0' '?\\n' \\
  | sed -n -e 's#^/proc/\\([0-9][0-9]*\\)/environ:PMUX_TAB_ID=\\([A-Za-z0-9_.-]\\{1,128\\}\\)$#\\1=\\2#p;t' \\
    -e 's#^/proc/\\([0-9][0-9]*\\)/environ:PMUX_TAB_ID=.*#\\1=?#p')
tabs=" $(printf '%s' "$marked" | tr '\\n' ' ') "
urlpids=
[ -n "$url" ] && urlpids=$(grep -lzxF "PMUX_URL=$url" /proc/[0-9]*/environ 2>/dev/null | sed -n 's#^/proc/\\([0-9][0-9]*\\)/environ$#\\1#p')
urls=" $(printf '%s' "$urlpids" | tr '\\n' ' ') "
socks=" "
files=$(printf '%s\\n' "$marked" | sed -n 's#^\\([0-9][0-9]*\\)=.*#/proc/\\1/environ#p')
if [ -n "$files" ]; then
  esc=$(printf '%s' "$spath" | sed 's/[].[^$*\\\\]/\\\\&/g')
  socks=" $(grep -lz "^TMUX=$esc," $files 2>/dev/null | sed -n 's#^/proc/\\([0-9][0-9]*\\)/environ$#\\1#p' | tr '\\n' ' ') "
fi
cands=$( { printf '%s\\n' "$marked" | sed 's/=.*//'; printf '%s\\n' "$urlpids"; for e in $held_of; do printf '%s\\n' "\${e%%:*}"; done; } | sort -un)
for p in $cands; do
  case "$p" in ''|*[!0-9]*|1|"$srv") continue ;; esac
  case "$self_anc" in *" $p "*) continue ;; esac
  [ -O "/proc/$p" ] || continue
  statf "$p" || continue
  [ "$s_ppid" = "$$" ] && continue
  ppid=$s_ppid; start=$s_start
  tabf=-
  case "$tabs" in *" $p="*) v=\${tabs#*" $p="}; tabf="=\${v%% *}" ;; esac
  urlf=0; case "$urls" in *" $p "*) urlf=1 ;; esac
  sockf=0; case "$socks" in *" $p "*) sockf=1 ;; esac
  under=0; held=
  case "$held_of" in *" $p:"*) under=1; held=\${held_of#*" $p:"}; held=\${held%% *}; [ "$held" = - ] && held= ;; esac
  if [ "$tabf" = - ]; then
    [ $urlf = 1 ] || [ $under = 1 ] || continue
  else
    [ $urlf = 1 ] || [ $sockf = 1 ] || [ $under = 1 ] || continue
  fi
  agentof "$p"
  [ "$tabf" = - ] && [ $agent = 0 ] && continue
  isagent=$agent; comm=$a_comm
  above=0
  if [ $isagent = 1 ] && [ -n "$held" ]; then
    w=$ppid; n=0
    while [ -n "$w" ] && [ "$w" -gt 1 ] 2>/dev/null && [ $n -lt 128 ]; do
      agentof "$w"; [ $agent = 1 ] && { above=1; break; }
      case "$panes" in *" $w:"*) break ;; esac
      statf "$w" || break
      w=$s_ppid; n=$((n + 1))
    done
  fi
  case "$comm" in *"$tab"*) comm=$(printf '%s' "$comm" | tr '\\t' ' ') ;; esac
  cwd=$(readlink "/proc/$p/cwd" 2>/dev/null)
  case "$cwd" in *"$nl"*|*"$tab"*) cwd='?' ;; esac
  age=$(( upms - start * 1000 / hz ))
  [ $age -ge 0 ] || age=0
  printf 'proc\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$p" "$ppid" "$start" "$age" "$isagent" "$tabf" "$urlf" "$sockf" "$under" "$held" "$above" "$comm" "$cwd"
done
printf 'end\\n'
`;

/**
 * The orphan reap on a remote host (one `sh -s -- SOCKET PID:START...` run) for the (i)/(ii) entries this server
 * chose from a scan. The pane tree is read again first: when it cannot be read (`tree_bad`), every target is refused
 * `tree-unreadable` and nothing is signalled. Then each pid is checked again: never pid 0 or 1, this script or its
 * ancestors, the tmux server, another user's process, a pid whose start time changed, a process a live pane holds
 * (`held-by-session`), or one under the tmux server that no pane holds (`tree-unreadable`). Then the reap's steps:
 * SIGTERM (+ SIGCONT), up to 3 s of grace, SIGKILL, a settle. Output, one line each, then `end`: `killed\t<pid>`,
 * `survivor\t<pid>` or `refused\t<pid>\t<protected|identity-changed|held-by-session|tree-unreadable>`.
 */
export const REMOTE_ORPHAN_REAP_SCRIPT = `sock=$1; shift
if [ ! -r /proc/self/stat ]; then for t in "$@"; do printf 'refused\\t%s\\ttree-unreadable\\n' "\${t%%:*}"; done; printf 'end\\n'; exit 0; fi
${ORPHAN_SCRIPT_HELPERS}same() { statf "$1" && [ "$s_start" = "$2" ] && [ "$s_state" != Z ] && [ "$s_state" != X ]; }
if [ -n "$tree_bad" ]; then
  for t in "$@"; do printf 'refused\\t%s\\ttree-unreadable\\n' "\${t%%:*}"; done
  printf 'end\\n'
  exit 0
fi
targets=""
for t in "$@"; do
  p=\${t%%:*}; want=\${t#*:}
  case "$p" in ''|*[!0-9]*|0|1|"$srv") printf 'refused\\t%s\\tprotected\\n' "$p"; continue ;; esac
  case "$self_anc" in *" $p "*) printf 'refused\\t%s\\tprotected\\n' "$p"; continue ;; esac
  [ -O "/proc/$p" ] || { printf 'refused\\t%s\\tprotected\\n' "$p"; continue; }
  same "$p" "$want" || { printf 'refused\\t%s\\tidentity-changed\\n' "$p"; continue; }
  case "$held_of" in *" $p:"*)
    h=\${held_of#*" $p:"}
    if [ "\${h%% *}" = - ]; then printf 'refused\\t%s\\ttree-unreadable\\n' "$p"; else printf 'refused\\t%s\\theld-by-session\\n' "$p"; fi
    continue ;;
  esac
  targets="$targets $p:$want"
done
for t in $targets; do
  p=\${t%%:*}; want=\${t#*:}
  same "$p" "$want" && { kill -TERM "$p" 2>/dev/null; kill -CONT "$p" 2>/dev/null; }
done
left="$targets"; i=0
while [ -n "$left" ] && [ $i -lt 30 ]; do
  next=""
  for t in $left; do same "\${t%%:*}" "\${t#*:}" && next="$next $t"; done
  left=$next
  [ -n "$left" ] && sleep 0.1
  i=$((i + 1))
done
for t in $left; do same "\${t%%:*}" "\${t#*:}" && kill -KILL "\${t%%:*}" 2>/dev/null; done
[ -n "$left" ] && sleep 0.3
i=0
while [ $i -lt 7 ]; do
  next=""
  for t in $left; do same "\${t%%:*}" "\${t#*:}" && next="$next $t"; done
  left=$next
  [ -n "$left" ] || break
  sleep 0.1
  i=$((i + 1))
done
for t in $targets; do
  case " $left " in *" $t "*) printf 'survivor\\t%s\\n' "\${t%%:*}" ;; *) printf 'killed\\t%s\\n' "\${t%%:*}" ;; esac
done
printf 'end\\n'
`;

/**
 * The remote twin of `observeProviderProcess` (ADR-0021 strict identity,
 * ADR-0022 slice b), as one `sh -s -- SOCKET SESSION PROVIDER` run: the
 * session's one pane, then the pane's descendants (bounded at 512) for the
 * provider's executable, `comm`, or a node/bun entrypoint. Output, one line:
 * `present\t<pane id>\t<pane pid>\t<pid>\t<start time>`, `absent\t<reason>` or
 * `unknown\t<reason>`. tmux's own "no such session" is absent. A walk can prove an absence only over a process table it
 * can read: the pane process's `stat` and its task `children` file (a kernel without CONFIG_PROC_CHILDREN has none),
 * else `unknown` (ADR-0049 §3: recovery moves a coordinator only on a positive absence). A
 * descendant the walk lists but cannot read (hidepid, another uid) is `unknown` too: it may be the agent.
 */
export const REMOTE_PROVIDER_SCRIPT = `sock=$1; session=$2; want=$3
out=$(tmux -L "$sock" list-panes -t "=$session:" -F '#{session_name}\t#{pane_id}\t#{pane_pid}' 2>&1)
rc=$?
if [ $rc -ne 0 ]; then
  case "$out" in *"can't find"*|*"no server running"*|*"No such file or directory"*) printf 'absent\tsession gone\n' ;; *) printf 'unknown\ttmux failed\n' ;; esac
  exit 0
fi
[ "$(printf '%s\n' "$out" | wc -l)" -eq 1 ] || { printf 'unknown\tsession identity ambiguous\n'; exit 0; }
name=$(printf '%s' "$out" | cut -f1); pane=$(printf '%s' "$out" | cut -f2); root=$(printf '%s' "$out" | cut -f3)
[ "$name" = "$session" ] || { printf 'unknown\tsession identity changed\n'; exit 0; }
check() {
  if [ "$2" = child ] && { [ ! -r /proc/"$1"/comm ] || [ ! -r /proc/"$1"/cmdline ]; }; then
    printf 'unknown\tprocess %s unreadable\n' "$1"; exit 0
  fi
  comm=$(cat /proc/"$1"/comm 2>/dev/null)
  argv0=$(tr '\\0' '\\n' < /proc/"$1"/cmdline 2>/dev/null | sed -n 1p)
  entry=$(tr '\\0' '\\n' < /proc/"$1"/cmdline 2>/dev/null | sed -n 2p)
  exe=\${argv0##*/}
  match=0
  if [ "$exe" = "$want" ] || [ "$comm" = "$want" ]; then match=1; fi
  case "$exe" in node|bun) case "$entry" in */"$want".js|*/@anthropic-ai/claude-code/*) match=1 ;; esac ;; esac
  [ $match -eq 1 ] || return 0
  start=$(sed 's/.*) //' /proc/"$1"/stat 2>/dev/null | cut -d' ' -f20)
  [ -n "$start" ] || { printf 'unknown\tprocess start identity unavailable\n'; exit 0; }
  printf 'present\t%s\t%s\t%s\t%s\n' "$pane" "$root" "$1" "$start"
  exit 0
}
check "$root"
[ -r /proc/"$root"/stat ] && [ -r /proc/"$root"/task/"$root"/children ] || { printf 'unknown\tprocess table unreadable\n'; exit 0; }
frontier=$root; seen=0
while [ -n "$frontier" ]; do
  next=""
  for p in $frontier; do
    for c in $(cat /proc/"$p"/task/*/children 2>/dev/null); do
      seen=$((seen + 1))
      [ $seen -gt 512 ] && { printf 'unknown\tprocess inventory bound exceeded\n'; exit 0; }
      next="$next $c"
      check "$c" child
    done
  done
  frontier=$next
done
printf 'absent\tno %s process in the pane\n' "$want"
`;

/**
 * The readiness captures of several remote panes in one `sh -s -- SOCKET NONCE SESSION...` run (vel-PMX-FU): one ssh
 * per host, never one per tab. Each pane prints a header line `<nonce> ok <session>` and its visible content
 * (`capture-pane -p -e`, as the local probe reads it), or `<nonce> gone <session>`; the run ends with `<nonce> end`.
 * The nonce is random per call, so no pane text can pass as a header.
 */
export const REMOTE_CAPTURE_SCRIPT = `sock=$1; nonce=$2; shift 2
for s in "$@"; do
  if out=$(tmux -L "$sock" capture-pane -p -e -t "=$s:" 2>/dev/null); then
    printf '%s ok %s\\n' "$nonce" "$s"
    printf '%s\\n' "$out"
  else
    printf '%s gone %s\\n' "$nonce" "$s"
  fi
done
printf '%s end\\n' "$nonce"
`;

/** Session → its pane text, or null when tmux could not capture it. Null overall when the run did not finish. */
export const parseRemoteCaptures = (stdout: string, nonce: string): Map<string, string | null> | null => {
  const lines = stdout.split('\n');
  const result = new Map<string, string | null>();
  let current: string | null = null;
  let body: string[] = [];
  const close = () => {
    if (current !== null) result.set(current, `${body.join('\n')}\n`);
    current = null;
    body = [];
  };
  for (const line of lines) {
    if (line === `${nonce} end`) {
      close();
      return result;
    }
    if (line.startsWith(`${nonce} ok `)) {
      close();
      current = line.slice(nonce.length + 4);
      continue;
    }
    if (line.startsWith(`${nonce} gone `)) {
      close();
      result.set(line.slice(nonce.length + 6), null);
      continue;
    }
    if (current !== null) body.push(line);
  }
  return null;
};

export type TRemoteProviderObservation =
  | { state: 'present'; paneId: string; panePid: string; pid: string; start: string }
  | { state: 'absent' | 'unknown'; reason: string };

export const parseRemoteProviderObservation = (stdout: string): TRemoteProviderObservation => {
  const [kind, ...rest] = stdout.trim().split('\n').at(-1)?.split('\t') ?? [];
  if (kind === 'present' && rest.length === 4 && rest.every(Boolean)) {
    return { state: 'present', paneId: rest[0], panePid: rest[1], pid: rest[2], start: rest[3] };
  }
  if (kind === 'absent') return { state: 'absent', reason: rest.join(' ') || 'absent' };
  return { state: 'unknown', reason: kind === 'unknown' ? rest.join(' ') : 'unreadable remote observation' };
};

export const reapCommand = (session: string, tabId: string | undefined, keepProcesses: boolean): string =>
  ['sh', '-s', '--', remoteSocketName(), session, tabId ?? '', keepProcesses || !tabId ? '1' : '0', originName()].map(shQuote).join(' ');

/** Whether `dir` is a directory on `host`. Throws `RemoteHostError` when ssh fails. */
export const remoteDirExists = async (host: string, dir: string): Promise<boolean> => {
  try {
    await runSsh(host, `test -d ${shQuote(dir)}`, { timeoutMs: 10_000 });
    return true;
  } catch (err) {
    if (isSshFailure(err)) throw new RemoteHostError(host, `remote host ${host} did not answer over ssh (${describeRemoteFailure(err)})`);
    return false;
  }
};

export interface IRemoteReapResult extends IReapResult {
  sessionGone: boolean;
}


const toProcess = (fields: string[]): IReapedProcess | null => {
  const pid = Number(fields[0]);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return { pid, comm: fields[1] ?? '', args: (fields.slice(2).join('\t') ?? '').trim() };
};

export const parseRemoteReap = (stdout: string): IRemoteReapResult => {
  const result: IRemoteReapResult = { reaper: 'remote', envMarker: 'unknown', killed: [], survivors: [], sessionGone: false };
  for (const line of stdout.split('\n')) {
    const [kind, ...rest] = line.split('\t');
    if (kind === 'marker' && (rest[0] === 'present' || rest[0] === 'absent')) result.envMarker = rest[0];
    else if (kind === 'killed' || kind === 'survivor') {
      const proc = toProcess(rest);
      if (proc) (kind === 'killed' ? result.killed : result.survivors).push(proc);
    } else if (kind === 'session') result.sessionGone = rest[0] === 'gone';
  }
  return result;
};

const intOf = (raw: string | undefined): number | null => {
  const n = Number(raw);
  return raw !== undefined && raw !== '' && Number.isInteger(n) ? n : null;
};

/**
 * The facts of a remote orphan scan: `unavailable` for a host without /proc; null when the run ended before its
 * `end` line. A run that never said its tree was complete counts as a tree that was not read.
 */
export const parseRemoteOrphanScan = (stdout: string): IOrphanHostFacts | 'unavailable' | null => {
  const lines = stdout.split('\n');
  if (!lines.some((line) => line === 'end')) return null;
  if (lines.some((line) => line === 'unavailable')) return 'unavailable';
  const facts: IOrphanHostFacts = { tree: { complete: false, reason: 'the scan reported no tree' }, sessions: [], processes: [] };
  for (const line of lines) {
    const fields = line.split('\t');
    if (fields[0] === 'tree') {
      facts.tree = fields[1] === 'complete' ? { complete: true } : { complete: false, reason: fields.slice(2).join(' ') || 'tree unreadable' };
    } else if (fields[0] === 'session' && fields.length >= 3) {
      const ageMs = intOf(fields[1]);
      const name = fields.slice(2).join('\t');
      if (ageMs !== null && name) facts.sessions.push({ name, ageMs: Math.max(0, ageMs) });
    } else if (fields[0] === 'proc' && fields.length >= 14) {
      const [, pidRaw, ppidRaw, start, ageRaw, agent, tab, url, sock, under, held, above, comm, ...cwd] = fields;
      const pid = intOf(pidRaw);
      const ageMs = intOf(ageRaw);
      if (pid === null || pid <= 1 || ageMs === null || !/^\d+$/.test(start)) continue;
      facts.processes.push({
        pid,
        ppid: intOf(ppidRaw) ?? 0,
        comm,
        ageMs,
        cwd: cwd.join('\t') || null,
        start,
        tabId: tab.startsWith('=') ? tab.slice(1) || '?' : null,
        urlMatch: url === '1',
        socketMatch: sock === '1',
        underServer: under === '1',
        heldBy: held || null,
        heldKnown: true,
        agentAbove: above === '1',
        agent: agent === '1',
      });
    }
  }
  return facts;
};

export type TRemoteOrphanRefusal = 'protected' | 'identity-changed' | 'held-by-session' | 'tree-unreadable';

export interface IRemoteOrphanReap {
  killed: number[];
  survivors: number[];
  refused: Array<{ pid: number; refusal: TRemoteOrphanRefusal }>;
}

const REMOTE_REFUSALS: ReadonlySet<string> = new Set(['identity-changed', 'held-by-session', 'tree-unreadable']);

/** A remote orphan reap's answer; null when the run ended before its `end` line. */
export const parseRemoteOrphanReap = (stdout: string): IRemoteOrphanReap | null => {
  const lines = stdout.split('\n');
  if (!lines.some((line) => line === 'end')) return null;
  const result: IRemoteOrphanReap = { killed: [], survivors: [], refused: [] };
  for (const line of lines) {
    const [kind, pidRaw, reason] = line.split('\t');
    const pid = intOf(pidRaw);
    if (pid === null) continue;
    if (kind === 'killed') result.killed.push(pid);
    else if (kind === 'survivor') result.survivors.push(pid);
    else if (kind === 'refused') result.refused.push({ pid, refusal: REMOTE_REFUSALS.has(reason) ? reason as TRemoteOrphanRefusal : 'protected' });
  }
  return result;
};

export const orphanScanCommand = (url: string): string =>
  ['sh', '-s', '--', remoteSocketName(), url].map(shQuote).join(' ');

export const orphanReapCommand = (targets: ReadonlyArray<{ pid: number; start: string }>): string =>
  ['sh', '-s', '--', remoteSocketName(), ...targets.map((t) => `${t.pid}:${t.start}`)].map(shQuote).join(' ');
