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

// Exit-code contract (docs/adr/0016-cli-exit-codes-and-tab-owned-processes.md).
// A caller branches on the exit code, so a failure it must never retry (the tab
// is gone) and one it may retry (the agent is still booting) cannot share one.
// A relay loop once retried `tab send` into a closed tab for more than a day
// because both exited 1.
const EXIT = Object.freeze({
  UNEXPECTED: 1,
  USAGE: 2,
  CONFLICT: 3,
  GONE: 4,
  NOT_READY: 5,
  UNREACHABLE: 6,
  NOT_FOUND: 7,
});

const EXIT_HINT = Object.freeze({
  [EXIT.UNEXPECTED]: 'unexpected — investigate',
  [EXIT.USAGE]: 'usage error — fix the command',
  [EXIT.CONFLICT]: 'conflict — retry only after the state changes',
  [EXIT.GONE]: 'permanent — the target is gone; do not retry',
  [EXIT.NOT_READY]: 'not ready yet — retry, bounded',
  [EXIT.UNREACHABLE]: 'server unreachable — retry, bounded',
  [EXIT.NOT_FOUND]: 'not found',
});

// The one code → exit table. A server route adds its `code` here, never a
// table of its own. A code absent from the table exits 1.
const CODE_EXIT = Object.freeze(Object.assign(Object.create(null), {
  'gh-unavailable': EXIT.UNEXPECTED,
  'outcome-unknown': EXIT.UNEXPECTED,
  'close-not-confirmed': EXIT.UNEXPECTED,
  'lease-policy': EXIT.USAGE,
  'watch-invalid': EXIT.USAGE,
  'reports-to-invalid': EXIT.USAGE,
  'note-too-large': EXIT.USAGE,
  'config-invalid': EXIT.USAGE,
  'note-target-missing': EXIT.USAGE,
  'lease-held': EXIT.CONFLICT,
  'lease-held-by-other': EXIT.CONFLICT,
  'watch-cap': EXIT.CONFLICT,
  forbidden: EXIT.CONFLICT,
  'inbox-not-held': EXIT.CONFLICT,
  'grant-tab-unverified': EXIT.CONFLICT,
  'config-version-conflict': EXIT.CONFLICT,
  'caller-unresolved': EXIT.CONFLICT,
  'grant-password-invalid': EXIT.CONFLICT,
  'grant-locked': EXIT.CONFLICT,
  'tab-not-found': EXIT.GONE,
  'session-not-running': EXIT.GONE,
  'target-changed': EXIT.GONE,
  'readiness-timeout': EXIT.NOT_READY,
  'server-unreachable': EXIT.UNREACHABLE,
  'lease-not-found': EXIT.NOT_FOUND,
  'note-not-found': EXIT.NOT_FOUND,
  'watch-not-found': EXIT.NOT_FOUND,
  'inbox-not-found': EXIT.NOT_FOUND,
  'deploy-not-found': EXIT.NOT_FOUND,
  'config-not-found': EXIT.NOT_FOUND,
}));

// Where the class alone does not tell the caller what happened.
const CODE_HINT = Object.freeze(Object.assign(Object.create(null), {
  'tab-not-found': 'permanent — the tab is closed; do not retry',
  'session-not-running': "the tab's session is dead; do not retry — a person must restart the tab",
  'target-changed': 'permanent — the tab was replaced while the command waited; do not retry',
}));

const exitFor = (code) => (code && Object.hasOwn(CODE_EXIT, code) ? CODE_EXIT[code] : EXIT.UNEXPECTED);

const hintFor = (code, detail) => {
  if (code === 'readiness-timeout' && Number.isFinite(detail?.waitedMs)) {
    const state = detail.cliState ? `, cliState ${detail.cliState}` : '';
    return `not ready after ${detail.waitedMs} ms${state} — retry, bounded`;
  }
  if (code && Object.hasOwn(CODE_HINT, code)) return CODE_HINT[code];
  return EXIT_HINT[exitFor(code)];
};

/**
 * Report a failure and exit through the code → exit table. `code` is the
 * server's machine code (or a client-side one such as `server-unreachable`);
 * null means the failure carries no code and exits 1.
 */
