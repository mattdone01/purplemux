'use strict';
// Wave-4 acceptance checks (story 39) against the ISOLATED purplemux instance:
//   * story 37 — a stop whose open work is a shell a SUBAGENT moved to the background, or an async
//     subagent woken by its own shell's delivery, is WAITING (no READY nudge) until that work ends;
//     `tab status` serves the classification (`turnEnd`);
//   * story 36 — `tab list` reports each tab's identity; the hook-time identity route is mint-only
//     (a tab with a launch identity is refused), Claude-only, and never answers the admin token;
//   * story 11 — a human-granted, launch-verified tab drives another workspace; nobody else in its
//     workspace does; the password step-up, the revoke and the audit lines;
//   * story 28 — the grants read needs the session only (no Origin) and names each grantee's identity;
//   * story 20 — the coordination route answers the human session only, and the built Mission Control
//     page ships the panel;
//   * story 12 — a reconcile bootstrap reaches the workspace orchestrator as ONE inbox notice, typed
//     once into its idle, empty composer as a single line.
//
// Kept apart from checks.cjs like wave 3: `wave4(inst, helpers)` returns results in checks.cjs's
// shape. The human session is the isolated instance's own: the first-run setup route sets a scratch
// password (the instance's HOME is throwaway), then the login route issues the cookie. No credential
// of the live service is read or used.

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

/** One HTTP call to the isolated instance; resolves { status, headers, body, json }. Never throws. */
const request = (port, method, urlPath, { headers = {}, body = null } = {}) => new Promise((resolve) => {
  const payload = body === null ? null : JSON.stringify(body);
  const req = http.request({
    host: '127.0.0.1',
    port,
    path: urlPath,
    method,
    headers: {
      host: `localhost:${port}`,
      ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
      ...headers,
    },
  }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      resolve({ status: res.statusCode, headers: res.headers, body: text, json });
    });
  });
  req.on('error', (e) => resolve({ status: 0, headers: {}, body: String(e), json: null }));
  req.setTimeout(30000, () => req.destroy(new Error('timeout')));
  if (payload) req.write(payload);
  req.end();
});

/** The scratch human session: set the first-run password, log in, return the cookie (or null + why). */
const humanSession = async (port, password) => {
  const setup = await request(port, 'POST', '/api/auth/setup', { body: { authPassword: password } });
  // 400 "Setup already completed" on a re-run of the same instance is fine: the password is derived
  // from the instance's scratch path, so it is the one set the first time.
  if (setup.status !== 200 && setup.status !== 400) return { cookie: null, why: `setup ${setup.status} ${setup.body.slice(0, 120)}` };
  const login = await request(port, 'POST', '/api/auth/login', { body: { password } });
  const setCookie = [].concat(login.headers['set-cookie'] || []).join(';');
  const match = /session-token=[^;]+/.exec(setCookie);
  return match ? { cookie: match[0], why: '' } : { cookie: null, why: `login ${login.status} ${login.body.slice(0, 120)}` };
};

/** Entries of a stand-in transcript, stamped `at` (ms). */
const userLine = (at, content) => ({ type: 'user', timestamp: new Date(at).toISOString(), message: { role: 'user', content } });
const assistantEnd = (at, text) => ({
  type: 'assistant',
  timestamp: new Date(at).toISOString(),
  message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] },
});
const notification = (taskId, summary) =>
  `<task-notification>\n<task-id>${taskId}</task-id>\n<status>completed</status>\n<summary>${summary}</summary>\n</task-notification>`;
/** A completion as the main transcript records it when the agent was busy (queue enqueue). */
const queuedCompletion = (at, taskId, summary) => ({ type: 'queue-operation', operation: 'enqueue', timestamp: new Date(at).toISOString(), content: notification(taskId, summary) });
/** A subagent's foreground Bash moved to the background on its timeout (Claude Code 2.1.283 shape). */
const subagentMovedShell = (at, agentId, taskId) => ({
  type: 'user',
  isSidechain: true,
  agentId,
  timestamp: new Date(at).toISOString(),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_acc', content: `Command did not complete within its 600s timeout and was moved to the background (ID: ${taskId}).` }] },
  toolUseResult: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: taskId, timedOutAfterMs: 600000 },
});
/** The harness delivering a task's completion INTO a subagent's file: it wakes that agent. */
const subagentDelivery = (at, agentId, taskId) => ({
  type: 'user',
  isSidechain: true,
  isMeta: true,
  agentId,
  timestamp: new Date(at).toISOString(),
  origin: { kind: 'task-notification' },
  message: { role: 'user', content: `[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event.\n\n${notification(taskId, 'Background command "gate wait" completed (exit code 0)')}` },
});
const asyncAgentLaunch = (at, agentId) => ({
  type: 'user',
  timestamp: new Date(at).toISOString(),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_acc_agent', content: [{ type: 'text', text: 'Async agent launched' }] }] },
  toolUseResult: { isAsync: true, status: 'async_launched', agentId, description: 'acc subagent' },
});

