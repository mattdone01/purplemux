#!/usr/bin/env node
// purplemux CLI — workspace-scoped HTTP API wrapper
// Falls back to ~/.purplemux/{port,cli-token} when env vars absent.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const readFileOrNull = (file) => {
  try {
    return fs.readFileSync(file, 'utf-8').trim() || null;
  } catch {
    return null;
  }
};

const PORT = process.env.PMUX_PORT || readFileOrNull(path.join(os.homedir(), '.purplemux', 'port'));
const ENV_TOKEN = process.env.PMUX_TOKEN || null;
const ADMIN_TOKEN = readFileOrNull(path.join(os.homedir(), '.purplemux', 'cli-token'));
const BASE = `http://localhost:${PORT}`;

/**
 * The token to present for a request against `requestPath`.
 *
 * `send` and `steer` accept ONLY a token scoped to the target workspace, so
 * that a tab cannot type into another epic's worker. That rule would also
 * catch a human shell, which holds the global token and belongs to no
 * workspace — so when nothing scoped us, resolve the token of the workspace
 * the command already named in `-w` and present that.
 *
 * The order is the whole point. `PMUX_TOKEN` wins whenever it is set, which is
 * exactly the case of a command running INSIDE a tab: it stays confined to its
 * own workspace and never picks up a neighbour's token from disk. The lookup
 * below is reached only by a caller that was never scoped to begin with.
 */
const workspaceTokenFor = (workspaceId) => {
  if (!workspaceId) return null;
  try {
    const file = path.join(os.homedir(), '.purplemux', 'workspace-tokens.json');
    return JSON.parse(fs.readFileSync(file, 'utf-8'))[workspaceId] || null;
  } catch {
    return null;
  }
};

const tokenFor = (requestPath) => {
  if (ENV_TOKEN) return ENV_TOKEN;
  const match = /[?&]workspaceId=([^&]+)/.exec(requestPath || '');
  const workspaceId = match ? decodeURIComponent(match[1]) : null;
  return workspaceTokenFor(workspaceId) || ADMIN_TOKEN;
};

const die = (msg) => {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
};

const requireEnv = () => {
  if (!PORT) die('PMUX_PORT not set and ~/.purplemux/port missing (is the server running?)');
  if (!ENV_TOKEN && !ADMIN_TOKEN) die('PMUX_TOKEN not set and ~/.purplemux/cli-token missing (is the server running?)');
};

const out = (body) => {
  process.stdout.write(JSON.stringify(body, null, 2) + '\n');
};

const api = async (method, path, data) => {
  const url = `${BASE}${path}`;
  const opts = {
    method,
    headers: { 'X-Pmux-Token': tokenFor(path), 'Content-Type': 'application/json' },
  };
  if (data !== undefined) opts.body = JSON.stringify(data);
  const resp = await fetch(url, opts);
  const body = resp.headers.get('content-type')?.includes('json')
    ? await resp.json()
    : null;
  if (!resp.ok) {
    const msg = body?.error || `HTTP ${resp.status}`;
    die(msg);
  }
  return { resp, body };
};

const apiRaw = async (method, path) => {
  const url = `${BASE}${path}`;
  const resp = await fetch(url, {
    method,
    headers: { 'X-Pmux-Token': tokenFor(path) },
  });
  if (!resp.ok) {
    const ct = resp.headers.get('content-type') || '';
    if (ct.includes('json')) {
      const body = await resp.json();
      die(body?.error || `HTTP ${resp.status}`);
    }
    die(`HTTP ${resp.status}`);
  }
  return resp;
};

const cmdWorkspaces = async () => {
  requireEnv();
  const { body } = await api('GET', '/api/cli/workspaces');
  out(body);
};

const cmdTabList = async (args) => {
  requireEnv();
  const wsId = flagValue(args, '--workspace') || flagValue(args, '-w');
  const qs = wsId ? `?workspaceId=${encodeURIComponent(wsId)}` : '';
  const { body } = await api('GET', `/api/cli/tabs${qs}`);
  out(body);
};

