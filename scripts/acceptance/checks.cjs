#!/usr/bin/env node
// Wave-1 acceptance checks against an ISOLATED purplemux instance (story 07; ADR-0017 amendment).
//
//   checks.cjs --state <state.json> [--bash-guard <bash-guard.py>] [--require-bash-guard]
//
// The state file is written by isolated-instance.sh `up`: the candidate directory, the node binary,
// the scratch HOME / TMUX_TMPDIR, the port and the two workspace ids. Every CLI call runs the
// CANDIDATE's installed entry point `bin/purplemux.js` with a clean environment (PATH, HOME,
// TMUX_TMPDIR only), so no token or socket of the live service can leak into a check.
//
// A check that runs "in a tab" types a one-line command into a terminal tab with `tab send` and
// reads the exit code the line writes to a file: the tab's own PMUX_TAB_ID / PMUX_TAB_TOKEN make the
// call, which is the only way to prove per-tab identity (story 01) end to end.
//
// Story 15 (ADR-0018) is proven without a real agent: a `claude-code` tab created with --no-launch
// runs the scratch stand-in `claude --resume <uuid>` (how purplemux finds a tab's transcript), a
// fixture transcript ends the turn, and the Claude hook events (`session-start`, `prompt-submit`,
// `stop`) are posted to /api/status/hook the way the installed hook script posts them. The real
// classifier then decides turn-marker, WAITING or READY FOR REVIEW, and `orchestration status`
// shows the nudge it recorded.
//
// Output: one line per check — `PASS <id> — <what>`, `FAIL <id> — <what> — measured: … — expected: …`
// or `SKIP <id> — <why>` — then `ACCEPTANCE=PASS|FAIL checks=N passed=P failed=F skipped=S`.
// Exit 0 only when nothing failed (and, with --require-bash-guard, nothing was skipped).

'use strict';

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const POLL_MS = 200;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Judge the SC-1 race: exactly one acquire wins (0) and the other is refused (3) naming the winner. */
const judgeRace = (a, b, idA, idB) => {
  const winners = [a, b].filter((r) => r.rc === 0).length;
  const losers = [a, b].filter((r) => r.rc === 3);
  if (winners !== 1 || losers.length !== 1) {
    return { ok: false, measured: `exit codes ${a.rc} and ${b.rc}`, expected: 'exactly one 0 and one 3' };
  }
  const winnerId = a.rc === 0 ? idA : idB;
  const loser = a.rc === 3 ? a : b;
  const named = `${loser.out}\n${loser.err}`.includes(winnerId);
  return named
    ? { ok: true, winnerId, loserId: winnerId === idA ? idB : idA }
    : { ok: false, measured: `the refusal does not name ${winnerId}: ${loser.err.trim().slice(0, 200)}`, expected: 'the holder named' };
};

/** Aggregate check results into the report lines and the verdict. */
const summarize = (results, { requireBashGuard = false } = {}) => {
  const lines = results.map((r) => {
    if (r.status === 'pass') return `PASS ${r.id} — ${r.what}`;
    if (r.status === 'skip') return `SKIP ${r.id} — ${r.why}`;
    return `FAIL ${r.id} — ${r.what} — measured: ${r.measured} — expected: ${r.expected}`;
  });
  const count = (s) => results.filter((r) => r.status === s).length;
  const failed = count('fail');
  const skipped = count('skip');
  const guardSkipped = results.some((r) => r.status === 'skip' && r.id === 'bash-guard');
  const pass = failed === 0 && results.length > 0 && !(requireBashGuard && guardSkipped);
  lines.push(`ACCEPTANCE=${pass ? 'PASS' : 'FAIL'} checks=${results.length} passed=${count('pass')} failed=${failed} skipped=${skipped}`);
  return { lines, pass };
};

class Instance {
  constructor(state) {
    this.state = state;
    this.cliPath = path.join(state.candidate, 'bin', 'purplemux.js');
    this.env = { PATH: `${path.dirname(state.node)}:/usr/bin:/bin`, HOME: state.home, TMUX_TMPDIR: state.tmuxTmpdir };
  }

