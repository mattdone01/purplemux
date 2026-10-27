'use strict';
// The WIP cap in the isolated instance (story 20; ADR-0027). Runs before wave 1.
//
//   * fixture-cap — first it proves the state is the scratch one: neither the HOME nor its `.purplemux`
//     resolves to the live one, and its `.purplemux/port` names the state's port and not the live port.
//     The suite's fixtures stay open across checks (workspace B held 8 agent tabs when
//     wave 4 created its orchestrator, the default cap), so the run sets the SCRATCH fleet's
//     `tabs.cap-per-workspace` to FIXTURE_CAP, the key's maximum, and reads it back through the
//     server's own count route. A set or a read-back that fails stops the run: no check runs against
//     a cap the fixtures do not fit. Only the scratch HOME is ever written; the live fleet keeps
//     its own cap (ruling P6).
//   * wip-cap-refusal — SC-2: with one probe agent tab in workspace A, the cap is lowered to A's
//     count, and an agent tab create exits 3 `wip-cap` naming the count and the cap. The cap it found
//     is restored and read back, and the probe is closed. A cap that is not restored stops the run.
//
// `fixtureCapGate(inst, helpers)` returns `{ results, proceed }`, results in checks.cjs's shape.

const fs = require('fs');
const os = require('os');
const path = require('path');

const CAP_KEY = 'tabs.cap-per-workspace';
/** The key's maximum (1..200, src/lib/tab-cap.ts): no fixture create is refused by the cap. */
const FIXTURE_CAP = 200;

const realOrNull = (target) => {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
};
/** Two paths are the same only when both resolve; a path missing on one side is not the other. */
const sameReal = (a, b) => {
  const left = realOrNull(a);
  return left !== null && left === realOrNull(b);
};
const portOf = (home) => {
  try {
    return fs.readFileSync(path.join(home, '.purplemux', 'port'), 'utf8').split('\n')[0].trim() || null;
  } catch {
    return null;
  }
};

/** Why the state is not provably the scratch instance, or null. Writes nothing. */
const scratchHomeProblem = (state, liveHome) => {
  if (sameReal(state.home, liveHome)) return `the state HOME ${state.home} resolves to the live HOME ${realOrNull(liveHome)}`;
  const live = path.join(liveHome, '.purplemux');
  if (sameReal(path.join(state.home, '.purplemux'), live)) return `${state.home}/.purplemux resolves to the live ${realOrNull(live)}`;
  const port = portOf(state.home);
  if (port !== String(state.port)) return `${state.home}/.purplemux/port reads ${port ?? 'nothing'}, not the state port ${state.port}`;
  if (port === portOf(liveHome)) return `${state.home}/.purplemux/port reads ${port}, the live port`;
  return null;
};

/** The CLI's whole refusal line for `ws` at `count` of `count` (bin/cli.js prints the server's error). */
const refusalLine = (ws, count) => new RegExp(
  `^error: wip-cap \\(.*\\) — ${ws.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} holds ${count} of ${count} agent tabs$`, 'm');

const tabCount = async (inst, parseJson, ws) => {
  const result = await inst.cli(['tab', 'count', '-w', ws, '--json']);
  return { result, body: result.rc === 0 ? parseJson(result.out) : null };
};

const describeCount = (name, { result, body }, brief) => (body
  ? `${name}: count ${body.count} cap ${body.cap} (${body.capSource})`
  : `${name}: ${brief(result)}`);

/** Set the scratch fleet's cap to FIXTURE_CAP and read it back from both workspaces. */
const setFixtureCap = async (inst, { parseJson, brief }, liveHome = os.homedir()) => {
  const expected = `set exit 0; cap ${FIXTURE_CAP} from fleet-config in both workspaces`;
  const problem = scratchHomeProblem(inst.state, liveHome);
  if (problem) return { ok: false, measured: `${problem}; nothing set`, expected: `the scratch HOME and port; ${expected}` };
  const set = await inst.cli(['config', 'set', CAP_KEY, String(FIXTURE_CAP)]);
  const { a: wsA, b: wsB } = inst.state.workspaces;
  const reads = [['A', await tabCount(inst, parseJson, wsA)], ['B', await tabCount(inst, parseJson, wsB)]];
  const ok = set.rc === 0 && reads.every(([, read]) => read.body?.cap === FIXTURE_CAP && read.body?.capSource === 'fleet-config');
  return { ok, measured: `set ${brief(set)}; ${reads.map(([name, read]) => describeCount(name, read, brief)).join('; ')}`, expected };
};

