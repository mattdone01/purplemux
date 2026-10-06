'use strict';
// ADR-0021 recovery and pending-input acceptance checks against the same isolated production
// instance as waves 1-4.  These checks use only cookie-authenticated app routes, a workspace-scoped
// CLI running inside its own fixture tab, and the real terminal WebSocket protocol.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { WebSocket } = require('ws');
const { request, humanSession, liveStandIn } = require('./checks-wave4.cjs');

const daemonStandIn = (scratch) => {
  const file = path.join(scratch, 'bin', 'recovery-live', 'claude');
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [
      '#!/bin/bash',
      'd="$HOME/.claude/sessions"; mkdir -p "$d"',
      'printf \'{"pid":%d,"sessionId":"%s","cwd":"%s","startedAt":%s}\\n\' "$$" "$2" "$PWD" "$(( $(date +%s%N) / 1000000 ))" > "$d/$$.json"',
      'exec -a claude sleep 3600',
      '',
    ].join('\n'));
    fs.chmodSync(file, 0o755);
  }
  return file;
};

const findTab = (node, tabId) => {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node.tabs)) return node.tabs.find((tab) => tab.id === tabId) ?? null;
  for (const child of node.children ?? []) {
    const found = findTab(child, tabId);
    if (found) return found;
  }
  return null;
};

const layoutFile = (inst, ws) => path.join(inst.state.home, '.purplemux', 'workspaces', ws, 'layout.json');
const layoutTab = (inst, ws, tabId) => findTab(JSON.parse(fs.readFileSync(layoutFile(inst, ws), 'utf8')).root, tabId);

const providerPid = (home, transcriptPath) => {
  const sessionId = path.basename(transcriptPath, '.jsonl');
  const dir = path.join(home, '.claude', 'sessions');
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    try {
      const item = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (item.sessionId === sessionId && Number.isSafeInteger(item.pid)) return item.pid;
    } catch {
      // A fixture process may be between create and rename/write completion.
    }
  }
  return null;
};

const alive = (pid) => {
  if (!pid) return false;
  try {
    return fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1][0] !== 'Z';
  } catch {
    return false;
  }
};

const terminalStates = new WeakMap();
const openTerminal = (inst, sessionName, cookie) => new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${inst.state.port}/api/terminal?session=${encodeURIComponent(sessionName)}&clientId=acc5-${crypto.randomUUID()}`, {
    headers: { Cookie: cookie, Origin: `http://localhost:${inst.state.port}` },
  });
  const state = { opened: false, ready: false, stdoutBytes: 0, close: null, errors: [], heartbeat: null };
  terminalStates.set(ws, state);
  let settled = false;
  let timer = null;
  const fail = (error) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    if (state.heartbeat) clearInterval(state.heartbeat);
    reject(error);
  };
  timer = setTimeout(() => {
    ws.terminate();
    fail(new Error(`terminal output timed out: ${JSON.stringify({ opened: state.opened, close: state.close, errors: state.errors })}`));
  }, 15000);
  ws.on('open', () => {
    state.opened = true;
    state.heartbeat = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(Buffer.from([3]));
    }, 5000);
  });
  ws.on('message', (data) => {
    const bytes = Buffer.from(data);
    if (bytes[0] !== 1) return;
    state.stdoutBytes += Math.max(0, bytes.length - 1);
    if (state.ready) return;
    state.ready = true;
    settled = true;
    if (timer) clearTimeout(timer);
    resolve(ws);
  });
  ws.on('close', (code, reason) => {
    state.close = { code, reason: Buffer.from(reason).toString('utf8') };
    if (state.heartbeat) clearInterval(state.heartbeat);
    if (!state.ready) fail(new Error(`terminal closed before output: ${JSON.stringify(state.close)}`));
  });
  ws.on('error', (error) => {
    state.errors.push(error instanceof Error ? error.message : String(error));
    if (!state.ready) fail(error);
  });
});