  /** Run the candidate CLI as the admin token (no tab), with a clean environment. */
  cli(args, { env = this.env, timeoutMs = 30000 } = {}) {
    return run(this.state.node, [this.cliPath, ...args], { env, timeoutMs });
  }

  /** Type `command` into a terminal tab; wait for the exit code it writes. */
  async inTab(ws, tab, command, { timeoutMs = 30000 } = {}) {
    const tag = crypto.randomBytes(4).toString('hex');
    const base = path.join(this.state.scratch, 'io', `${tab}-${tag}`);
    fs.mkdirSync(path.dirname(base), { recursive: true });
    const line = `( ${command} ) > ${base}.out 2> ${base}.err; echo $? > ${base}.rc`;
    const sent = await this.cli(['tab', 'send', '-w', ws, tab, line]);
    if (sent.rc !== 0) return { rc: -1, out: '', err: `tab send exited ${sent.rc}: ${sent.err.trim()}` };
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const rcText = readIf(`${base}.rc`);
      if (rcText !== null && rcText.trim() !== '') {
        return { rc: Number(rcText.trim()), out: readIf(`${base}.out`) || '', err: readIf(`${base}.err`) || '' };
      }
      await sleep(POLL_MS);
    }
    return { rc: -1, out: '', err: `no exit code within ${timeoutMs} ms` };
  }

  /** POST a Claude hook event for a tab's tmux session, as the installed hook script does. */
  hook(event, session) {
    const token = fs.readFileSync(path.join(this.state.home, '.purplemux', 'cli-token'), 'utf8').trim();
    const body = JSON.stringify({ event, session });
    return new Promise((resolve) => {
      const req = http.request(
        { host: '127.0.0.1', port: this.state.port, path: '/api/status/hook', method: 'POST', headers: { 'Content-Type': 'application/json', 'x-pmux-token': token, 'Content-Length': Buffer.byteLength(body) } },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        },
      );
      req.on('error', () => resolve(0));
      req.end(body);
    });
  }

  /** Start the scratch `claude` stand-in in an agent tab's pane, over the ISOLATED tmux socket only. */
  async startStandIn(session, transcriptText) {
    const tmuxDir = this.state.tmuxTmpdir;
    if (!tmuxDir.startsWith(`${this.state.scratch}/`)) throw new Error(`tmux dir ${tmuxDir} is not under the scratch directory`);
    const uuid = crypto.randomUUID();
    const cwd = path.join(this.state.scratch, 'work', 'b');
    const project = path.join(this.state.home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
    fs.mkdirSync(project, { recursive: true });
    const lines = [
      { type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: 'go' } },
      { type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: transcriptText }] } },
    ];
    fs.writeFileSync(path.join(project, `${uuid}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
    const env = { PATH: '/usr/bin:/bin', TMUX_TMPDIR: tmuxDir };
    const standIn = path.join(this.state.scratch, 'bin', 'claude');
    return run('tmux', ['-L', 'purple', 'send-keys', '-t', session, `${standIn} --resume ${uuid}`, 'Enter'], { env, timeoutMs: 10000 });
  }

  async nudgesFor(ws, tabId) {
    const r = await this.cli(['orchestration', 'status', '-w', ws]);
    return (parseJson(r.out)?.nudges || []).filter((n) => n.tabId === tabId);
  }

  async cliState(ws, tabId) {
    return parseJson((await this.cli(['tab', 'status', '-w', ws, tabId])).out)?.cliState ?? null;
  }

  /** The candidate CLI as a one-line shell command, for use inside a tab (whose PATH has no node). */
  tabCli(args) {
    return [this.state.node, this.cliPath, ...args].map(shellQuote).join(' ');
  }
}

const readIf = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

const shellQuote = (s) => (/^[A-Za-z0-9_./:@%+=,-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);

const run = (bin, args, { env, timeoutMs }) =>
  new Promise((resolve) => {
    const child = spawn(bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ rc: code === null ? -1 : code, out, err: signal ? `${err}\nkilled by ${signal}` : err });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ rc: -1, out, err: String(e) });
    });
  });

const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const brief = (r) => `exit ${r.rc}${r.err.trim() ? `, stderr: ${r.err.trim().split('\n')[0].slice(0, 160)}` : ''}`;

/** The wave-1 checks. Each pushes one result; a failed prerequisite fails what depends on it. */
const wave1 = async (inst, { bashGuard }) => {
  const results = [];
  const nonce = crypto.randomBytes(3).toString('hex');
  const { a: wsA, b: wsB } = inst.state.workspaces;
  const pass = (id, what) => results.push({ status: 'pass', id, what });
  const fail = (id, what, measured, expected) => results.push({ status: 'fail', id, what, measured, expected });
  const skip = (id, why) => results.push({ status: 'skip', id, why });
  const check = (id, what, ok, measured, expected) => (ok ? pass(id, what) : fail(id, what, measured, expected));

  // ---- tabs: create / list / send / result / status
  const tabs = {};
  for (const [key, ws] of [['A1', wsA], ['A2', wsA], ['B1', wsB]]) {
    const r = await inst.cli(['tab', 'create', '-w', ws, '-n', `acc-${key.toLowerCase()}`, '-t', 'terminal']);
    const body = parseJson(r.out);
    if (r.rc === 0 && body && body.tabId && body.panelType === 'terminal') tabs[key] = body.tabId;
  }
  const haveTabs = Boolean(tabs.A1 && tabs.A2 && tabs.B1);
  check('tab-create', 'three terminal tabs created in two workspaces', haveTabs, JSON.stringify(tabs), 'tab ids for A1, A2, B1');
  if (!haveTabs) return results;
  await sleep(1000);

  const list = await inst.cli(['tab', 'list', '-w', wsA]);
  const listed = list.rc === 0 && list.out.includes(tabs.A1) && list.out.includes(tabs.A2) && !list.out.includes(tabs.B1);
  check('tab-list', 'tab list -w A shows A1 and A2 and not B1', listed, brief(list), 'exit 0 with exactly the workspace-A tabs');

  const marker = `ACC-$((6*7))-${nonce}`;
  const sent = await inst.cli(['tab', 'send', '-w', wsA, tabs.A1, `echo ${marker}`]);
  let seen = false;
  for (let i = 0; i < 50 && !seen && sent.rc === 0; i++) {
    const res = await inst.cli(['tab', 'result', '-w', wsA, tabs.A1]);
    seen = res.rc === 0 && res.out.includes(`ACC-42-${nonce}`);
    if (!seen) await sleep(POLL_MS);
  }
  check('tab-send-result', 'tab send runs a line and tab result shows its output', seen, `send ${brief(sent)}; output seen: ${seen}`, `ACC-42-${nonce} in the pane`);

  const status = await inst.cli(['tab', 'status', '-w', wsA, tabs.A1]);
  check('tab-status', 'tab status answers for a live tab', status.rc === 0 && status.out.includes(tabs.A1), brief(status), `exit 0 naming ${tabs.A1}`);

  // ---- caller identity (story 01)
  const env = await inst.inTab(wsA, tabs.A1, 'printf "%s" "$PMUX_TAB_ID"; test -n "$PMUX_TAB_TOKEN"');
  check('identity-env', 'a tab carries PMUX_TAB_ID and PMUX_TAB_TOKEN', env.rc === 0 && env.out === tabs.A1, `exit ${env.rc}, PMUX_TAB_ID=${env.out}`, `exit 0, PMUX_TAB_ID=${tabs.A1}`);

  // ---- leases (stories 03, 27): the SC-1 race across two workspaces
  const race = `merge:acc/race-${nonce}`;
  const [ra, rb] = await Promise.all([
    inst.inTab(wsA, tabs.A1, inst.tabCli(['lease', 'acquire', race, '--ttl', '5m'])),
    inst.inTab(wsB, tabs.B1, inst.tabCli(['lease', 'acquire', race, '--ttl', '5m'])),
  ]);
  const judged = judgeRace(ra, rb, tabs.A1, tabs.B1);
  check('lease-race', 'two tabs in two workspaces race one merge lease: one wins, one is refused naming the holder', judged.ok, judged.measured, judged.expected);
  if (judged.ok) {
    const winnerWs = judged.winnerId === tabs.A1 ? wsA : wsB;
    const loserWs = winnerWs === wsA ? wsB : wsA;
    const listing = await inst.cli(['lease', 'list', '--json']);
    const lease = (parseJson(listing.out)?.leases || []).find((l) => l.name === race);
    check(
      'lease-verified',
      'lease list shows the winning tab as a verified holder',
      Boolean(lease && lease.holder.tabId === judged.winnerId && lease.holder.verified === true),
      JSON.stringify(lease?.holder || null),
      `holder.tabId=${judged.winnerId}, verified=true`,
    );
    const renew = await inst.inTab(winnerWs, judged.winnerId, inst.tabCli(['lease', 'renew', race, '--ttl', '10m']));
    const stolen = await inst.inTab(loserWs, judged.loserId, inst.tabCli(['lease', 'release', race]));
    const released = await inst.inTab(winnerWs, judged.winnerId, inst.tabCli(['lease', 'release', race]));
    const after = await inst.cli(['lease', 'check', race]);
    check(
      'lease-renew-release',
      'the holder renews and releases; another tab cannot release it',
      renew.rc === 0 && stolen.rc === 3 && released.rc === 0 && after.rc === 7,
      `renew ${renew.rc}, release by other ${stolen.rc}, release by holder ${released.rc}, check after ${after.rc}`,
      'renew 0, release by other 3, release by holder 0, check after 7',
    );
  } else {
    fail('lease-verified', 'lease list shows the winning tab as a verified holder', 'no winner', 'the race decided first');
    fail('lease-renew-release', 'the holder renews and releases', 'no winner', 'the race decided first');
  }

  const ttlName = `acc:ttl-${nonce}`;
  const short = await inst.inTab(wsA, tabs.A1, inst.tabCli(['lease', 'acquire', ttlName, '--ttl', '2s']));
  let expired = false;
  for (let i = 0; i < 60 && !expired && short.rc === 0; i++) {
    await sleep(250);
    expired = (await inst.cli(['lease', 'check', ttlName])).rc === 7;
  }
  check('lease-expiry', 'a 2 s lease is gone within 15 s', short.rc === 0 && expired, `acquire ${short.rc}, expired ${expired}`, 'acquire 0, then lease check exit 7');

  // ---- bash-guard (engineering story 04) against the candidate CLI, from inside the tabs
  if (!bashGuard) {
    skip('bash-guard', 'no --bash-guard path given');
  } else {
    const repo = `acc/guard-${nonce}`;
    const wrapper = path.join(inst.state.scratch, 'bin', 'purplemux');
    fs.mkdirSync(path.dirname(wrapper), { recursive: true });
    fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${shellQuote(inst.state.node)} ${shellQuote(inst.cliPath)} "$@"\n`, { mode: 0o755 });
    const payload = path.join(inst.state.scratch, `guard-${nonce}.json`);
    fs.writeFileSync(payload, JSON.stringify({ tool_input: { command: `gh pr merge 1 --repo ${repo} --squash` }, cwd: inst.state.scratch }));
    const guard = `BASH_GUARD_PURPLEMUX=${shellQuote(wrapper)} python3 ${shellQuote(bashGuard)} < ${shellQuote(payload)}`;
    const held = await inst.inTab(wsA, tabs.A1, inst.tabCli(['lease', 'acquire', `merge:${repo}`, '--ttl', '5m']));
    const allowed = await inst.inTab(wsA, tabs.A1, guard);
    const refused = await inst.inTab(wsB, tabs.B1, guard);
    await inst.inTab(wsA, tabs.A1, inst.tabCli(['lease', 'release', `merge:${repo}`]));
    check(
      'bash-guard',
      'bash-guard allows a merge from the lease holder and refuses it from another tab',
      held.rc === 0 && allowed.rc === 0 && refused.rc === 2,
      `acquire ${held.rc}, guard in holder ${allowed.rc} (${allowed.err.trim().split('\n')[0] || 'no message'}), guard in other tab ${refused.rc}`,
      'acquire 0, guard in holder 0, guard in other tab 2',
    );
  }

  // ---- epic ownership (SC-2): refused while held, free once the holder tab closes
  const epic = `acc-${nonce}`;
  const own = await inst.inTab(wsA, tabs.A1, inst.tabCli(['lease', 'acquire', `epic:${epic}`, '--ttl', 'none']));
  const second = await inst.inTab(wsA, tabs.A2, inst.tabCli(['lease', 'acquire', `epic:${epic}`, '--ttl', 'none']));
  const closed = await inst.cli(['tab', 'close', '-w', wsA, tabs.A1]);
  let taken = { rc: -1, out: '', err: 'not tried' };
  const deadline = Date.now() + 60000;
  while (closed.rc === 0 && Date.now() < deadline) {
    taken = await inst.inTab(wsA, tabs.A2, inst.tabCli(['lease', 'acquire', `epic:${epic}`, '--ttl', 'none']));
    if (taken.rc === 0) break;
    await sleep(1000);
  }
  check(
    'epic-ownership',
    'an epic claim refuses a second tab and frees when its holder tab closes',
    own.rc === 0 && second.rc === 3 && closed.rc === 0 && taken.rc === 0,
    `acquire ${own.rc}, second ${second.rc}, close ${closed.rc}, second after close ${taken.rc}`,
    'acquire 0, second 3, close 0, second after close 0 within 60 s',
  );

  // ---- number claims survive the tab; release-epic releases them
  const num = `num:acc/repo-${nonce}:adr:0001`;
  const claim = await inst.inTab(wsA, tabs.A2, inst.tabCli(['lease', 'acquire', num, '--epic', epic]));
  const closedA2 = await inst.cli(['tab', 'close', '-w', wsA, tabs.A2]);
  await sleep(1000);
  const survived = await inst.cli(['lease', 'check', num]);
  const releaseEpic = await inst.cli(['lease', 'release-epic', epic]);
  const gone = await inst.cli(['lease', 'check', num]);
  check(
    'num-claim',
    'a number claim survives its tab closing and release-epic releases it',
    claim.rc === 0 && closedA2.rc === 0 && parseJson(survived.out)?.held === true && releaseEpic.rc === 0 && gone.rc === 7,
    `claim ${claim.rc}, close ${closedA2.rc}, held after close ${parseJson(survived.out)?.held}, release-epic ${releaseEpic.rc}, check after ${gone.rc}`,
    'claim 0, close 0, held after close true, release-epic 0, check after 7',
  );

  // ---- the CLI error contract (story 02)
  const gonePane = await inst.cli(['tab', 'send', '-w', wsA, tabs.A1, 'echo late']);
  check('exit-4-target-gone', 'tab send to a closed tab exits 4', gonePane.rc === 4, brief(gonePane), 'exit 4');
  const usage = await inst.cli(['definitely-not-a-command']);
  check('exit-2-usage', 'an unknown command exits 2', usage.rc === 2, brief(usage), 'exit 2');
  const nobody = await inst.cli(['lease', 'check', `merge:acc/nobody-${nonce}`]);
  check('exit-7-not-found', 'lease check of an unheld name exits 7 and prints held:false', nobody.rc === 7 && parseJson(nobody.out)?.held === false, brief(nobody), 'exit 7, {"held":false}');

  const fakeHome = path.join(inst.state.scratch, 'fake-home');
  fs.mkdirSync(path.join(fakeHome, '.purplemux'), { recursive: true });
  fs.writeFileSync(path.join(fakeHome, '.purplemux', 'cli-token'), 'x\n');
  const deadPort = await freePort();
  fs.writeFileSync(path.join(fakeHome, '.purplemux', 'port'), `${deadPort}\n`);
  const fakeEnv = { ...inst.env, HOME: fakeHome };
  const unreachable = await inst.cli(['lease', 'list'], { env: fakeEnv });
  check('exit-6-unreachable', 'a server that does not answer exits 6 server-unreachable', unreachable.rc === 6 && unreachable.err.includes('server-unreachable'), brief(unreachable), 'exit 6, server-unreachable');

  const oldServer = http.createServer((req, res) => {
    res.writeHead(404, { 'Content-Type': 'text/html' });
    res.end('<html>404</html>');
  });
  await new Promise((resolve) => oldServer.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(path.join(fakeHome, '.purplemux', 'port'), `${oldServer.address().port}\n`);
  const absent = await inst.cli(['lease', 'list'], { env: fakeEnv });
  await new Promise((resolve) => oldServer.close(resolve));
  check('exit-6-routes-absent', 'a server without the lease routes exits 6 routes-absent', absent.rc === 6 && absent.err.includes('routes-absent'), brief(absent), 'exit 6, routes-absent');

  await inst.cli(['tab', 'close', '-w', wsB, tabs.B1]);
  await story15(inst, { nonce, wsB, pass, fail, check });
  return results;
};