const cmdWorkspaceDirs = async (args) => {
  requireEnv();
  const sub = args[0];
  const rest = args.slice(1);
  const wsId = flagValue(rest, '--workspace') || flagValue(rest, '-w');
  if (!wsId) die('--workspace is required');
  const path = `/api/cli/workspaces/${wsId}/directories`;
  if (sub === 'show') {
    const { body } = await api('GET', path);
    return out(body);
  }
  if (sub === 'set') {
    // Resolve here, not server-side: a relative path would otherwise be
    // resolved against the server's cwd rather than the caller's.
    const directories = stripFlags(rest, ['--workspace', '-w']).map((d) => require('path').resolve(d));
    if (!directories.length) die('at least one DIR is required');
    const { body } = await api('PATCH', path, { directories });
    return out(body);
  }
  die('usage: workspace dirs show|set -w WS [DIR...]');
};

const cmdWorkspacePeers = async (args) => {
  requireEnv();
  const sub = args[0];
  const rest = args.slice(1);
  const wsId = flagValue(rest, '--workspace') || flagValue(rest, '-w');
  if (!wsId) die('--workspace is required');
  const path = `/api/cli/workspaces/${wsId}/peers`;
  if (sub === 'show') {
    const { body } = await api('GET', path);
    return out(body);
  }
  if (sub === 'set') {
    const allowedPeers = stripFlags(rest, ['--workspace', '-w']);
    const { body } = await api('PATCH', path, { allowedPeers });
    return out(body);
  }
  die('usage: workspace peers show|set -w WS [PEER_WS_ID...]');
};

const deriveOwnTabId = () => {
  try {
    const session = require('child_process').execSync("tmux display-message -p '#{session_name}'", { encoding: 'utf8' }).trim();
    const m = session.match(/^pt-ws-.*-(tab-.+)$/);
    return m ? m[1] : null;
  } catch { return null; }
};

const cmdOrchestration = async (args) => {
  requireEnv();
  const sub = args[0];
  const rest = args.slice(1);
  const wsId = flagValue(rest, '--workspace') || flagValue(rest, '-w');
  if (!wsId) die('--workspace is required');
  if (sub === 'status') {
    const { body } = await api('GET', `/api/cli/workspaces/${wsId}/orchestration`);
    return out(body);
  }
  if (sub === 'off') {
    const { body } = await api('PATCH', `/api/cli/workspaces/${wsId}/orchestration`, { enabled: false });
    return out(body);
  }
  if (sub === 'on') {
    const positional = stripFlags(rest, ['--workspace', '-w']);
    const tabId = positional[0] || deriveOwnTabId();
    if (!tabId) die('TAB_ID required (or run inside a purplemux tab to self-designate)');
    const { body } = await api('PATCH', `/api/cli/workspaces/${wsId}/orchestration`, { enabled: true, orchestratorTabId: tabId });
    return out(body);
  }
  die("usage: orchestration status|on|off -w WS [TAB_ID]");
};

const cmdStandup = async (args) => {
  requireEnv();
  const sub = args[0];
  const rest = args.slice(1);
  const wsId = flagValue(rest, '--workspace') || flagValue(rest, '-w');
  if (!wsId) die('--workspace is required');
  if (sub === 'show') {
    const { body } = await api('GET', `/api/cli/workspaces/${wsId}/standup`);
    return out(body);
  }
  if (sub === 'report') {
    const raw = flagValue(rest, '--json') || await readStdin();
    let report;
    try { report = JSON.parse(raw); } catch { die("standup report must be valid JSON — pass --json '{...}' or pipe JSON on stdin"); }
    const { body } = await api('POST', `/api/cli/workspaces/${wsId}/standup`, report);
    return out(body);
  }
  die("usage: standup report -w WS --json '{...}' | standup show -w WS");
};