/**
 * A stand-in the server treats as a LIVE Claude agent, as a real one is seen (review r1):
 *   * it writes Claude's session pid file (`$HOME/.claude/sessions/<pid>.json`: pid, sessionId, cwd,
 *     startedAt), so the server binds the session AND reads the process start — the `tasksSince`
 *     filter then runs as it does live (the `sh` stand-in has no start, so the filter never ran);
 *   * it draws an empty composer and ends by `exec -a claude cat`, so tmux reports the pane's
 *     command as `claude` (Mission Control's liveness test) while the process keeps its environment
 *     (HOME included: teardown finds its processes by the scratch HOME — perl's `$0` wiped it);
 *   * whatever is typed into the composer is appended to $ACC_INPUT.
 */
const liveStandIn = (scratch) => {
  const file = path.join(scratch, 'bin', 'live', 'claude');
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [
      '#!/bin/bash',
      '# $1 is --resume, $2 the session uuid.',
      'd="$HOME/.claude/sessions"; mkdir -p "$d"',
      // Milliseconds from %s%N: some `date` builds (uutils) ignore the width in %3N and print nanoseconds.
      'printf \'{"pid":%d,"sessionId":"%s","cwd":"%s","startedAt":%s}\\n\' "$$" "$2" "$PWD" "$(( $(date +%s%N) / 1000000 ))" > "$d/$$.json"',
      'clear',
      'rows=$(stty size 2>/dev/null | cut -d" " -f1)',
      'i=4; while [ "$i" -lt "${rows:-24}" ]; do echo; i=$((i + 1)); done',
      "printf '────────────────\\n\\342\\235\\257 \\n────────────────'",
      'stty -echo 2>/dev/null',
      'exec -a claude cat >> "${ACC_INPUT:-/dev/null}"',
      '',
    ].join('\n'));
    fs.chmodSync(file, 0o755);
  }
  return file;
};

/** The process start the live stand-in recorded for session `uuid` (its pid file), or null before it did. */
const standInStart = (home, uuid) => {
  const dir = path.join(home, '.claude', 'sessions');
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (data.sessionId === uuid && Number.isFinite(data.startedAt)) return data.startedAt;
    } catch {
      // a pid file being written
    }
  }
  return null;
};