/** Poll `probe` every POLL_MS until it returns a truthy value or `ms` passes. */
const within = async (ms, probe) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value || Date.now() >= deadline) return value;
    await sleep(POLL_MS);
  }
};

/** Story 15 (ADR-0018): turn-end markers, WAITING, and today's READY FOR REVIEW, in workspace B. */
const story15 = async (inst, { nonce, wsB, fail, check }) => {
  const orch = parseJson((await inst.cli(['tab', 'create', '-w', wsB, '-n', 'acc-orch', '-t', 'terminal'])).out)?.tabId;
  const on = orch ? await inst.cli(['orchestration', 'on', '-w', wsB, orch]) : { rc: -1, out: '', err: 'no orchestrator tab' };
  if (!orch || on.rc !== 0) {
    for (const id of ['turn-marker', 'turn-waiting', 'turn-ready']) fail(id, 'story 15 turn-end classification', `orchestration on: ${brief(on)}`, 'an orchestrator tab in workspace B');
    return;
  }
  const worker = async (name, transcript) => {
    const created = parseJson((await inst.cli(['tab', 'create', '-w', wsB, '-n', name, '-t', 'claude-code', '--no-launch'])).out);
    if (!created?.tabId) return null;
    await sleep(500);
    const started = await inst.startStandIn(created.sessionName, transcript);
    return started.rc === 0 ? created : null;
  };
  const stopTurn = async (w) => {
    await sleep(1000);
    await inst.hook('session-start', w.sessionName);
    await inst.hook('prompt-submit', w.sessionName);
    const busy = await within(10000, async () => (await inst.cliState(wsB, w.tabId)) === 'busy');
    const stopped = await inst.hook('stop', w.sessionName);
    return busy && stopped === 204;
  };

  const markerLine = `BLOCKED: acceptance marker ${nonce} — needs nothing`;
  const w1 = await worker('acc-marker', `Work done.\n\n${markerLine}`);
  const w1Stopped = w1 ? await stopTurn(w1) : false;
  const marker = w1Stopped ? await within(10000, async () => (await inst.nudgesFor(wsB, w1.tabId)).find((n) => n.kind === 'turn-marker')) : null;
  check(
    'turn-marker',
    'a stop whose last line is a marker sends a turn-marker nudge carrying that line',
    Boolean(marker && marker.message.includes(markerLine)),
    marker ? marker.message : `worker ${w1 ? 'created' : 'not created'}, stop ${w1Stopped ? 'posted' : 'not posted'}, no turn-marker nudge`,
    `a turn-marker nudge containing "${markerLine}"`,
  );

  // WAITING, proven by order and by timestamps rather than by a quiet interval (review round 1): a
  // later plain stop (w3) must have produced its nudge before w2 is read, and once w2's job ends,
  // w2's next stop must nudge READY with a timestamp after the job ended — a build that ignored the
  // job would have nudged at the first stop instead.
  const job = spawn('sleep', ['600'], { stdio: 'ignore', detached: true, env: { PATH: '/usr/bin:/bin', HOME: inst.state.home } });
  const stopJob = () => {
    try {
      process.kill(job.pid);
    } catch {
      // already gone
    }
  };
  process.on('exit', stopJob);
  const w2 = await worker('acc-waiting', 'Gate started; waiting on it.');
  const w3 = await worker('acc-plain', 'Finished the task.');
  const registered = w2 ? await inst.cli(['tab', 'bg', 'add', '-w', wsB, w2.tabId, '--pid', String(job.pid), '--label', 'acc-gate']) : { rc: -1, out: '', err: 'no worker' };
  const w2Stopped = w2 && registered.rc === 0 ? await stopTurn(w2) : false;
  const w3Stopped = w3 ? await stopTurn(w3) : false;
  const ready = w3Stopped ? await within(10000, async () => (await inst.nudgesFor(wsB, w3.tabId)).find((n) => n.kind === 'ready-for-review')) : null;
  check(
    'turn-ready',
    'a stop with no marker and no open work keeps today\'s READY FOR REVIEW nudge',
    Boolean(ready),
    ready ? ready.kind : `stop ${w3Stopped ? 'posted' : 'not posted'}, no ready-for-review nudge`,
    'a ready-for-review nudge',
  );
  const w2State = w2 ? await inst.cliState(wsB, w2.tabId) : null;
  const w2Early = w2 ? await inst.nudgesFor(wsB, w2.tabId) : [];
  stopJob();
  // Gone, not a zombie: the server's liveness probe is kill(pid, 0), which a zombie still passes.
  const jobEnded = await within(5000, async () => !fs.existsSync(`/proc/${job.pid}`));
  const endedAt = Date.now();
  const w2Again = w2 && jobEnded ? await inst.hook('stop', w2.sessionName) : 0;
  const woke = w2Again === 204 ? await within(10000, async () => (await inst.nudgesFor(wsB, w2.tabId)).find((n) => n.kind === 'ready-for-review')) : null;
  check(
    'turn-waiting',
    'a stop with no marker and a live registered job is WAITING (busy, no nudge); once the job ends the next stop is READY',
    Boolean(w2Stopped && ready && w2State === 'busy' && w2Early.length === 0 && woke && woke.at >= endedAt),
    `bg add ${registered.rc}, stop posted ${w2Stopped}, after w3's nudge: cliState ${w2State}, nudges ${w2Early.map((n) => n.kind).join(',') || 'none'}; after the job ended: ${woke ? `ready nudge at +${woke.at - endedAt} ms` : 'no ready nudge'}`,
    'bg add 0, stop posted, cliState busy, no nudge; then a ready nudge stamped after the job ended',
  );
};

