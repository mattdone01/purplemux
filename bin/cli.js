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
const TOKEN = process.env.PMUX_TOKEN || readFileOrNull(path.join(os.homedir(), '.purplemux', 'cli-token'));
const BASE = `http://localhost:${PORT}`;

const die = (msg) => {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
};

const requireEnv = () => {
  if (!PORT) die('PMUX_PORT not set and ~/.purplemux/port missing (is the server running?)');
  if (!TOKEN) die('PMUX_TOKEN not set and ~/.purplemux/cli-token missing (is the server running?)');
};

const out = (body) => {
  process.stdout.write(JSON.stringify(body, null, 2) + '\n');
};

const api = async (method, path, data) => {
  const url = `${BASE}${path}`;
  const opts = {
    method,
    headers: { 'X-Pmux-Token': TOKEN, 'Content-Type': 'application/json' },
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
    headers: { 'X-Pmux-Token': TOKEN },
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
  const rest = stripFlags(args, ['--workspace', '-w', '--file', '-f', '--no-interrupt']);
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

const cmdTabSend = async (args) => {
  requireEnv();
  const file = flagValue(args, '--file') || flagValue(args, '-f');
  const rest = stripFlags(args, ['--workspace', '-w', '--file', '-f']);
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
    `/api/cli/tabs/${tabId}/send?workspaceId=${encodeURIComponent(wsId)}`,
    { content },
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
    headers: { 'X-Pmux-Token': TOKEN },
  });
  if (!resp.ok) die(`HTTP ${resp.status}`);
  process.stdout.write((await resp.text()) + '\n');
};

const flagValue = (args, name) => {
  const idx = args.indexOf(name);
  if (idx === -1 || idx + 1 >= args.length) return null;
  return args[idx + 1];
};

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
                                           Create a tab in workspace (type: terminal | claude-code | codex-cli | agent-sessions | web-browser | diff)
                                           --scope takes comma-separated path globs the tab should edit, e.g. --scope 'src/**,tests/**'
             [-m MODEL] [-r EFFORT]        Agent tabs auto-launch their CLI (hooks wired). -m sets the model; -r sets codex reasoning
             [--no-launch]                 (minimal|low|medium|high). --no-launch keeps the old bare-shell behavior
  tab steer -w WS TAB_ID CONTENT...        Interrupt the current turn, then send CONTENT (use for a mid-turn correction; --no-interrupt to queue instead)
  tab send -w WS TAB_ID CONTENT...         Send input to a tab (bracketed paste + Enter)
           [-f FILE | -f -]                Send file contents (or stdin with '-') — use for multi-line briefs
  tab status -w WS TAB_ID                  Tab status
  tab result -w WS TAB_ID                  Capture tab pane content
  tab close -w WS TAB_ID                   Close a tab
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
    case 'tab':
      switch (sub) {
        case 'list': return cmdTabList(rest);
        case 'create': return cmdTabCreate(rest);
        case 'send': return cmdTabSend(rest);
        case 'steer': return cmdTabSteer(rest);
        case 'status': return cmdTabStatus(rest);
        case 'result': return cmdTabResult(rest);
        case 'close': return cmdTabClose(rest);
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
