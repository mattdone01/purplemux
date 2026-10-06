#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  Instance, pollObservation, processDescendsFrom, processIdentity,
} = require('./checks.cjs');
const { liveStandIn, standInRecord } = require('./checks-wave4.cjs');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const parseArgs = (argv) => {
  const options = { evidenceDir: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--evidence-dir') options.evidenceDir = argv[++i];
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!options.evidenceDir) throw new Error('usage: fixture-topology.cjs --evidence-dir <path>');
  return options;
};

const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  const evidenceDir = path.resolve(options.evidenceDir);
  fs.mkdirSync(evidenceDir, { recursive: true });
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pmxtop.'));
  const home = path.join(scratch, 'home');
  const tmuxTmpdir = path.join(scratch, 'tmux');
  const work = path.join(scratch, 'work', 'a');
  const input = path.join(scratch, 'input.txt');
  const session = 'fixture-topology';
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(tmuxTmpdir, { recursive: true });
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(input, '');
  const tmuxEnv = { ...process.env, HOME: home, TMUX_TMPDIR: tmuxTmpdir, PATH: '/usr/bin:/bin' };
  const state = {
    scratch,
    home,
    tmuxTmpdir,
    candidate: path.resolve(__dirname, '../..'),
    node: process.execPath,
    workspaces: { a: 'ws-topology-a', b: 'ws-topology-b' },
    evidenceDir,
  };
  const inst = new Instance(state);
  const result = { scratch, evidenceDir, session, launches: [], passed: false };

  const stopServer = () => spawnSync('tmux', ['-L', 'purple', 'kill-server'], { env: tmuxEnv, encoding: 'utf8' });
  const fail = (message, details = null) => {
    const error = new Error(message);
    error.details = details;
    throw error;
  };
  const observe = async (sessionId, launchedAfter) => pollObservation(10000, async () => {
    const commandResult = await inst.isolatedTmux(['display-message', '-p', '-t', session, '#{pane_current_command}']);
    const panePid = await inst.isolatedPanePid(session);
    const pane = processIdentity(panePid);
    const record = standInRecord(home, sessionId);
    const child = processIdentity(record?.pid);
    const wrapper = processIdentity(child?.ppid);
    const facts = {
      commandResult,
      command: commandResult.out.trim(),
      panePid,
      pane,
      record,
      child,
      wrapper,
      freshRecord: Boolean(record && record.startedAt >= launchedAfter - 1000),
      childDescendsFromPane: Boolean(child && panePid && processDescendsFrom(child.pid, panePid)),
      wrapperDescendsFromPane: Boolean(wrapper && panePid && processDescendsFrom(wrapper.pid, panePid)),
      sameForegroundGroup: Boolean(pane && wrapper && child && pane.tpgid > 0
        && wrapper.pgrp === pane.tpgid && child.pgrp === pane.tpgid),
    };
    const ok = commandResult.rc === 0 && facts.command === 'claude' && facts.freshRecord
      && child?.state !== 'Z' && child?.argv0 === 'claude'
      && wrapper?.state !== 'Z' && wrapper?.argv0 === 'claude'
      && facts.childDescendsFromPane && facts.wrapperDescendsFromPane && facts.sameForegroundGroup;
    return { ok, facts };
  });

  const launch = async (label) => {
    const launchedAfter = Date.now();
    const started = await inst.startStandIn(session, 'Ready.', {
      workspaceDir: 'a', inputFile: input, standInPath: liveStandIn(scratch), verifiedShell: true,
    });
    if (started.rc !== 0) fail(`${label} launch failed`, started);
    const sessionId = path.basename(started.transcriptPath, '.jsonl');
    const observation = await observe(sessionId, launchedAfter);
    const launchResult = { label, launchedAfter, sessionId, started, observation };
    result.launches.push(launchResult);
    writeJson(path.join(evidenceDir, `${label}-launch.json`), launchResult);
    if (!observation.ok) fail(`${label} topology failed`, launchResult);
    return launchResult;
  };

  const stop = async (label, launchResult) => {
    const typed = await inst.keys(session, 'C-c');
    const receipt = await pollObservation(5000, async () => {
      const rc = inst.shellReceipt(launchResult.started.operation);
      return { ok: rc !== null, rc };
    });
    const childGone = await pollObservation(5000, async () => ({
      ok: processIdentity(launchResult.observation.facts.record.pid) === null,
      process: processIdentity(launchResult.observation.facts.record.pid),
    }));
    const shell = await inst.isolatedShellState(session);
    const stopped = { label, typed, receipt, childGone, shell };
    writeJson(path.join(evidenceDir, `${label}-stop.json`), stopped);
    if (typed.rc !== 0 || receipt.rc !== 130 || !childGone.ok || !shell.ok) fail(`${label} stop failed`, stopped);
    return stopped;
  };

  try {
    const created = spawnSync('tmux', ['-L', 'purple', 'new-session', '-d', '-s', session, '-c', work, '/bin/bash', '--noprofile', '--norc'], {
      env: tmuxEnv,
      encoding: 'utf8',
    });
    if (created.status !== 0) fail('tmux session creation failed', created);
    const initialShell = await pollObservation(5000, () => inst.isolatedShellState(session));
    if (!initialShell.ok) fail('initial foreground shell not proven', initialShell);

    const first = await launch('first');
    const sent = await inst.keys(session, 'topology-input');
    const inputReached = sent.rc === 0
      ? await pollObservation(3000, async () => ({
        ok: fs.readFileSync(input, 'utf8').includes('topology-input'),
        input: fs.readFileSync(input, 'utf8'),
      }))
      : { ok: false, input: fs.readFileSync(input, 'utf8') };
    writeJson(path.join(evidenceDir, 'input.json'), { sent, inputReached });
    if (!inputReached.ok) fail('input did not reach the live stand-in', { sent, inputReached });
    await stop('first', first);

    const second = await launch('second');
    if (second.sessionId === first.sessionId || second.observation.facts.record.pid === first.observation.facts.record.pid) {
      fail('relaunch reused the prior identity', { first, second });
    }
    await stop('second', second);
    result.passed = true;
    writeJson(path.join(evidenceDir, 'summary.json'), result);
    process.stdout.write(`TOPOLOGY=PASS scratch=${scratch} evidence=${evidenceDir}\n`);
    return 0;
  } catch (error) {
    result.error = { message: error.message, details: error.details ?? null, stack: error.stack };
    writeJson(path.join(evidenceDir, 'summary.json'), result);
    process.stderr.write(`TOPOLOGY=FAIL ${error.message} scratch=${scratch} evidence=${evidenceDir}\n`);
    return 1;
  } finally {
    stopServer();
    await sleep(200);
  }
};

main().then((code) => process.exit(code));