const terminalEvidence = (ws) => {
  const state = terminalStates.get(ws);
  return state ? { opened: state.opened, ready: state.ready, stdoutBytes: state.stdoutBytes, close: state.close, errors: [...state.errors] } : null;
};
const closeTerminal = (ws) => {
  const state = terminalStates.get(ws);
  if (state?.heartbeat) clearInterval(state.heartbeat);
  try { ws.close(); } catch {}
};

const sendFrame = (ws, text, type = 0) => ws.send(Buffer.concat([Buffer.from([type]), Buffer.from(text)]));

const inputError = (ws, timeoutMs = 10000) => new Promise((resolve) => {
  const timer = setTimeout(() => { ws.off('message', onMessage); resolve(null); }, timeoutMs);
  const onMessage = (data) => {
    const bytes = Buffer.from(data);
    if (bytes[0] !== 6) return;
    clearTimeout(timer);
    ws.off('message', onMessage);
    resolve(bytes.subarray(1).toString('utf8'));
  };
  ws.on('message', onMessage);
});

const humanCookie = async (inst) => {
  const password = `acc-pw-${crypto.createHash('sha256').update(inst.state.scratch).digest('hex').slice(0, 16)}`;
  const session = await humanSession(inst.state.port, password);
  if (!session.cookie) throw new Error(session.why);
  return session.cookie;
};

const hookAt = async (inst, session, event, occurredAt) => {
  const token = fs.readFileSync(path.join(inst.state.home, '.purplemux', 'cli-token'), 'utf8').trim();
  return request(inst.state.port, 'POST', `/api/status/hook?occurredAt=${occurredAt}`, {
    headers: { 'x-pmux-token': token }, body: { event, session },
  });
};

const orchestration = async (inst, ws) => {
  const result = await inst.cli(['orchestration', 'status', '-w', ws]);
  try { return JSON.parse(result.out).orchestration; } catch { return null; }
};

const installTmuxHold = (inst, sessionName) => {
  const wrapper = path.join(inst.state.scratch, 'bin', 'tmux');
  const enabled = path.join(inst.state.scratch, 'io', 'tmux-hold-enabled');
  const entered = path.join(inst.state.scratch, 'io', 'tmux-hold-entered');
  const release = path.join(inst.state.scratch, 'io', 'tmux-hold-release');
  fs.mkdirSync(path.dirname(enabled), { recursive: true });
  fs.writeFileSync(wrapper, [
    '#!/bin/bash',
    `if [ -f ${JSON.stringify(enabled)} ] && [[ " $* " == *" list-panes "* ]] && [[ " $* " == *${JSON.stringify(sessionName)}* ]]; then`,
    `  : > ${JSON.stringify(entered)}`,
    `  while [ ! -f ${JSON.stringify(release)} ]; do sleep 0.05; done`,
    'fi',
    'exec /usr/bin/tmux "$@"',
    '',
  ].join('\n'));
  fs.chmodSync(wrapper, 0o755);
  fs.writeFileSync(enabled, '1\n');
  return { wrapper, enabled, entered, release };
};