const fail = (code, message, detail) => {
  const hint = hintFor(code, detail);
  const line = code
    ? `${code} (${hint})${message && message !== code ? ` — ${message}` : ''}`
    : `${message} (${hint})`;
  process.stderr.write(`error: ${line}\n`);
  process.exit(exitFor(code));
};

// A usage error: the command itself is wrong, so nothing was sent (exit 2).
const die = (msg) => {
  process.stderr.write(`error: ${msg} (${EXIT_HINT[EXIT.USAGE]})\n`);
  process.exit(EXIT.USAGE);
};

const requireEnv = () => {
  if (!PORT) fail('server-unreachable', 'PMUX_PORT not set and ~/.purplemux/port missing (is the server running?)');
  if (!ENV_TOKEN && !ADMIN_TOKEN) fail('server-unreachable', 'PMUX_TOKEN not set and ~/.purplemux/cli-token missing (is the server running?)');
};

// Failures that happen before the request reaches the server: retrying cannot
// repeat an effect the server never saw.
const CONNECT_ERRORS = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL',
  'UND_ERR_CONNECT_TIMEOUT',
]);

const causeCode = (err) => {
  const cause = err?.cause;
  return cause?.code || cause?.errors?.find((e) => e?.code)?.code || err?.code || null;
};

/**
 * A request that never got an answer. A read, or a request that never
 * connected, is safe to repeat: exit 6. A write that lost its connection after
 * connecting may have taken effect, so it exits 1 and says the outcome is
 * unknown — a blind retry of `tab send` could type the prompt twice.
 */
const networkFailure = (method, requestPath, err) => {
  const cause = causeCode(err);
  // undici reports a network failure as `fetch failed` (no answer) or
  // `terminated` (the body stopped), with a coded cause. Anything else — a
  // malformed URL or header, a port fetch refuses — is deterministic and was
  // never sent: retrying cannot help, and no write can have taken effect.
  const network = (err?.message === 'fetch failed' || err?.message === 'terminated') && cause;
  if (!network) {
    const detail = err?.cause?.message ? ` (${err.cause.message})` : '';
    return fail(null, `request not sent: ${err?.message || String(err)}${detail}`);
  }
  const reason = cause;
  if (CONNECT_ERRORS.has(cause) || method === 'GET' || method === 'HEAD') {
    return fail('server-unreachable', `${BASE} (${reason})`);
  }
  return fail(
    'outcome-unknown',
    `connection lost during ${method} ${requestPath.split('?')[0]} (${reason}); outcome unknown — check the state before retrying`,
  );
};

const request = async (method, requestPath, init) => {
  try {
    return await fetch(`${BASE}${requestPath}`, { ...init, method });
  } catch (err) {
    return networkFailure(method, requestPath, err);
  }
};

const readBody = async (method, requestPath, resp, as) => {
  try {
    return await resp[as]();
  } catch (err) {
    if (!(err instanceof SyntaxError)) return networkFailure(method, requestPath, err);
    // An error status still has a status to report; a success does not.
    if (!resp.ok) return null;
    return fail(null, `HTTP ${resp.status} with a body that is not valid JSON`);
  }
};

// Servers built before the contract carry the same facts without `code`; a
// rollback must not turn a closed tab back into a retryable exit 1.
const legacyCode = (body) => {
  if (body.error === 'Tab not found') return 'tab-not-found';
  if (body.error === 'Tab session is not running' || body.error === 'session not found') return 'session-not-running';
  if (body.error === 'agent-target-changed') return 'target-changed';
  if (body.error === 'agent-not-ready' && typeof body.detail === 'string') return body.detail;
  return null;
};

const failFromResponse = (resp, body) => {
  if (!body || typeof body !== 'object') return fail(null, `HTTP ${resp.status}`);
  const code = typeof body.code === 'string' ? body.code : legacyCode(body);
  const message = typeof body.error === 'string' ? body.error : `HTTP ${resp.status}`;
  return fail(code, code ? message : `${message} (HTTP ${resp.status})`, body);
};