/** SC-2 on the isolated instance; `restored` is false only when the cap it found was changed and not put back. */
const wipCapRefusal = async (inst, { parseJson, brief, nonce }) => {
  const id = 'wip-cap-refusal';
  const what = 'an agent tab create at the cap exits 3 wip-cap naming the count and the cap; the scratch cap is left as found';
  const expected = 'probe created; the create at the cap exits 3 with the line "error: wip-cap (…) — <A> holds N of N agent tabs", no tab made; cap and source restored; probe closed';
  const { a: ws } = inst.state.workspaces;
  const found = await tabCount(inst, parseJson, ws);
  // Only a cap that can be put back exactly is lowered: a fleet-config value is set again, an unset one unset.
  if (!found.body || !['fleet-config', 'default'].includes(found.body.capSource)) {
    return { restored: true, result: { status: 'fail', id, what, measured: `${describeCount('found', found, brief)}; nothing changed`, expected } };
  }
  const create = (name) => inst.cli(['tab', 'create', '-w', ws, '-n', `${name}-${nonce}`, '-t', 'claude-code', '--no-launch']);
  const probe = parseJson((await create('acc-cap-probe')).out);
  const at = await tabCount(inst, parseJson, ws);
  const atCount = at.body?.count;
  const lowered = probe?.tabId && Number.isInteger(atCount) && atCount >= 1
    ? await inst.cli(['config', 'set', CAP_KEY, String(atCount)])
    : { rc: -1, out: '', err: `no probe or count: ${describeCount('at', at, brief)}` };
  const over = lowered.rc === 0 ? await create('acc-cap-over') : { rc: -1, out: '', err: 'the cap was not lowered' };
  const overTab = parseJson(over.out);
  const afterOver = await tabCount(inst, parseJson, ws);
  const restore = found.body.capSource === 'fleet-config'
    ? await inst.cli(['config', 'set', CAP_KEY, String(found.body.cap)])
    : await inst.cli(['config', 'unset', CAP_KEY]);
  const back = await tabCount(inst, parseJson, ws);
  // Unsetting a key that is already unset exits 7 (config-not-found); the read-back decides.
  const restoreRan = restore.rc === 0 || (found.body.capSource === 'default' && restore.rc === 7);
  const restored = restoreRan && back.body?.cap === found.body.cap && back.body?.capSource === found.body.capSource;
  const closes = [];
  for (const tab of [probe, overTab]) {
    if (tab?.tabId) closes.push(`${tab.tabId} ${brief(await inst.cli(['tab', 'close', '-w', ws, tab.tabId]))}`);
  }
  const final = await tabCount(inst, parseJson, ws);
  const named = Number.isInteger(atCount) && refusalLine(ws, atCount).test(over.err);
  const ok = Boolean(probe?.tabId) && lowered.rc === 0 && over.rc === 3 && named
    && !overTab?.tabId && afterOver.body?.count === atCount && restored && final.body?.count === found.body.count;
  const measured = `${describeCount('found', found, brief)}; probe ${probe?.tabId ?? 'none'}; ${describeCount('at', at, brief)}; `
    + `lower ${brief(lowered)}; create at the cap ${brief(over)}${overTab?.tabId ? ` made ${overTab.tabId}` : ''}; `
    + `${describeCount('after', afterOver, brief)}; restore ${brief(restore)}; ${describeCount('restored', back, brief)}; `
    + `closed ${closes.join(', ') || 'none'}; ${describeCount('final', final, brief)}`;
  return { restored, result: ok ? { status: 'pass', id, what } : { status: 'fail', id, what, measured, expected } };
};

const fixtureCapGate = async (inst, helpers, opts = {}) => {
  const { proceed, results } = await runGate(inst, helpers, opts);
  // checks.cjs summarize: these results alone never make a run pass.
  return { proceed, results: results.map((result) => ({ ...result, gate: true })) };
};

const runGate = async (inst, helpers, { liveHome = os.homedir(), refusalCheck = true } = {}) => {
  const set = await setFixtureCap(inst, helpers, liveHome);
  const what = `the scratch fleet's ${CAP_KEY} is ${FIXTURE_CAP}, read back, before any check runs`;
  if (!set.ok) {
    return { proceed: false, results: [{ status: 'fail', id: 'fixture-cap', what: `${what}; no check ran`, measured: set.measured, expected: set.expected }] };
  }
  const results = [{ status: 'pass', id: 'fixture-cap', what }];
  if (!refusalCheck) return { proceed: true, results };
  const refusal = await wipCapRefusal(inst, helpers);
  results.push(refusal.result);
  if (!refusal.restored) {
    results.push({ status: 'fail', id: 'fixture-cap-restore', what: `the scratch ${CAP_KEY} is restored after wip-cap-refusal; no later check ran`,
      measured: refusal.result.measured ?? 'not restored', expected: `cap ${FIXTURE_CAP} from fleet-config` });
    return { proceed: false, results };
  }
  return { proceed: true, results };
};

module.exports = { CAP_KEY, FIXTURE_CAP, setFixtureCap, wipCapRefusal, fixtureCapGate, scratchHomeProblem, refusalLine };