const cmdTabCreate = async (args) => {
  requireEnv();
  const wsId = flagValue(args, '--workspace') || flagValue(args, '-w');
  const name = flagValue(args, '--name') || flagValue(args, '-n');
  const panelType = flagValue(args, '--type') || flagValue(args, '-t');
  const model = flagValue(args, '--model') || flagValue(args, '-m');
  const reasoning = flagValue(args, '--reasoning') || flagValue(args, '-r');
  const noLaunch = args.includes('--no-launch');
  // Comma-separated path globs the tab is expected to edit. purplemux reports
  // edits outside them; it never infers the list.
  const scopeRaw = flagValue(args, '--scope');
  const scope = scopeRaw ? scopeRaw.split(',').map((s) => s.trim()).filter(Boolean) : null;
  if (!wsId) die('--workspace is required');
  const { body } = await api('POST', '/api/cli/tabs', {
    workspaceId: wsId,
    ...(name ? { name } : {}),
    ...(panelType ? { panelType } : {}),
    ...(model ? { model } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(noLaunch ? { launch: false } : {}),
    ...(scope && scope.length ? { scope } : {}),
  });
  out(body);
};

const resolveWsForTab = (args) => {
  const wsId = flagValue(args, '--workspace') || flagValue(args, '-w');
  if (!wsId) die('--workspace is required');
  return wsId;
};

const readStdin = () => new Promise((resolve, reject) => {
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { data += chunk; });
  process.stdin.on('end', () => resolve(data));
  process.stdin.on('error', reject);
});

// Same shape as tab send, but interrupts the current turn first so a busy
// worker reads the correction now instead of after its tangent finishes.
const cmdTabSteer = async (args) => {
  requireEnv();
  const file = flagValue(args, '--file') || flagValue(args, '-f');
  const noInterrupt = args.includes('--no-interrupt');
  const rest = stripBooleanFlags(stripFlags(args, ['--workspace', '-w', '--file', '-f']), ['--no-interrupt']);
  const tabId = rest[0];
  let content = rest.slice(1).join(' ');
  if (!tabId) die('tab ID is required');
  if (file) {
    content = file === '-' ? await readStdin() : require('fs').readFileSync(file, 'utf8');
  }
  if (!content) die('content is required (args, -f FILE, or -f - for stdin)');
  const wsId = resolveWsForTab(args);
  const { body } = await api(
    'POST',
    `/api/cli/tabs/${tabId}/steer?workspaceId=${encodeURIComponent(wsId)}`,
    { content, ...(noInterrupt ? { interrupt: false } : {}) },
  );
  out(body);
};

// The send waits for the target to reach a state that can accept a turn. An
// agent TUI that is still booting swallows the Enter after the paste, so a
// send that does not wait can report success over an agent that never starts.
const cmdTabSend = async (args) => {
  requireEnv();
  const file = flagValue(args, '--file') || flagValue(args, '-f');
  const waitMs = flagValue(args, '--wait-ms');
  const noWait = args.includes('--no-wait');
  const rest = stripBooleanFlags(
    stripFlags(args, ['--workspace', '-w', '--file', '-f', '--wait-ms']),
    ['--no-wait'],
  );
  const tabId = rest[0];
  let content = rest.slice(1).join(' ');
  if (!tabId) die('tab ID is required');
  if (file) {
    content = file === '-' ? await readStdin() : require('fs').readFileSync(file, 'utf8');
  }
  if (!content) die('content is required (args, -f FILE, or -f - for stdin)');
  const waitMsGiven = args.includes('--wait-ms');
  if (noWait && waitMsGiven) die('--no-wait and --wait-ms are mutually exclusive');
  // `--wait-ms` as the last token leaves no value to read; falling back to the
  // default would silently wait 60s for a caller that asked for something else.
  if (waitMsGiven && (waitMs === null || !/^\d+$/.test(waitMs))) {
    die('--wait-ms must be a whole number of milliseconds');
  }
  const wsId = resolveWsForTab(args);
  const { body } = await api(
    'POST',
    `/api/cli/tabs/${tabId}/send?workspaceId=${encodeURIComponent(wsId)}`,
    { content, ...(noWait ? { waitMs: 0 } : waitMs ? { waitMs: Number(waitMs) } : {}) },
  );
  out(body);
};