/** Bracketed-paste markers a pane may carry around a pasted line. */
const unpaste = (text) => text.replace(/\u001b\[20[01]~/g, '');

/**
 * Story 12's judge (review r1): the WHOLE composer input is exactly one non-empty line, and that line is
 * the fixed bootstrap notice for this workspace. Counting only the marker lines would pass a notice
 * typed with a multi-line prompt around it — the defect story 12 fixed.
 */
const judgeMissionTyped = (text, workspaceId) => {
  const lines = unpaste(text ?? '').split(/\r?\n|\r/).map((l) => l.trim()).filter(Boolean);
  const template = new RegExp(`^\\[purplemux mission \\S+\\] Mission Control asks this orchestrator to reconcile — read: purplemux mission bootstrap -w ${workspaceId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
  const ok = lines.length === 1 && template.test(lines[0]);
  return { ok, measured: `${lines.length} non-empty line(s): ${JSON.stringify(lines.join(' ⏎ ').slice(0, 300))}` };
};

/**
 * Story 37's judge (review r1): the stop was WAITING — busy, no nudge, the classification `waiting`
 * with exactly `open` open tasks read from a transcript — while a LATER plain stop already had its
 * READY nudge; and after the work ended, the next stop's READY nudge is stamped after that end.
 */
const judgeSubagentWait = ({ controlReady, early, later, endedAt, open = 1 }) => {
  const ok = Boolean(controlReady)
    && early?.stopped === true && early.cliState === 'busy' && Array.isArray(early.nudges) && early.nudges.length === 0
    && early.turnEnd?.kind === 'waiting' && early.turnEnd.openBackgroundTasks === open
    && Boolean(later) && typeof later.at === 'number' && later.at >= endedAt;
  return {
    ok,
    measured: `control READY ${Boolean(controlReady)}; after it: ${JSON.stringify(early ?? null)}; after the end: ${later ? `ready nudge at +${later.at - endedAt} ms` : 'no ready nudge'}`,
  };
};

/** Run the wave-4 checks; an exception fails wave 4 alone and keeps the lines already produced. */
const wave4 = async (inst, helpers) => {
  const results = [];
  try {
    await checks(inst, helpers, results);
  } catch (e) {
    results.push({ status: 'fail', id: 'wave4-error', what: 'the wave-4 checks ran to the end', measured: e instanceof Error ? e.stack : String(e), expected: 'no exception' });
  }
  return results;
};

const checks = async (inst, helpers, results) => {
  const { parseJson, brief } = helpers;
  const pass = (id, what) => results.push({ status: 'pass', id, what });
  const fail = (id, what, measured, expected) => results.push({ status: 'fail', id, what, measured, expected });
  const check = (id, what, ok, measured, expected) => (ok ? pass(id, what) : fail(id, what, measured, expected));
  const nonce = crypto.randomBytes(3).toString('hex');
  const ctx = { ...helpers, check, fail, nonce, port: inst.state.port };
  ctx.tab = async (ws, name, type = 'terminal', extra = []) =>
    parseJson((await inst.cli(['tab', 'create', '-w', ws, '-n', name, '-t', type, ...extra])).out);
  ctx.status = async (ws, tabId) => parseJson((await inst.cli(['tab', 'status', '-w', ws, tabId])).out);
  ctx.brief = brief;

  await subagentWork(inst, ctx);
  await identity(inst, ctx);
  // Stable per instance, so a kept instance can be re-run with --only-wave 4 (the setup answers 400
  // the second time and the login still succeeds).
  const password = `acc-pw-${crypto.createHash('sha256').update(inst.state.scratch).digest('hex').slice(0, 16)}`;
  const session = await humanSession(ctx.port, password);
  if (!session.cookie) {
    for (const id of ['grant-step-up', 'grant-drives-other-workspace', 'grant-only-grantee', 'grant-revoke', 'grant-audit', 'grants-read-session-only', 'coordination-route', 'coordination-panel-built', 'mission-bootstrap-inbox']) {
      fail(id, 'needs the scratch human session', session.why, 'setup 200, login 200 with a session-token cookie');
    }
    return;
  }
  ctx.cookie = session.cookie;
  ctx.password = password;
  await grants(inst, ctx);
  await coordination(inst, ctx);
  await missionInbox(inst, ctx);
};

// ─── story 37: open work a subagent owns ─────────────────────────────────────────────────────────
const subagentWork = async (inst, { check, fail, nonce, within, sleep, tab, status, brief }) => {
  const { b: wsB } = inst.state.workspaces;
  const ids = ['subagent-shell-waiting', 'subagent-woken-waiting', 'turn-end-served'];
  const orch = await tab(wsB, `acc4-orch-${nonce}`);
  await sleep(1000);
  const on = orch?.tabId ? await inst.cli(['orchestration', 'on', '-w', wsB, orch.tabId]) : { rc: -1, out: '', err: 'no tab' };
  // A stop with no end line nudges only after the idle window (L49); 3 s instead of the 15 min default.
  await inst.cli(['config', 'set', 'watchdog.idle-nudge-minutes', '0.05']);
  if (!orch?.tabId || on.rc !== 0) {
    for (const id of ids) fail(id, 'story 37 needs an orchestrated workspace B', `orchestration on: ${brief(on)}`, 'exit 0');
    return;
  }
  const worker = async (name, transcript, subagents) => {
    const created = await tab(wsB, name, 'claude-code', ['--no-launch']);
    if (!created?.tabId) return null;
    await sleep(500);
    const started = await inst.startStandIn(created.sessionName, transcript, { subagents, standInPath: liveStandIn(inst.state.scratch) });
    if (started.rc !== 0) return null;
    // A live session writes its subagent files after its process starts; the ledger skips a file last
    // written before that start (story 37). The fixture files predate the stand-in, so touch them after
    // the start its pid file records — polled, not slept (review r2 N1: a slow pane must not look early).
    const uuid = path.basename(started.transcriptPath, '.jsonl');
    const startedAt = await within(30000, async () => standInStart(inst.state.home, uuid));
    if (startedAt === null) return null;
    const subDir = path.join(started.transcriptPath.replace(/\.jsonl$/, ''), 'subagents');
    for (const name of subagents ? Object.keys(subagents) : []) {
      const at = new Date(Math.max(Date.now(), startedAt + 1000));
      fs.utimesSync(path.join(subDir, name), at, at);
    }
    return { ...created, transcriptPath: started.transcriptPath };
  };
  const stopTurn = async (w) => {
    await sleep(1000);
    await inst.hook('session-start', w.sessionName);
    await inst.hook('prompt-submit', w.sessionName);
    const busy = await within(30000, async () => (await inst.cliState(wsB, w.tabId)) === 'busy');
    const stopped = await inst.hook('stop', w.sessionName);
    return busy && stopped === 204;
  };
  const appendLines = (w, entries) => fs.appendFileSync(w.transcriptPath, `${entries.map((l) => JSON.stringify(l)).join('\n')}\n`);

  // Shapes from tab-dTsAzt on 2026-09-26 (stripped): the subagent moved a Bash to the background one
  // second before it returned; the main transcript ends the turn with no marker.
  // Stamped after the stand-in starts (its pid file records the start, and the server filters tasks
  // started before it): 30 s leaves room for a slow pane on a loaded host.
  const t0 = Date.now() + 30000;
  // A task left open by an EARLIER process of the session: the process-start filter must drop it, so
  // the count below stays 1 (review r1: without a recorded start the filter never ran in isolation).
  const orphan = (agentId) => subagentMovedShell(Date.now() - 600000, agentId, `bacc37o${nonce}${agentId.slice(-1)}`);
  const shellAgent = `aacc37s${nonce}`;
  const shellTask = `bacc37s${nonce}`;
  const shell = await worker(`acc4-sub-shell-${nonce}`, [
    userLine(t0, 'go'),
    asyncAgentLaunch(t0 + 1000, shellAgent),
    queuedCompletion(t0 + 20000, shellAgent, 'Agent "acc" completed'),
    assistantEnd(t0 + 21000, 'Still running: the gate the subagent started.'),
  ], { [`agent-${shellAgent}.jsonl`]: [orphan(shellAgent), subagentMovedShell(t0 + 19000, shellAgent, shellTask)] });

  // agent adb9dae4 on 2026-09-26: completed, then woken by its own shell's delivery into its file
  // (no resume line in the main transcript) — it runs until its second completion.
  const wokenAgent = `aacc37w${nonce}`;
  const wokenTask = `bacc37w${nonce}`;
  const woken = await worker(`acc4-sub-woken-${nonce}`, [
    userLine(t0, 'go'),
    asyncAgentLaunch(t0 + 1000, wokenAgent),
    queuedCompletion(t0 + 10000, wokenAgent, 'Agent "acc" completed'),
    assistantEnd(t0 + 30000, 'Waiting on the review agent.'),
  ], { [`agent-${wokenAgent}.jsonl`]: [orphan(wokenAgent), subagentMovedShell(t0 + 5000, wokenAgent, wokenTask), subagentDelivery(t0 + 25000, wokenAgent, wokenTask)] });

  const plain = await worker(`acc4-plain-${nonce}`, [userLine(t0, 'go'), assistantEnd(t0 + 1000, 'Finished the task.')]);
  const shellStopped = shell ? await stopTurn(shell) : false;
  const wokenStopped = woken ? await stopTurn(woken) : false;
  const plainStopped = plain ? await stopTurn(plain) : false;
  // Order, not a quiet interval: the plain stop, posted AFTER both, must already have its idle nudge
  // (a stop with no end line nudges only after the window, L49).
  // The status poll derives the idle nudge (every 30–60 s): up to two polls past the 3 s window.
  const ready = plainStopped ? await within(130000, async () => (await inst.nudgesFor(wsB, plain.tabId)).find((n) => n.kind === 'idle-no-end-line')) : null;
  const plainStatus = plain ? await status(wsB, plain.tabId) : null;
  check(
    'turn-end-served',
    'tab status serves the watchdog\'s classification of the last stop: a plain READY stop read its transcript and found nothing open',
    Boolean(ready && plainStatus?.turnEnd?.kind === 'ready-for-review' && plainStatus.turnEnd.transcript === true && plainStatus.turnEnd.openBackgroundTasks === 0),
    `idle nudge ${Boolean(ready)}; turnEnd ${JSON.stringify(plainStatus?.turnEnd ?? null)}`,
    'an idle-no-end-line nudge; turnEnd { kind: ready-for-review, transcript: true, openBackgroundTasks: 0 }',
  );

  const judgeWait = async (w, stopped) => {
    const s = w ? await status(wsB, w.tabId) : null;
    const nudges = w ? await inst.nudgesFor(wsB, w.tabId) : [];
    return { stopped, cliState: s?.cliState ?? null, turnEnd: s?.turnEnd ?? null, nudges: nudges.map((n) => n.kind) };
  };
  const shellEarly = await judgeWait(shell, shellStopped);
  const wokenEarly = await judgeWait(woken, wokenStopped);

  // End the work, then stop again: now the classification must be READY, stamped after the end.
  const endedAt = Date.now();
  // An agent's end closes it only when it is not older than its wake (t0 + 25 s).
  const stamp = Math.max(endedAt, t0 + 40000);
  if (shell) appendLines(shell, [queuedCompletion(stamp, shellTask, 'Background command "gate wait" completed (exit code 0)')]);
  if (woken) appendLines(woken, [queuedCompletion(stamp, wokenAgent, 'Agent "acc" completed')]);
  const again = async (w) => (w && (await inst.hook('stop', w.sessionName)) === 204
    ? within(130000, async () => (await inst.nudgesFor(wsB, w.tabId)).find((n) => n.kind === 'idle-no-end-line'))
    : null);
  const shellReady = await again(shell);
  const wokenReady = await again(woken);
  const shellJudged = judgeSubagentWait({ controlReady: ready, early: shellEarly, later: shellReady, endedAt });
  const wokenJudged = judgeSubagentWait({ controlReady: ready, early: wokenEarly, later: wokenReady, endedAt });
  check(
    'subagent-shell-waiting',
    'a stop whose only open work is a shell a subagent moved to the background is WAITING (busy, no nudge, one open task — a task from before the process is not counted); once its completion lands the next stop is READY',
    shellJudged.ok,
    shellJudged.measured,
    'control READY first; busy, no nudge, turnEnd waiting with 1 open task; then a ready nudge stamped after the completion',
  );
  check(
    'subagent-woken-waiting',
    'a stop while a completed async subagent was woken by its own shell\'s delivery is WAITING; its second completion makes the next stop READY',
    wokenJudged.ok,
    wokenJudged.measured,
    'control READY first; busy, no nudge, turnEnd waiting with 1 open task (the woken agent); then a ready nudge stamped after its completion',
  );
  for (const w of [shell, woken, plain, orch]) if (w?.tabId) await inst.cli(['tab', 'close', '-w', wsB, w.tabId]);
  await inst.cli(['orchestration', 'off', '-w', wsB]);
};

// ─── story 36: identity is reported; the hook-time route is mint-only ───────────────────────────
const identity = async (inst, { check, nonce, sleep, tab, brief, parseJson, port }) => {
  const { a: wsA } = inst.state.workspaces;
  const claude = await tab(wsA, `acc4-id-claude-${nonce}`, 'claude-code', ['--no-launch']);
  const term = await tab(wsA, `acc4-id-term-${nonce}`);
  await sleep(1000);
  const listed = parseJson((await inst.cli(['tab', 'list', '-w', wsA])).out);
  const tabs = Array.isArray(listed) ? listed : listed?.tabs ?? [];
  const idOf = (t) => tabs.find((x) => (x.tabId ?? x.id) === t?.tabId)?.identity ?? null;
  check(
    'tab-list-identity',
    'tab list reports each tab\'s identity; a tab this server launched is `launch`',
    idOf(claude) === 'launch' && idOf(term) === 'launch',
    `claude ${idOf(claude)}, terminal ${idOf(term)}`,
    'launch, launch',
  );
  // The pane's own workspace token ($PMUX_TOKEN), as the SessionStart hook presents it.
  const ask = (session) => inst.inTab(wsA, term.tabId,
    `curl -s -X POST -H "x-pmux-token: $PMUX_TOKEN" -H 'content-type: application/json' -d '{"session":"${session}"}' http://localhost:${port}/api/cli/tab-identity`);
  const launchTab = claude && term ? parseJson((await ask(claude.sessionName)).out) : null;
  const terminalTab = claude && term ? parseJson((await ask(term.sessionName)).out) : null;
  const cliToken = fs.readFileSync(path.join(inst.state.home, '.purplemux', 'cli-token'), 'utf8').trim();
  const admin = await request(port, 'POST', '/api/cli/tab-identity', { headers: { 'x-pmux-token': cliToken }, body: { session: claude?.sessionName ?? 'x' } });
  check(
    'hook-identity-mint-only',
    'the hook-time identity route never hands out or replaces a launch identity, is for Claude tabs only, and refuses the admin token',
    launchTab?.code === 'tab-has-launch-identity' && terminalTab?.code === 'tab-identity-unsupported' && admin.status === 403 && !launchTab?.token,
    `launch tab ${JSON.stringify(launchTab)}; terminal ${JSON.stringify(terminalTab)}; admin ${admin.status} ${brief({ rc: admin.status, out: '', err: admin.body })}`,
    'tab-has-launch-identity (no token); tab-identity-unsupported; admin 403',
  );
  for (const t of [claude, term]) if (t?.tabId) await inst.cli(['tab', 'close', '-w', wsA, t.tabId]);
};

// ─── stories 11 and 28: drive grants and the grants read ────────────────────────────────────────
/** A cross-workspace send refused by the workspace gate: exit 3 and the `forbidden` code, not some other failure. */
const refusedForbidden = (r) => r.rc === 3 && /forbidden/i.test(`${r.err}${r.out}`);

const grants = async (inst, { check, nonce, sleep, tab, brief, port, cookie, password, parseJson }) => {
  const { a: wsA, b: wsB } = inst.state.workspaces;
  const origin = `http://localhost:${port}`;
  const human = { cookie, origin };
  const grantee = await tab(wsA, `acc4-grantee-${nonce}`);
  const other = await tab(wsA, `acc4-other-${nonce}`);
  const target = await tab(wsB, `acc4-target-${nonce}`);
  await sleep(1000);
  const drive = (from, marker) => inst.inTab(wsA, from.tabId, inst.tabCli(['tab', 'send', '-w', wsB, target.tabId, `echo ${marker}`]));
  const before = await drive(grantee, `ACC4-BEFORE-${nonce}`);
  const body = (pw) => ({ granteeWorkspaceId: wsA, granteeTabId: grantee.tabId, workspaces: [wsB], reason: `acc wave 4 ${nonce}`, expiresInHours: 1, password: pw });
  const wrong = await request(port, 'POST', '/api/grants', { headers: human, body: body('not-the-password') });
  const noOrigin = await request(port, 'POST', '/api/grants', { headers: { cookie }, body: body(password) });
  const made = await request(port, 'POST', '/api/grants', { headers: human, body: body(password) });
  const grantId = made.json?.grant?.id ?? null;
  check(
    'grant-step-up',
    'a grant needs the human session, the same Origin and the purplemux password: a wrong password is refused, the right one creates it',
    wrong.status === 403 && wrong.json?.code === 'grant-password-invalid' && noOrigin.status === 403 && /origin/i.test(noOrigin.json?.error ?? '') && made.status === 201 && Boolean(grantId),
    `wrong ${wrong.status} ${wrong.json?.code}; no Origin ${noOrigin.status} ${noOrigin.json?.error}; right ${made.status} ${grantId}`,
    'wrong 403 grant-password-invalid; no Origin 403 naming the Origin; right 201 with a grant id',
  );
  const byGrantee = grantId ? await drive(grantee, `ACC4-GRANTED-${nonce}`) : { rc: -1, out: '', err: 'no grant' };
  check(
    'grant-drives-other-workspace',
    'the granted, launch-verified tab drives a tab of the granted workspace (refused before the grant)',
    refusedForbidden(before) && byGrantee.rc === 0,
    `before ${brief(before)}; with the grant ${brief(byGrantee)}`,
    'before exit 3 forbidden; with the grant exit 0',
  );
  const byOther = grantId ? await drive(other, `ACC4-OTHER-${nonce}`) : { rc: -1, out: '', err: 'no grant' };
  check(
    'grant-only-grantee',
    'another tab of the grantee\'s workspace is still refused (the grant names one tab)',
    refusedForbidden(byOther),
    brief(byOther),
    'exit 3 forbidden',
  );
  const read = await request(port, 'GET', '/api/grants', { headers: { cookie } });
  const anonymous = await request(port, 'GET', '/api/grants');
  const listedGrantee = (read.json?.grantees ?? []).find((g) => g.tabId === grantee.tabId);
  check(
    'grants-read-session-only',
    'the grants read needs the session only (no Origin, as a plain-HTTP LAN browser sends it), lists the grant and names the grantee\'s identity; no session is 401',
    read.status === 200 && (read.json?.grants ?? []).some((g) => g.id === grantId) && listedGrantee?.identity === 'launch' && anonymous.status === 401,
    `with session ${read.status}, grant listed ${(read.json?.grants ?? []).some((g) => g.id === grantId)}, grantee identity ${listedGrantee?.identity}; without ${anonymous.status}`,
    '200, the grant, grantee identity launch; 401',
  );
  const revoked = grantId ? await request(port, 'DELETE', `/api/grants/${grantId}`, { headers: human }) : { status: 0 };
  const after = grantId ? await drive(grantee, `ACC4-AFTER-${nonce}`) : { rc: -1, out: '', err: 'no grant' };
  check(
    'grant-revoke',
    'revoking the grant (session + Origin) ends it: the grantee is refused again',
    revoked.status === 200 && refusedForbidden(after),
    `revoke ${revoked.status}; drive after ${brief(after)}`,
    'revoke 200; exit 3 forbidden',
  );
  const auditPath = path.join(inst.state.home, '.purplemux', 'audit', 'coordination.jsonl');
  const events = (fs.existsSync(auditPath) ? fs.readFileSync(auditPath, 'utf8') : '').split('\n')
    .map((l) => parseJson(l)).filter((e) => e && (e.grantId === grantId || e.event === 'grant-password-invalid'));
  const kinds = new Set(events.map((e) => e.event));
  check(
    'grant-audit',
    'the audit file records the refused password, the creation, each use and the revoke',
    ['grant-password-invalid', 'grant-created', 'grant-used', 'grant-revoked'].every((k) => kinds.has(k)),
    `events: ${[...kinds].join(', ') || 'none'}`,
    'grant-password-invalid, grant-created, grant-used, grant-revoked',
  );
  for (const [ws, t] of [[wsA, grantee], [wsA, other], [wsB, target]]) if (t?.tabId) await inst.cli(['tab', 'close', '-w', ws, t.tabId]);
};

// ─── story 20: the coordination route and the built panel ───────────────────────────────────────
const coordination = async (inst, { check, port, cookie }) => {
  const cliToken = fs.readFileSync(path.join(inst.state.home, '.purplemux', 'cli-token'), 'utf8').trim();
  const human = await request(port, 'GET', '/api/mission-control/coordination', { headers: { cookie } });
  const byToken = await request(port, 'GET', '/api/mission-control/coordination', { headers: { 'x-pmux-token': cliToken } });
  const sections = ['leases', 'notes', 'watches', 'grants', 'inboxHeld'];
  const shaped = human.json && sections.every((k) => typeof human.json[k]?.ok === 'boolean')
    && human.json.host?.available === true && Array.isArray(human.json.host.disks) && typeof human.json.signals?.state === 'string';
  check(
    'coordination-route',
    'the coordination route answers the human session with every section and live host data; the CLI admin token alone is 401',
    human.status === 200 && Boolean(shaped) && byToken.status === 401,
    `session ${human.status}, sections ${sections.map((k) => `${k}:${human.json?.[k]?.ok}`).join(' ')}, host ${human.json?.host?.available}, signals ${human.json?.signals?.state}; token ${byToken.status}`,
    'session 200 with all sections ok-typed, host available, a signals state; token 401',
  );
  // The page renders on the client, so the proof is the page's own built chunk: it must carry the panel.
  const page = await request(port, 'GET', '/mission-control', { headers: { cookie } });
  const chunks = [...page.body.matchAll(/src="(\/_next\/static\/chunks\/[^"]+\.js)"/g)].map((m) => m[1]);
  let found = null;
  for (const chunk of chunks) {
    const js = await request(port, 'GET', chunk, { headers: { cookie } });
    if (js.body.includes('coordination-heading')) {
      found = chunk;
      break;
    }
  }
  check(
    'coordination-panel-built',
    'the served Mission Control page loads a chunk that carries the coordination panel',
    page.status === 200 && Boolean(found),
    `page ${page.status}, ${chunks.length} chunks, panel in ${found ?? 'none'}`,
    'page 200; one of its chunks contains "coordination-heading"',
  );
};

// ─── story 12: a reconcile bootstrap reaches the orchestrator through the inbox ─────────────────
const missionInbox = async (inst, { check, nonce, sleep, within, tab, status: tabStatus, brief, port, cookie, readIf, parseJson }) => {
  const { a: wsA } = inst.state.workspaces;
  const orch = await tab(wsA, `acc4-mc-orch-${nonce}`, 'claude-code', ['--no-launch']);
  await sleep(1000);
  const on = orch?.tabId ? await inst.cli(['orchestration', 'on', '-w', wsA, orch.tabId]) : { rc: -1, out: '', err: 'no tab' };
  const inputFile = path.join(inst.state.scratch, 'io', `mc-composer-${nonce}.txt`);
  fs.mkdirSync(path.dirname(inputFile), { recursive: true });
  fs.writeFileSync(inputFile, '');
  const standIn = orch && on.rc === 0
    ? await inst.startStandIn(orch.sessionName, 'Ready.', { workspaceDir: 'a', inputFile, standInPath: liveStandIn(inst.state.scratch) })
    : { rc: -1 };
  await sleep(1500);
  if (orch) await inst.hook('session-start', orch.sessionName);
  const idle = orch ? await within(10000, async () => (await inst.cliState(wsA, orch.tabId)) === 'idle') : false;
  // The orchestrator's live binding: the server finds the stand-in's session from its `--resume`
  // argument on its next poll; a bootstrap before that records "no live orchestrator binding".
  const bound = idle ? await within(150000, async () => (await tabStatus(wsA, orch.tabId))?.agentSessionId ?? null) : null;
  // A recent substantive standup gives the workspace a run for the bootstrap to reconcile.
  const standup = await inst.cli(['standup', 'report', '-w', wsA, '--json', JSON.stringify({
    state: 'on-track', headline: `acc wave 4 ${nonce}`, items: [{ label: 'acceptance', status: 'active' }], blockers: [], needsHuman: false, next: ['finish'],
  })]);
  const human = { cookie, origin: `http://localhost:${port}` };
  const bootstrap = await request(port, 'POST', '/api/mission-control/bootstrap', { headers: human, body: { bootstrapId: `acc-boot-${nonce}`, reconcile: true } });
  const entries = bootstrap.json?.entries ?? [];
  // 180 s: readiness refusals back off (10 s, 30 s) and the runtime ticks every few seconds.
  const typed = bound && bootstrap.status === 200
    ? await within(180000, async () => ((readIf(inputFile) ?? '').includes('[purplemux mission') ? readIf(inputFile) : null))
    : null;
  const missionItems = async () => (parseJson((await inst.cli(['inbox', 'list', '-w', wsA, '--all'])).out)?.items ?? [])
    .filter((i) => i.kind === 'mission' && i.targetTabId === orch?.tabId);
  // The paste lands before the delivery is recorded (the dispatcher checks the composer first).
  if (typed) await within(30000, async () => (await missionItems()).some((i) => i.state === 'delivered'));
  // Then a further quiet interval: a second paste of the same notice would show up here.
  if (typed) await sleep(15000);
  const mission = await missionItems();
  const judged = judgeMissionTyped(readIf(inputFile) ?? '', wsA);
  check(
    'mission-bootstrap-inbox',
    'a reconcile bootstrap reaches the idle orchestrator as ONE inbox notice, typed once into its empty composer as a single line',
    standup.rc === 0 && entries.length >= 1 && mission.length === 1 && mission[0].state === 'delivered' && judged.ok,
    `orchestration ${on.rc}, stand-in ${standIn.rc}, idle ${idle}, session bound ${Boolean(bound)}; standup ${brief(standup)}; bootstrap ${bootstrap.status} with ${entries.length} entries; mission items ${mission.map((i) => i.state).join(',') || 'none'}; composer input: ${judged.measured}`,
    'standup 0; bootstrap 200 with an entry; one delivered mission item; the composer received exactly one line, the fixed bootstrap notice for this workspace',
  );
  if (orch?.tabId) await inst.cli(['tab', 'close', '-w', wsA, orch.tabId]);
  await inst.cli(['orchestration', 'off', '-w', wsA]);
};

module.exports = {
  wave4, request, humanSession, liveStandIn, standInStart, judgeMissionTyped, judgeSubagentWait,
  userLine, assistantEnd, queuedCompletion, subagentMovedShell, subagentDelivery, asyncAgentLaunch,
};