const freePort = () =>
  new Promise((resolve) => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

const parseArgs = (argv) => {
  const opts = { state: null, bashGuard: null, requireBashGuard: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--state') opts.state = argv[++i];
    else if (argv[i] === '--bash-guard') opts.bashGuard = argv[++i];
    else if (argv[i] === '--require-bash-guard') opts.requireBashGuard = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!opts.state) throw new Error('usage: checks.cjs --state <state.json> [--bash-guard <path>] [--require-bash-guard]');
  return opts;
};

const main = async (argv) => {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    return 2;
  }
  const state = parseJson(readIf(opts.state) || '');
  if (!state || !state.candidate || !state.home || !state.workspaces) {
    process.stderr.write(`REFUSED STATE — ${opts.state} is not an isolated-instance state file\n`);
    return 2;
  }
  if (opts.bashGuard && !fs.existsSync(opts.bashGuard)) {
    process.stderr.write(`REFUSED BASH-GUARD — ${opts.bashGuard} does not exist\n`);
    return 2;
  }
  const results = await wave1(new Instance(state), opts);
  const { lines, pass } = summarize(results, opts);
  process.stdout.write(`${lines.join('\n')}\n`);
  return pass ? 0 : 1;
};

module.exports = { judgeRace, summarize, shellQuote, parseArgs };

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