const cmdTabStatus = async (args) => {
  requireEnv();
  const rest = stripFlags(args, ['--workspace', '-w']);
  const tabId = rest[0];
  if (!tabId) die('tab ID is required');
  const wsId = resolveWsForTab(args);
  const { body } = await api(
    'GET',
    `/api/cli/tabs/${tabId}/status?workspaceId=${encodeURIComponent(wsId)}`,
  );
  out(body);
};

const cmdTabResult = async (args) => {
  requireEnv();
  const rest = stripFlags(args, ['--workspace', '-w']);
  const tabId = rest[0];
  if (!tabId) die('tab ID is required');
  const wsId = resolveWsForTab(args);
  const { body } = await api(
    'GET',
    `/api/cli/tabs/${tabId}/result?workspaceId=${encodeURIComponent(wsId)}`,
  );
  out(body);
};

const cmdTabClose = async (args) => {
  requireEnv();
  const rest = stripFlags(args, ['--workspace', '-w']);
  const tabId = rest[0];
  if (!tabId) die('tab ID is required');
  const wsId = resolveWsForTab(args);
  const { resp } = await api(
    'DELETE',
    `/api/cli/tabs/${tabId}?workspaceId=${encodeURIComponent(wsId)}`,
  );
  if (resp.ok) process.stdout.write('ok\n');
};

// Liveness probes: the watchdog runs --cmd on an interval; its last stdout line
// must print seconds-since-last-progress. Above --stale-after, the orchestrator
// gets a STALLED nudge and the human gets a push alert.
const cmdTabProbe = async (args) => {
  requireEnv();
  const sub = args[0];
  const rest = stripFlags(args.slice(1), ['--workspace', '-w', '--cmd', '--stale-after', '--interval', '--label']);
  const tabId = rest[0];
  if (!sub) die('probe subcommand required (set | list | clear)');
  if (!tabId) die('tab ID is required');
  const wsId = resolveWsForTab(args);
  const qs = `workspaceId=${encodeURIComponent(wsId)}`;

  switch (sub) {
    case 'set': {
      const command = flagValue(args, '--cmd');
      const staleAfter = flagValue(args, '--stale-after');
      const interval = flagValue(args, '--interval');
      const label = flagValue(args, '--label');
      if (!command) die('--cmd is required');
      if (!staleAfter || !/^\d+$/.test(staleAfter)) die('--stale-after SECS is required (whole seconds)');
      if (interval && !/^\d+$/.test(interval)) die('--interval must be whole seconds');
      const { body } = await api('POST', `/api/cli/tabs/${tabId}/probe?${qs}`, {
        command,
        stalenessThresholdS: Number(staleAfter),
        ...(interval ? { intervalS: Number(interval) } : {}),
        ...(label ? { label } : {}),
      });
      return out(body);
    }
    case 'list': {
      const { body } = await api('GET', `/api/cli/tabs/${tabId}/probe?${qs}`);
      return out(body);
    }
    case 'clear': {
      const label = flagValue(args, '--label');
      const path = `/api/cli/tabs/${tabId}/probe?${qs}${label ? `&label=${encodeURIComponent(label)}` : ''}`;
      const { body } = await api('DELETE', path);
      return out(body);
    }
    default:
      die(`unknown probe subcommand: ${sub}. Use set | list | clear`);
  }
};