const out = (body) => {
  process.stdout.write(JSON.stringify(body, null, 2) + '\n');
};

const isJson = (resp) => (resp.headers.get('content-type') || '').includes('json');

const api = async (method, path, data) => {
  const opts = {
    headers: { 'X-Pmux-Token': tokenFor(path), 'Content-Type': 'application/json' },
  };
  if (data !== undefined) opts.body = JSON.stringify(data);
  const resp = await request(method, path, opts);
  const body = isJson(resp) ? await readBody(method, path, resp, 'json') : null;
  if (!resp.ok) failFromResponse(resp, body);
  // Every CLI route answers JSON; a success without it is not a purplemux
  // answer (another server on the port), and printing `null` would pass it off
  // as one.
  if (!isJson(resp)) fail(null, `HTTP ${resp.status} without a JSON body — is purplemux the server on port ${PORT}?`);
  return { resp, body };
};

const apiRaw = async (method, path) => {
  const resp = await request(method, path, { headers: { 'X-Pmux-Token': tokenFor(path) } });
  if (!resp.ok) failFromResponse(resp, isJson(resp) ? await readBody(method, path, resp, 'json') : null);
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

const missionWorkspace = (args) => {
  const wsId = flagValue(args, '--workspace') || flagValue(args, '-w');
  if (!wsId) die('--workspace is required');
  return wsId;
};

const cmdMission = async (args) => {
  requireEnv();
  const sub = args[0];
  const rest = args.slice(1);
  const wsId = missionWorkspace(rest);
  const endpoint = `/api/cli/mission-control?workspaceId=${encodeURIComponent(wsId)}`;
  if (sub === 'snapshot') {
    const { body } = await api('GET', endpoint);
    return out(body);
  }
  if (sub === 'answers') {
    const runId = flagValue(rest, '--run');
    const all = rest.includes('--all');
    const { body } = await api('GET', endpoint);
    const answers = body.answers.filter((answer) => !runId || answer.runId === runId);
    const deliveries = body.deliveries.filter((delivery) => !runId || delivery.runId === runId);
    if (!all) {
      const items = new Map(body.items.filter((item) => item.state === 'answered').map((item) => [item.id, item]));
      const pending = new Map(deliveries.filter((delivery) => delivery.state !== 'acknowledged').map((delivery) => [delivery.answerId, delivery]));
      return out({
        workspaceId: wsId,
        humanInboxPolicy: body.humanInboxPolicy,
        answers: answers.flatMap((answer) => {
          const item = items.get(answer.itemId);
          const delivery = pending.get(answer.id);
          if (!item || !delivery) return [];
          const run = body.runs.find((candidate) => candidate.id === answer.runId);
          return [{
            ...answer,
            itemRevision: item.revision,
            bindingGeneration: run?.binding?.generation ?? null,
            delivery,
          }];
        }),
      });
    }
    return out({
      workspaceId: wsId,
      humanInboxPolicy: body.humanInboxPolicy,
      answers,
      deliveries,
    });
  }
  if (sub === 'events') {
    const raw = flagValue(rest, '--json') || await readStdin();
    let parsed;
    try { parsed = JSON.parse(raw); } catch { die("mission events must be valid JSON — pass --json '{\"events\":[...]}' or pipe JSON on stdin"); }
    const data = Array.isArray(parsed) ? { events: parsed } : parsed;
    const { body } = await api('POST', `/api/cli/mission-control/events?workspaceId=${encodeURIComponent(wsId)}`, data);
    return out(body);
  }
  if (sub === 'ack') {
    const runId = flagValue(rest, '--run');
    const answerId = flagValue(rest, '--answer');
    const generation = flagValue(rest, '--generation');
    const revision = flagValue(rest, '--revision');
    const eventId = flagValue(rest, '--event-id');
    const producerAt = flagValue(rest, '--producer-at');
    if (!runId || !answerId || !eventId) die('--run, --answer, and --event-id are required');
    if (!generation || !/^\d+$/.test(generation)) die('--generation must be a nonnegative integer');
    if (!revision || !/^\d+$/.test(revision)) die('--revision must be a nonnegative integer');
    if (!producerAt || !/^\d+$/.test(producerAt) || !Number.isSafeInteger(Number(producerAt))) {
      die('--producer-at must be a nonnegative safe integer copied from the answer command');
    }
    const event = {
      eventId,
      schemaVersion: 1,
      workspaceId: wsId,
      runId,
      expectedRevision: Number(revision),
      producerAt: Number(producerAt),
      bindingGeneration: Number(generation),
      type: 'answer.acknowledged',
      payload: { answerId },
    };
    const { body } = await api('POST', `/api/cli/mission-control/events?workspaceId=${encodeURIComponent(wsId)}`, { events: [event] });
    return out(body);
  }
  die('usage: mission snapshot|events|answers|ack -w WS [options]');
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
const MAX_CLI_WAIT_MS = 290_000;

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
  // Node's fetch stops waiting for response headers at 300 s. A longer wait
  // would end in outcome-unknown while the server could still paste later.
  if (waitMsGiven && Number(waitMs) > MAX_CLI_WAIT_MS) {
    die(`--wait-ms must be at most ${MAX_CLI_WAIT_MS} (the CLI's HTTP client stops waiting at 300 s)`);
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
  const { body } = await api(
    'DELETE',
    `/api/cli/tabs/${tabId}?workspaceId=${encodeURIComponent(wsId)}`,
  );
  // A 200 is not a close: the server answers `ok: false` when the layout kept
  // the tab, and printing ok over that hides a tab that is still running.
  if (body?.ok !== true) return fail('close-not-confirmed', `the server answered ${JSON.stringify(body)}`);
  process.stdout.write('ok\n');
};

// Liveness probes: the watchdog runs --cmd on an interval; its last non-empty
// stdout line must be a numeric seconds-since-last-progress value. Above --stale-after, the orchestrator
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

// Background job watch: when the pid exits, the orchestrator gets a completion,
// failure, or unknown-status nudge with a stderr tail when available.
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
        const buf = Buffer.from(await readBody('GET', path, resp, 'arrayBuffer'));
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
  const guidePath = '/api/cli/api-guide';
  const resp = await apiRaw('GET', guidePath);
  process.stdout.write((await readBody('GET', guidePath, resp, 'text')) + '\n');
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
             [-m MODEL] [-r EFFORT]        Agent tabs auto-launch their CLI (hooks wired). -m sets the model; -r sets the
             [--no-launch]                 reasoning effort — claude-code: low|medium|high|xhigh|max (claude --effort;
                                           omitted = the user's global default, so orchestrators should ALWAYS pin it);
                                           grok-cli: none|minimal|low|medium|high|xhigh|max (grok --effort);
                                           codex: minimal|low|medium|high. --no-launch keeps the old bare-shell behavior.
  tab steer -w WS TAB_ID CONTENT...        Interrupt the current turn, then send CONTENT (use for a mid-turn correction; --no-interrupt to queue instead)
  tab send -w WS TAB_ID CONTENT...         Send input to a tab and press Enter. Waits up to 60s
                                           for an agent tab to be able to accept a turn; --wait-ms N (max
                                           290000) changes the budget, --no-wait answers immediately. On timeout nothing is
                                           pasted and the call exits 5 (readiness-timeout).
                                           Exit 4 (tab-not-found, session-not-running, target-changed) means
                                           the tab is gone: never retry it, and never loop on it.
           [-f FILE | -f -]                Send file contents (or stdin with '-') — use for multi-line briefs
  tab status -w WS TAB_ID                  Tab status (includes registered probes + background jobs)
  tab result -w WS TAB_ID                  Capture tab pane content
  tab close -w WS TAB_ID                   Close a tab; prints ok only when the server confirms the close
  tab probe set -w WS TAB_ID --cmd CMD --stale-after SECS
                                           Register a liveness probe on a tab's delegated work. The watchdog runs
             [--interval SECS] [--label L] CMD (default every 60s); its last non-empty stdout line must be only a
                                           finite, nonnegative numeric count of seconds since
                                           the work last progressed. Age > --stale-after fires a STALLED nudge to
                                           the orchestrator (or the tab itself) and a push alert to the human.
                                           3 consecutive probe failures fire a PROBE FAILING nudge — a broken
                                           probe is never a green light.
  tab probe list -w WS TAB_ID              Show a tab's probes with last age / staleness / failures
  tab probe clear -w WS TAB_ID [--label L] Remove probes (all, or one label) — do this when the job completes
  tab bg add -w WS TAB_ID --pid N          Watch a background pid. A strict integer from --exit-file classifies exit 0
             [--label L] [--stderr FILE]   as COMPLETED and nonzero as FAILED; missing or malformed status becomes
             [--exit-file FILE]            EXITED with unknown status after a short grace. Nudges include the stderr
                                           tail when available. Verify completed artifacts; inspect unknown exits
                                           before deciding. Launch pattern: ( cmd 2>err.log; echo $? > exit.code ) &
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
  mission snapshot -w WS                   Read the workspace Mission Control snapshot
  mission events -w WS --json '{...}'      Submit an atomic batch of up to 25 producer events (or pipe JSON)
  mission answers -w WS [--run ID] [--all] Read unacknowledged answers for current answered items; --all includes history
  mission ack -w WS --run ID --answer ID --generation N --revision N --event-id ID --producer-at MS
                                           Acknowledge one persisted answer after reading and applying it
  api-guide                                Print full HTTP API reference
  help                                     Show this usage

Mission event examples:
  Ordinary attention events create workspace candidates. Workers route blockers to the orchestrator; they do not open the human inbox directly.
  purplemux mission events -w WS --json '{"events":[{"eventId":"evt-open-1","schemaVersion":1,"workspaceId":"WS","runId":"run-1","expectedRevision":0,"producerAt":1700000000001,"bindingGeneration":1,"type":"attention.opened","payload":{"itemId":"question-1","kind":"question","title":"Choose rollout","context":"Choose the production rollout strategy","storyIds":[],"options":[{"id":"gradual","label":"Gradual"}],"recommendation":"gradual","blockingScope":"story","canContinue":true}}]}'
  The configured orchestrator may promote that same item only after checking existing authority and identifying the remaining human-exclusive need.
  purplemux mission events -w WS --json '{"events":[{"eventId":"evt-review-1","schemaVersion":1,"workspaceId":"WS","runId":"run-1","expectedRevision":1,"producerAt":1700000000002,"bindingGeneration":1,"type":"attention.updated","payload":{"itemId":"question-1","kind":"question","title":"Choose rollout","context":"Choose the production rollout strategy","storyIds":[],"options":[{"id":"gradual","label":"Gradual"}],"recommendation":"gradual","blockingScope":"story","canContinue":true,"humanReview":{"humanNeed":"decision","humanReason":"Choose the acceptable product rollout risk.","handling":"Existing rollout guidance does not choose product risk tolerance.","reviewerTabId":"tab-orchestrator"}}}]}'
  purplemux mission events -w WS --json '{"events":[{"eventId":"evt-resolve-1","schemaVersion":1,"workspaceId":"WS","runId":"run-1","expectedRevision":2,"producerAt":1700000000004,"bindingGeneration":1,"type":"attention.resolved","payload":{"itemId":"question-1","resolution":"Applied the gradual rollout"}}]}'

Exit codes:
  exit  meaning                                                      retry?
     0  success                                                      —
     1  unexpected error (unmapped code, 5xx, write outcome unknown)  investigate first
     2  usage error (bad or missing argument, or a usage code)       fix the command
     3  conflict: held by another holder, or refused by state        only after the state changes
     4  target gone: tab-not-found, session-not-running,             never
        target-changed
     5  not ready yet: readiness-timeout                             yes, bounded
     6  server unreachable (refused, no port, read interrupted)      yes, bounded
     7  not found: the named lease, note or watch does not exist     —
  stderr names the code and its class, e.g.
    error: tab-not-found (permanent — the tab is closed; do not retry) — Tab not found

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
    case 'mission':
      return cmdMission(args.slice(1));
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
  fail(null, err.message || String(err));
});