const wave5 = async (inst, helpers) => {
  const results = [];
  const pass = (id, what) => results.push({ status: 'pass', id, what });
  const fail = (id, what, measured, expected) => results.push({ status: 'fail', id, what, measured, expected });
  const check = (id, what, ok, measured, expected) => ok ? pass(id, what) : fail(id, what, measured, expected);
  const { parseJson, within, sleep, brief, readIf } = helpers;
  const ws = inst.state.workspaces.a;
  const created = [];
  const sockets = [];
  let hold = null;
  try {
    const cookie = await humanCookie(inst);
    const humanHeaders = { cookie, origin: `http://localhost:${inst.state.port}` };
    const create = async (name) => {
      const result = await inst.cli(['tab', 'create', '-w', ws, '-n', name, '-t', 'claude-code', '--no-launch']);
      const made = parseJson(result.out);
      if (result.rc !== 0 || !made?.tabId || !made?.sessionName) throw new Error(`fixture tab ${name} was not created: ${brief(result)}`);
      created.push(made);
      return made;
    };
    const startDaemon = async (tab) => {
      const started = await inst.startStandIn(tab.sessionName, 'Ready.', { workspaceDir: 'a', standInPath: daemonStandIn(inst.state.scratch), background: true });
      await sleep(500);
      await inst.hook('session-start', tab.sessionName);
      const pid = await within(10000, async () => providerPid(inst.state.home, started.transcriptPath));
      return { ...started, pid };
    };

    // The running production server installs the release's scripts into the isolated HOME.
    const settings = JSON.parse(fs.readFileSync(path.join(inst.state.home, '.purplemux', 'hooks.json'), 'utf8'));
    const statusHook = fs.readFileSync(path.join(inst.state.home, '.purplemux', 'status-hook.sh'), 'utf8');
    const codexHook = fs.readFileSync(path.join(inst.state.home, '.purplemux', 'codex-hook.sh'), 'utf8');
    check('recovery-installed-hooks', 'the built server installed prompt/stop hooks carrying occurrence time and Codex generation attribution',
      Boolean(settings.hooks?.UserPromptSubmit && settings.hooks?.Stop) && statusHook.includes('occurredAt=$AT') && codexHook.includes('generation=${GENERATION}'),
      `prompt ${Boolean(settings.hooks?.UserPromptSubmit)}, stop ${Boolean(settings.hooks?.Stop)}, occurrence ${statusHook.includes('occurredAt=$AT')}, generation ${codexHook.includes('generation=${GENERATION}')}`,
      'UserPromptSubmit and Stop installed; scripts carry occurredAt and generation');

    const incumbent = await create('acc5-incumbent');
    const candidate = await create('acc5-candidate');
    const oldRuntime = await startDaemon(incumbent);
    const nextRuntime = await startDaemon(candidate);
    const designated = await inst.designate(ws, incumbent.tabId);

    const liveRefusal = await inst.inTab(ws, candidate.tabId,
      inst.tabCli(['orchestration', 'recover', '-w', ws, candidate.tabId]), { session: candidate.sessionName });
    check('recovery-live-refusal', 'an own-workspace recovery cannot replace a positively live incumbent',
      designated.rc === 0 && liveRefusal.rc === 3 && (await orchestration(inst, ws))?.orchestratorTabId === incumbent.tabId,
      `designate ${brief(designated)}; recover ${brief(liveRefusal)}; owner ${(await orchestration(inst, ws))?.orchestratorTabId}`,
      `recover exit 3 and owner ${incumbent.tabId}`);

    // Hold the server's strict candidate observation inside a real mapping writer. A terminal frame
    // for another tab must remain behind that writer and reach the pane only after it commits.
    const io = await create('acc5-io');
    const ioFile = path.join(inst.state.scratch, 'io', 'wave5-input.bin');
    fs.mkdirSync(path.dirname(ioFile), { recursive: true });
    fs.writeFileSync(ioFile, '');
    await inst.startStandIn(io.sessionName, 'Ready.', {
      workspaceDir: 'a', standInPath: liveStandIn(inst.state.scratch), inputFile: ioFile,
    });
    await sleep(700);
    await inst.hook('session-start', io.sessionName);
    const ioSocket = await openTerminal(inst, io.sessionName, cookie);
    sockets.push(ioSocket);
    const ioTerminal = terminalEvidence(ioSocket);
    check('recovery-terminal-ready', 'the authenticated terminal waits for initial output from the isolated tmux attachment',
      ioTerminal?.opened === true && ioTerminal?.ready === true && ioTerminal.stdoutBytes > 0 && ioTerminal.errors.length === 0,
      JSON.stringify(ioTerminal), 'opened, initial stdout received, no WebSocket error');
    hold = installTmuxHold(inst, candidate.sessionName);
    const replacing = inst.designate(ws, candidate.tabId);
    const writerEntered = await within(10000, async () => fs.existsSync(hold.entered));
    sendFrame(ioSocket, 'CONTENDED\n');
    await sleep(500);
    const beforeRelease = readIf(ioFile) ?? '';
    fs.writeFileSync(hold.release, 'go\n');
    const replacement = await replacing;
    const forwarded = await within(10000, async () => (readIf(ioFile) ?? '').includes('CONTENDED'));
    check('recovery-mapping-contention', 'raw terminal input waits behind a mapping writer and forwards only after the guarded replacement commits',
      writerEntered && beforeRelease === '' && replacement.rc === 0 && forwarded,
      `writer entered ${writerEntered}; before release ${JSON.stringify(beforeRelease)}; replace ${brief(replacement)}; forwarded ${forwarded}`,
      'writer entered, no early bytes, replacement 0, then bytes forwarded');
    check('recovery-human-keeps-incumbent', 'explicit human replacement changes only the mapping and leaves the former coordinator process alive',
      replacement.rc === 0 && alive(oldRuntime.pid) && (await orchestration(inst, ws))?.orchestratorTabId === candidate.tabId,
      `old pid ${oldRuntime.pid} alive ${alive(oldRuntime.pid)}; owner ${(await orchestration(inst, ws))?.orchestratorTabId}`,
      `old pid remains alive and owner is ${candidate.tabId}`);

    const beforeStale = await orchestration(inst, ws);
    const stale = await request(inst.state.port, 'PATCH', `/api/workspace/${ws}`, { headers: humanHeaders, body: {
      orchestration: { enabled: true, orchestratorTabId: incumbent.tabId }, expectedRevision: beforeStale.revision - 1, mode: 'replace',
    } });
    const afterStale = await orchestration(inst, ws);
    check('recovery-stale-cas', 'a stale recovery/replacement CAS is refused without changing the owner or revision',
      stale.status === 409 && afterStale?.orchestratorTabId === beforeStale?.orchestratorTabId && afterStale?.revision === beforeStale?.revision,
      `HTTP ${stale.status}; before ${JSON.stringify(beforeStale)}; after ${JSON.stringify(afterStale)}`,
      'HTTP 409 and identical owner/revision');

    // Restore the incumbent. Raw Escape is durable activity, not completion or process liveness.
    await inst.designate(ws, incumbent.tabId);
    const incumbentSocket = await openTerminal(inst, incumbent.sessionName, cookie);
    sockets.push(incumbentSocket);
    sendFrame(incumbentSocket, '\x1b');
    const rawPending = await within(10000, async () => layoutTab(inst, ws, incumbent.tabId)?.orchestrationActivity?.turn?.rawInput === true);

    const turnAt = layoutTab(inst, ws, incumbent.tabId)?.orchestrationActivity?.turn?.at ?? Date.now();
    await inst.hook('prompt-submit', incumbent.sessionName);
    await inst.hook('stop', incumbent.sessionName);
    await sleep(300);
    const retainedAfterUnattributable = Boolean(layoutTab(inst, ws, incumbent.tabId)?.orchestrationActivity?.turn);
    check('recovery-unattributable-hooks-retain', 'hooks without occurrence time cannot retire conservative raw input',
      rawPending && retainedAfterUnattributable,
      `raw pending ${rawPending}; retained after unattributable hooks ${retainedAfterUnattributable}`,
      'raw Escape persisted and unattributable prompt/stop retained it');
    await hookAt(inst, incumbent.sessionName, 'prompt-submit', Math.max(1, turnAt - 2));
    await hookAt(inst, incumbent.sessionName, 'stop', Math.max(1, turnAt - 1));
    await sleep(300);
    const retainedAfterOld = Boolean(layoutTab(inst, ws, incumbent.tabId)?.orchestrationActivity?.turn);
    const promptAt = Date.now();
    await hookAt(inst, incumbent.sessionName, 'prompt-submit', promptAt);
    const runningAt = await within(10000, async () => layoutTab(inst, ws, incumbent.tabId)?.orchestrationActivity?.turn?.runningAt ?? null);
    while (Date.now() <= (runningAt ?? promptAt)) await sleep(2);
    await hookAt(inst, incumbent.sessionName, 'stop', Date.now());
    const clearedByCurrent = await within(10000, async () => !layoutTab(inst, ws, incumbent.tabId)?.orchestrationActivity?.turn);
    check('recovery-hook-ordering', 'old occurrence-time hooks cannot clear pending input; a current attributed submit then stop can',
      retainedAfterOld && Boolean(runningAt) && clearedByCurrent,
      `retained after old ${retainedAfterOld}; runningAt ${runningAt}; cleared after current ${clearedByCurrent}`,
      'old prompt/stop retained; current prompt persisted runningAt; later current stop cleared');

    process.kill(oldRuntime.pid, 'SIGTERM');
    const oldGone = await within(10000, async () => !alive(oldRuntime.pid));
    const recovered = await inst.inTab(ws, candidate.tabId,
      inst.tabCli(['orchestration', 'recover', '-w', ws, candidate.tabId]), { session: candidate.sessionName });
    check('recovery-own-workspace-success', 'an own-workspace caller recovers only after strict positive absence to a live local candidate',
      oldGone && recovered.rc === 0 && (await orchestration(inst, ws))?.orchestratorTabId === candidate.tabId && alive(nextRuntime.pid),
      `old gone ${oldGone}; recover ${brief(recovered)}; owner ${(await orchestration(inst, ws))?.orchestratorTabId}; candidate alive ${alive(nextRuntime.pid)}`,
      `old absent, recover 0, owner ${candidate.tabId}, candidate alive`);

    const awaiting = await inst.cli(['standup', 'report', '-w', ws, '--json', JSON.stringify({
      state: 'awaiting-human', headline: 'acceptance needs a decision', items: [{ label: 'decision', status: 'blocked' }],
      blockers: [{ what: 'choice', needs: 'human answer' }], needsHuman: true, next: ['wait'],
    })]);
    const off = await inst.inTab(ws, candidate.tabId, inst.tabCli(['orchestration', 'off', '-w', ws]), { session: candidate.sessionName });
    check('recovery-unfinished-retains-owner', 'awaiting-human work refuses orchestration off and retains its coordinator',
      awaiting.rc === 0 && off.rc === 3 && (await orchestration(inst, ws))?.orchestratorTabId === candidate.tabId,
      `standup ${brief(awaiting)}; off ${brief(off)}; owner ${(await orchestration(inst, ws))?.orchestratorTabId}`,
      `standup 0, off 3, owner ${candidate.tabId}`);

    // Cookie-authenticated attachment and prompt delivery both use the app route. Their bytes arrive
    // only after the persisted marker written during the earlier contended raw input.
    const attachment = `ATTACH-${crypto.randomBytes(3).toString('hex')}`;
    const prompt = `PROMPT-${crypto.randomBytes(3).toString('hex')}`;
    const attachResult = await request(inst.state.port, 'POST', `/api/tabs/${io.tabId}/send?workspaceId=${ws}`, {
      headers: humanHeaders, body: { content: attachment, submit: false, literalPaste: true, expectedSessionName: io.sessionName },
    });
    const promptResult = await request(inst.state.port, 'POST', `/api/tabs/${io.tabId}/send?workspaceId=${ws}`, {
      headers: humanHeaders, body: { content: prompt, submit: true, expectedSessionName: io.sessionName },
    });
    const appBytes = await within(10000, async () => {
      const body = readIf(ioFile) ?? '';
      return body.includes(attachment) && body.includes(prompt) ? body : null;
    });
    check('recovery-authenticated-app-input', 'authenticated attachment and prompt routes persist pending work and deliver both payloads in order',
      attachResult.status === 200 && promptResult.status === 200 && Boolean(appBytes)
        && appBytes.indexOf(attachment) < appBytes.indexOf(prompt) && Boolean(layoutTab(inst, ws, io.tabId)?.orchestrationActivity?.turn),
      `attachment ${attachResult.status}; prompt ${promptResult.status}; bytes ${JSON.stringify(String(appBytes).slice(-160))}; pending ${Boolean(layoutTab(inst, ws, io.tabId)?.orchestrationActivity?.turn)}`,
      'both HTTP 200, attachment before prompt, pending persisted');

    sendFrame(ioSocket, 'R');
    const firstRaw = await within(10000, async () => {
      const turn = layoutTab(inst, ws, io.tabId)?.orchestrationActivity?.turn;
      return turn?.rawInput ? turn : null;
    });
    sendFrame(ioSocket, '\x1b[A', 5);
    sendFrame(ioSocket, '\x1b');
    sendFrame(ioSocket, '\n');
    const rawBytes = await within(10000, async () => (readIf(ioFile) ?? '').includes('R\x1b[A\x1b\n'));
    const afterRaw = layoutTab(inst, ws, io.tabId)?.orchestrationActivity?.turn;
    check('recovery-raw-order-coalescing', 'authenticated raw WebSocket input preserves arrow/Escape order and coalesces one pending raw epoch',
      Boolean(rawBytes) && firstRaw?.generation === afterRaw?.generation && afterRaw?.rawInput === true,
      `bytes ${rawBytes}; generations ${firstRaw?.generation}/${afterRaw?.generation}; raw ${afterRaw?.rawInput}`,
      'ordered R, arrow, Escape, newline; one unchanged raw generation');

    // A fresh tab has no coalescible marker. Make only its isolated layout directory unwritable:
    // the protocol must surface an error and the pane must receive no byte.
    const refusedTab = await create('acc5-refused-input');
    const refusedFile = path.join(inst.state.scratch, 'io', 'wave5-refused.bin');
    fs.writeFileSync(refusedFile, '');
    await inst.startStandIn(refusedTab.sessionName, 'Ready.', {
      workspaceDir: 'a', standInPath: liveStandIn(inst.state.scratch), inputFile: refusedFile,
    });
    await sleep(700);
    const refusedSocket = await openTerminal(inst, refusedTab.sessionName, cookie);
    sockets.push(refusedSocket);
    const dir = path.dirname(layoutFile(inst, ws));
    const mode = fs.statSync(dir).mode & 0o777;
    let errorText = null;
    try {
      fs.chmodSync(dir, 0o500);
      const visible = inputError(refusedSocket);
      sendFrame(refusedSocket, 'MUST-NOT-FORWARD\n');
      errorText = await visible;
    } finally {
      fs.chmodSync(dir, mode);
    }
    await sleep(300);
    check('recovery-raw-persistence-refusal', 'a raw-input persistence failure is visible to the client and forwards no terminal bytes',
      typeof errorText === 'string' && errorText.includes('not confirmed') && (readIf(refusedFile) ?? '') === '',
      `error ${JSON.stringify(errorText)}; pane bytes ${JSON.stringify(readIf(refusedFile) ?? '')}`,
      'MSG_INPUT_ERROR names unconfirmed input and pane remains empty');

    // Designate the live fixture, then remove only its isolated tmux session. The layout and pending
    // turn remain. Restart must create a new pane identity without changing the turn generation;
    // that pending launch is unknown to local recovery. A second isolated session stays live so an
    // exact missing-target result cannot be confused with an unavailable tmux server.
    const restartDesignated = await inst.designate(ws, io.tabId);
    const pendingBeforeRestart = layoutTab(inst, ws, io.tabId)?.orchestrationActivity?.turn;
    const paneBeforeRestart = await inst.isolatedPanePid(io.sessionName);
    closeTerminal(ioSocket);
    const removedSession = await inst.removeIsolatedSession(io.sessionName);
    const absentBeforeRestart = await within(10000, async () => !(await inst.isolatedSessionExists(io.sessionName)));
    const restarted = await request(inst.state.port, 'POST', `/api/layout/pane/${io.paneId}/tabs/${io.tabId}?workspace=${ws}`, {
      headers: humanHeaders, body: { command: 'sleep 300' },
    });
    const pendingAfterRestart = layoutTab(inst, ws, io.tabId)?.orchestrationActivity?.turn;
    const paneAfterRestart = await inst.isolatedPanePid(io.sessionName);
    const controlAlive = await inst.isolatedSessionExists(candidate.sessionName);
    const unknownRefusal = await inst.inTab(ws, candidate.tabId,
      inst.tabCli(['orchestration', 'recover', '-w', ws, candidate.tabId]), { session: candidate.sessionName });
    check('recovery-unknown-refusal', 'a retained turn beside a pending genuine restart cannot authorize local recovery',
      restartDesignated.rc === 0 && removedSession.rc === 0 && absentBeforeRestart && restarted.status === 200
        && paneBeforeRestart && paneAfterRestart && paneBeforeRestart !== paneAfterRestart && controlAlive
        && unknownRefusal.rc === 3 && unknownRefusal.err.includes('orchestrator-state-unknown')
        && (await orchestration(inst, ws))?.orchestratorTabId === io.tabId,
      `designate ${brief(restartDesignated)}; remove ${brief(removedSession)}; absent ${absentBeforeRestart}; restart ${restarted.status}; panes ${paneBeforeRestart}/${paneAfterRestart}; control ${controlAlive}; recover ${brief(unknownRefusal)}; owner ${(await orchestration(inst, ws))?.orchestratorTabId}`,
      `session removed, restart 200 with new pane, control live, recover exit 3 state unknown, owner ${io.tabId}`);
    const closed = await inst.cli(['tab', 'close', '-w', ws, io.tabId]);
    const closePayload = parseJson(closed.out);
    const targetProbe = await inst.strictSessionProbe(io.sessionName);
    const controlProbe = await inst.strictSessionProbe(candidate.sessionName);
    const audit = (readIf(path.join(inst.state.home, '.purplemux', 'audit', 'coordination.jsonl')) ?? '')
      .trim().split('\n').filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } })
      .filter((entry) => entry.event === 'tab-reap' && entry.tabId === io.tabId).at(-1) ?? null;
    check('recovery-restart-close-durability', 'restart retains unresolved input, while a later managed close confirms reap and removes the tab',
      restarted.status === 200 && pendingBeforeRestart?.generation === pendingAfterRestart?.generation
        && closed.rc === 0 && !layoutTab(inst, ws, io.tabId)
        && targetProbe.rc === 1 && targetProbe.err.trim() === `can't find session: ${io.sessionName}`
        && controlProbe.rc === 0 && Array.isArray(closePayload?.survivors) && closePayload.survivors.length === 0,
      `restart ${restarted.status}; generations ${pendingBeforeRestart?.generation}/${pendingAfterRestart?.generation}; close ${brief(closed)} payload ${JSON.stringify(closePayload)}; remains ${Boolean(layoutTab(inst, ws, io.tabId))}; target probe ${brief(targetProbe)}; control probe ${brief(controlProbe)}; audit ${JSON.stringify(audit)}; socket ${JSON.stringify(terminalEvidence(ioSocket))}`,
      'restart 200 with same turn generation; close 0; exact target absent while control is present; no reap survivors; tab absent');
  } catch (error) {
    fail('wave5-error', 'the recovery and raw-input acceptance checks ran to the end', error instanceof Error ? error.stack : String(error), 'no exception');
  } finally {
    if (hold) {
      try { fs.writeFileSync(hold.release, 'cleanup\n'); } catch {}
      for (const file of [hold.enabled, hold.entered, hold.release, hold.wrapper]) {
        try { fs.unlinkSync(file); } catch {}
      }
    }
    for (const socket of sockets) {
      closeTerminal(socket);
    }
    for (const tab of created) {
      if (tab?.tabId) await inst.cli(['tab', 'close', '-w', ws, tab.tabId]);
    }
  }
  return results;
};

module.exports = { wave5, daemonStandIn, findTab };