// Background job watch: when the pid exits, the orchestrator gets a nudge with
// the exit code (from --exit-file) and a stderr tail (from --stderr).
const cmdTabBg = async (args) => {
  requireEnv();
  const sub = args[0];
  const rest = stripFlags(args.slice(1), ['--workspace', '-w', '--pid', '--label', '--stderr', '--exit-file']);
  const tabId = rest[0];
  if (!sub) die('bg subcommand required (add | list | remove)');
  if (!tabId) die('tab ID is required');
  const wsId = resolveWsForTab(args);
  const qs = `workspaceId=${encodeURIComponent(wsId)}`;

  switch (sub) {
    case 'add': {
      const pid = flagValue(args, '--pid');
      const label = flagValue(args, '--label');
      const stderrFile = flagValue(args, '--stderr');
      const exitCodeFile = flagValue(args, '--exit-file');
      if (!pid || !/^\d+$/.test(pid)) die('--pid N is required');
      const { body } = await api('POST', `/api/cli/tabs/${tabId}/bg?${qs}`, {
        pid: Number(pid),
        ...(label ? { label } : {}),
        ...(stderrFile ? { stderrFile: require('path').resolve(stderrFile) } : {}),
        ...(exitCodeFile ? { exitCodeFile: require('path').resolve(exitCodeFile) } : {}),
      });
      return out(body);
    }
    case 'list': {
      const { body } = await api('GET', `/api/cli/tabs/${tabId}/bg?${qs}`);
      return out(body);
    }
    case 'remove': {
      const pid = flagValue(args, '--pid');
      if (pid && !/^\d+$/.test(pid)) die('--pid must be a whole number');
      const path = `/api/cli/tabs/${tabId}/bg?${qs}${pid ? `&pid=${pid}` : ''}`;
      const { body } = await api('DELETE', path);
      return out(body);
    }
    default:
      die(`unknown bg subcommand: ${sub}. Use add | list | remove`);
  }
};

const cmdTabBrowser = async (args) => {
  requireEnv();
  const sub = args[0];
  const rest = stripFlags(args.slice(1), ['--workspace', '-w', '-o', '--since', '--level', '--method', '--url', '--status', '--request', '--full']);
  const tabId = rest[0];
  if (!sub) die('browser subcommand required (url | screenshot | console | network | eval)');
  if (!tabId) die('tab ID is required');
  const wsId = resolveWsForTab(args);
  const qs = `workspaceId=${encodeURIComponent(wsId)}`;

  switch (sub) {
    case 'url': {
      const { body } = await api('GET', `/api/cli/tabs/${tabId}/browser/url?${qs}`);
      out(body);
      return;
    }
    case 'screenshot': {
      const outPath = flagValue(args, '-o') || flagValue(args, '--output');
      const full = args.includes('--full') ? '1' : '0';
      const path = `/api/cli/tabs/${tabId}/browser/screenshot?${qs}&full=${full}`;
      if (outPath) {
        const resp = await apiRaw('GET', path);
        const buf = Buffer.from(await resp.arrayBuffer());
        fs.writeFileSync(outPath, buf);
        out({ saved: outPath, bytes: buf.byteLength });
      } else {
        const { body } = await api('GET', `${path}&format=base64`);
        out(body);
      }
      return;
    }
    case 'console': {
      const since = flagValue(args, '--since');
      const level = flagValue(args, '--level');
      const params = [qs];
      if (since) params.push(`since=${encodeURIComponent(since)}`);
      if (level) params.push(`level=${encodeURIComponent(level)}`);
      const { body } = await api('GET', `/api/cli/tabs/${tabId}/browser/console?${params.join('&')}`);
      out(body);
      return;
    }
    case 'network': {
      const since = flagValue(args, '--since');
      const method = flagValue(args, '--method');
      const urlFilter = flagValue(args, '--url');
      const status = flagValue(args, '--status');
      const requestId = flagValue(args, '--request');
      const params = [qs];
      if (requestId) params.push(`requestId=${encodeURIComponent(requestId)}`);
      if (since) params.push(`since=${encodeURIComponent(since)}`);
      if (method) params.push(`method=${encodeURIComponent(method)}`);
      if (urlFilter) params.push(`url=${encodeURIComponent(urlFilter)}`);
      if (status) params.push(`status=${encodeURIComponent(status)}`);
      const { body } = await api('GET', `/api/cli/tabs/${tabId}/browser/network?${params.join('&')}`);
      out(body);
      return;
    }
    case 'eval': {
      const expression = rest.slice(1).join(' ');
      if (!expression) die('expression is required');
      const { body } = await api('POST', `/api/cli/tabs/${tabId}/browser/eval?${qs}`, { expression });
      out(body);
      return;
    }
    default:
      die(`unknown browser subcommand: ${sub}. Use url | screenshot | console | network | eval`);
  }
};

const cmdApiGuide = async () => {
  requireEnv();
  const resp = await fetch(`${BASE}/api/cli/api-guide`, {
    headers: { 'X-Pmux-Token': tokenFor(path) },
  });
  if (!resp.ok) die(`HTTP ${resp.status}`);
  process.stdout.write((await resp.text()) + '\n');
};

const flagValue = (args, name) => {
  const idx = args.indexOf(name);
  if (idx === -1 || idx + 1 >= args.length) return null;
  return args[idx + 1];
};

// Boolean flags carry no value, so stripFlags — which drops a flag AND the
// token after it — would eat the first word of the content.
const stripBooleanFlags = (args, names) => args.filter((arg) => !names.includes(arg));

const stripFlags = (args, names) => {
  const result = [];
  let i = 0;
  while (i < args.length) {
    if (names.includes(args[i])) {
      i += 2;
    } else {
      result.push(args[i]);
      i++;
    }
  }
  return result;
};

const usage = () => {
  process.stdout.write(`purplemux CLI

Usage: purplemux <command> [args...]

Commands:
  workspaces                               List workspaces
  workspace dirs show -w WS                Show a workspace's directories
  workspace dirs set -w WS DIR [DIR...]    Repoint a workspace. The first DIR is the primary: it is the cwd for
                                           new tabs and keys the agent chat store, and must be unique across
                                           workspaces. Later DIRs are navigation shortcuts and may overlap.
                                           Paths are resolved against your cwd; existing tabs keep their old cwd
  workspace peers show -w WS               Show which workspaces may reach into WS
  workspace peers set -w WS [PEER...]      Replace that list (global token only — an agent cannot
                                           widen its own scope). Grants are one-directional; pass
                                           no PEER to revoke all
  tab list [-w WS]                         List tabs (only those your token may act on)
  tab create -w WS [-n NAME] [-t TYPE] [--scope GLOBS]
                                           Create a tab in workspace (type: terminal | claude-code | codex-cli | grok-cli | agent-sessions | web-browser | diff)
                                           --scope takes comma-separated path globs the tab should edit, e.g. --scope 'src/**,tests/**'
             [-m MODEL] [-r EFFORT]        Agent tabs auto-launch their CLI (hooks wired). -m sets the model; -r sets codex reasoning
             [--no-launch]                 (minimal|low|medium|high). --no-launch keeps the old bare-shell behavior
  tab steer -w WS TAB_ID CONTENT...        Interrupt the current turn, then send CONTENT (use for a mid-turn correction; --no-interrupt to queue instead)
  tab send -w WS TAB_ID CONTENT...         Send input to a tab (bracketed paste + Enter). Waits up to 60s
                                           for an agent tab to be able to accept a turn; --wait-ms N changes
                                           the budget, --no-wait answers immediately. On timeout nothing is
                                           pasted and the call fails with agent-not-ready.
           [-f FILE | -f -]                Send file contents (or stdin with '-') — use for multi-line briefs
  tab status -w WS TAB_ID                  Tab status (includes registered probes + background jobs)
  tab result -w WS TAB_ID                  Capture tab pane content
  tab close -w WS TAB_ID                   Close a tab
  tab probe set -w WS TAB_ID --cmd CMD --stale-after SECS
                                           Register a liveness probe on a tab's delegated work. The watchdog runs
             [--interval SECS] [--label L] CMD (default every 60s); its last stdout line must print seconds since
                                           the work last progressed. Age > --stale-after fires a STALLED nudge to
                                           the orchestrator (or the tab itself) and a push alert to the human.
                                           3 consecutive probe failures fire a PROBE FAILING nudge — a broken
                                           probe is never a green light.
  tab probe list -w WS TAB_ID              Show a tab's probes with last age / staleness / failures
  tab probe clear -w WS TAB_ID [--label L] Remove probes (all, or one label) — do this when the job completes
  tab bg add -w WS TAB_ID --pid N          Watch a background pid: on exit, a BACKGROUND JOB DIED nudge fires
             [--label L] [--stderr FILE]   carrying the exit code (read from --exit-file) and the stderr tail
             [--exit-file FILE]            (from --stderr). Launch pattern: cmd 2>err.log & echo $! for the pid,
                                           and wrap with; echo $? > exit.code to capture the code
  tab bg list -w WS TAB_ID                 Show watched background jobs (pid, alive, age)
  tab bg remove -w WS TAB_ID [--pid N]     Stop watching (all, or one pid)
  tab browser url -w WS TAB_ID             Current URL + title of a web-browser tab
  tab browser screenshot -w WS TAB_ID      Capture tab screenshot (PNG). Use -o FILE to save, --full for full page
                          [-o FILE] [--full]
  tab browser console -w WS TAB_ID         Read recent console entries (ring buffer, 500 entries)
                          [--since MS] [--level LEVEL]
  tab browser network -w WS TAB_ID         Read recent network entries, or with --request ID to fetch body
                          [--since MS] [--method M] [--url SUBSTR] [--status CODE] [--request ID]
  tab browser eval -w WS TAB_ID EXPR       Evaluate JS expression inside the tab; returns serialized value
  orchestration status -w WS               Orchestration config + recent watchdog nudges for a workspace
  orchestration on -w WS [TAB_ID]          Enable orchestration; TAB_ID omitted = self-designate the calling tab
  orchestration off -w WS                  Disable orchestration (stops watchdog nudges + idle heartbeats)
  standup report -w WS --json '{...}'      Post a standup tick (or pipe JSON on stdin). Shown in the sidebar so
                                           the human can read progress at a glance. Shape:
                                           {"state":"on-track|at-risk|blocked|awaiting-human|done","headline":"...",
                                            "items":[{"label":"...","status":"done|active|blocked|todo","note":"..."}],
                                            "blockers":[{"what":"...","needs":"..."}],"needsHuman":false,"next":["..."]}
  standup show -w WS                       Latest standup + history for a workspace
  api-guide                                Print full HTTP API reference
  help                                     Show this usage

Environment:
  PMUX_PORT       Server port (required)
  PMUX_TOKEN      CLI token (required)
`);
};

const main = async () => {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const sub = args[1];
  const rest = args.slice(2);

  switch (cmd) {
    case 'workspaces':
      return cmdWorkspaces();
    case 'workspace':
      switch (sub) {
        case 'dirs': return cmdWorkspaceDirs(rest);
        case 'peers': return cmdWorkspacePeers(rest);
        default: die(`unknown workspace command: ${sub || '(none)'}. Run 'purplemux help' for usage.`);
      }
      break;
    case 'orchestration':
      return cmdOrchestration(args.slice(1));
    case 'standup':
      return cmdStandup(args.slice(1));
    case 'tab':
      switch (sub) {
        case 'list': return cmdTabList(rest);
        case 'create': return cmdTabCreate(rest);
        case 'send': return cmdTabSend(rest);
        case 'steer': return cmdTabSteer(rest);
        case 'status': return cmdTabStatus(rest);
        case 'result': return cmdTabResult(rest);
        case 'close': return cmdTabClose(rest);
        case 'probe': return cmdTabProbe(rest);
        case 'bg': return cmdTabBg(rest);
        case 'browser': return cmdTabBrowser(rest);
        default: die(`unknown tab command: ${sub || '(none)'}. Run 'purplemux help' for usage.`);
      }
      break;
    case 'api-guide':
      return cmdApiGuide();
    case 'help':
    case '-h':
    case '--help':
      return usage();
    default:
      die(`unknown command: ${cmd}. Run 'purplemux help' for usage.`);
  }
};

main().catch((err) => {
  die(err.message || String(err));
});
