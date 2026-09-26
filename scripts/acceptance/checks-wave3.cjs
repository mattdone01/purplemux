'use strict';
// Wave-3 acceptance checks (story 23) against the ISOLATED purplemux instance: deploy announce
// (story 13), harness watches (story 14), the self-notified failure page (story 34) and the refusal
// codes of the boot-time singletons (story 35).
//
// Kept apart from checks.cjs so the wave-2 and wave-3 changes meet only at checks.cjs's `main`.
// `wave3(inst, helpers)` returns results in checks.cjs's shape: { status, id, what, measured?, expected? }.
//
// GitHub is never called: a fake `gh` in $scratch/bin (first on the candidate server's PATH) answers
// `gh api <path>` from fixture files. Answers `<key>.1`, `<key>.2`, … serve the 1st, 2nd, … read of a
// path; `<key>` serves every later read; a path with no answer is `HTTP 404`.
//
// GitHub watches are read at most every 60 s, so a watch that needs a second read (head-moved,
// checks-settled) is proven within one interval (~75 s, waited once for all of them); the failing and
// expiry notices need three or more intervals and stay proven by the unit suite's fake clock.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const SHA_A = 'aaaaaaaa11111111aaaaaaaa11111111aaaaaaaa';
const SHA_B = 'bbbbbbbb22222222bbbbbbbb22222222bbbbbbbb';
const SHA_C = 'cccccccc33333333cccccccc33333333cccccccc';

/** Install the fake `gh`; returns the directory its answers live in. */
const installFakeGh = (scratch) => {
  const dir = path.join(scratch, 'gh');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(scratch, 'bin', 'gh');
  fs.writeFileSync(file, [
    '#!/bin/sh',
    '# acceptance fake gh: answers `gh api <path> ...` from fixture files (checks-wave3.cjs)',
    `dir='${dir}'`,
    'p=""',
    'for a in "$@"; do case "$a" in api|-*) ;; *) p="$a"; break ;; esac; done',
    'key=$(printf "%s" "$p" | tr -c "A-Za-z0-9" "_")',
    'n=$(( $(cat "$dir/$key.count" 2>/dev/null || echo 0) + 1 ))',
    'echo "$n" > "$dir/$key.count"',
    'f="$dir/$key.$n"; [ -f "$f" ] || f="$dir/$key"',
    '[ -f "$f" ] || { echo "gh: Not Found (HTTP 404)" >&2; exit 1; }',
    'cat "$f"',
    '',
  ].join('\n'));
  fs.chmodSync(file, 0o755);
  return dir;
};

const ghKey = (apiPath) => apiPath.replace(/[^A-Za-z0-9]/g, '_');
const answer = (dir, apiPath, body, nth) =>
  fs.writeFileSync(path.join(dir, nth ? `${ghKey(apiPath)}.${nth}` : ghKey(apiPath)), typeof body === 'string' ? body : JSON.stringify(body));
const pull = (merged, state, sha) => ({ merged, state, head: { sha } });

/** The deploy line (story 13): the fixed template, no caller text. Exported for the unit suite. */
const judgeDeployLine = (line, id, reasonMarker) => {
  const fixed = new RegExp(`^\\[purplemux deploy ${id}\\] purplemux restarts at ~\\S+Z \\(in \\d+ min\\) — details: purplemux deploy status ${id}; `).test(line || '');
  return { ok: fixed && !(line || '').includes(reasonMarker), measured: JSON.stringify(line ?? null) };
};

/** A watch line (story 14) for `target` saying `text`, cleared. Exported for the unit suite. */
const judgeWatchLine = (line, target, text) => {
  const ok = typeof line === 'string' && line.startsWith('[purplemux watch w-') && line.includes(` ${target} ${text}`) && line.endsWith('— watch cleared');
  return { ok, measured: JSON.stringify(line ?? null) };
};

/**
 * The alerts the candidate dispatched for a tab (story 34), read from its own log files: the
 * notification dispatcher logs every alert as `alert dispatched` with its kind and tab id.
 */
const alertsFor = (home, tabId) => {
  const dir = path.join(home, '.purplemux', 'logs');
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.startsWith('purplemux'));
  } catch {
    return [];
  }
  const kinds = [];
  for (const f of files) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line.includes('alert dispatched')) continue;
      try {
        const rec = JSON.parse(line);
        if (rec.msg === 'alert dispatched' && rec.tabId === tabId) kinds.push(rec.kind);
      } catch {
        // not a JSON line
      }
    }
  }
  return kinds;
};

const wave3 = async (inst, { parseJson, within, sleep, brief, shellQuote }) => {
  const results = [];
  const pass = (id, what) => results.push({ status: 'pass', id, what });
  const fail = (id, what, measured, expected) => results.push({ status: 'fail', id, what, measured, expected });
  const check = (id, what, ok, measured, expected) => (ok ? pass(id, what) : fail(id, what, measured, expected));
  const nonce = Math.random().toString(16).slice(2, 8);
  const { a: wsA, b: wsB } = inst.state.workspaces;
  const tab = async (ws, name, type = 'terminal', extra = []) =>
    parseJson((await inst.cli(['tab', 'create', '-w', ws, '-n', name, '-t', type, ...extra])).out);
  const inbox = async (ws) => parseJson((await inst.cli(['inbox', 'list', '-w', ws, '--all'])).out)?.items ?? [];

  // ─── story 14: harness watches (started first: the GitHub ones need one 60 s interval) ─────────
  const gh = installFakeGh(inst.state.scratch);
  const repo = `acc-org/acc-${nonce}`;
  answer(gh, `repos/${repo}/pulls/1`, pull(true, 'closed', SHA_A));
  answer(gh, `repos/${repo}/pulls/2`, pull(false, 'open', SHA_A), 1);
  answer(gh, `repos/${repo}/pulls/2`, pull(false, 'open', SHA_B));
  answer(gh, `repos/${repo}/pulls/3`, pull(false, 'open', SHA_C));
  answer(gh, `repos/${repo}/commits/${SHA_C}/check-runs?per_page=100`, 'completed\tsuccess\ncompleted\tfailure\ncompleted\tskipped\n');
  answer(gh, `repos/${repo}/commits/${SHA_C}/status`, 'success\n');

  const owner = await tab(wsA, `acc-w-owner-${nonce}`);
  const holder = await tab(wsA, `acc-w-holder-${nonce}`);
  const gone = await tab(wsA, `acc-w-gone-${nonce}`);
  const inOwner = (args) => inst.inTab(wsA, owner.tabId, inst.tabCli(args));
  const madeAt = Date.now();
  const made = owner?.tabId ? {
    merged: await inOwner(['watch', 'pr', `${repo}#1`, '--until', 'merged', '--interval', '60']),
    head: await inOwner(['watch', 'pr', `${repo}#2`, '--until', 'head-moved', '--interval', '60']),
    checks: await inOwner(['watch', 'pr', `${repo}#3`, '--until', 'checks-settled', '--interval', '60']),
    missing: await inOwner(['watch', 'pr', `${repo}#404`, '--until', 'merged', '--interval', '60']),
  } : null;
  check(
    'watch-create',
    'a tab creates pr watches; a PR gh cannot find is refused (exit 2)',
    Boolean(made && made.merged.rc === 0 && made.head.rc === 0 && made.checks.rc === 0 && made.missing.rc === 2),
    made ? `merged ${brief(made.merged)}; head-moved ${brief(made.head)}; checks-settled ${brief(made.checks)}; missing ${brief(made.missing)}` : 'no owner tab',
    'exit 0, 0, 0 and 2',
  );
  const ownerLine = async (target, text) => (await inbox(wsA)).find((i) => i.kind === 'watch' && i.targetTabId === owner?.tabId && judgeWatchLine(i.line, target, text).ok);

  const mergedItem = await within(40000, () => ownerLine(`${repo}#1`, 'is MERGED (aaaaaaaa)'));
  check('watch-merged', 'a PR already merged is reported on the first pass, with its head sha', Boolean(mergedItem), mergedItem?.line ?? 'no MERGED line for the owner tab', `a watch line "${repo}#1 is MERGED (aaaaaaaa) — watch cleared"`);

  // A lease watch fires on the holder's release.
  const acquired = holder?.tabId ? await inst.inTab(wsA, holder.tabId, inst.tabCli(['lease', 'acquire', `merge:acc/w-${nonce}`, '--ttl', '30m'])) : { rc: -1, out: '', err: 'no holder tab' };
  const leaseWatch = acquired.rc === 0 ? await inOwner(['watch', 'lease', `merge:acc/w-${nonce}`, '--until', 'free']) : acquired;
  await sleep(1000);
  const earlyFree = await ownerLine(`merge:acc/w-${nonce}`, 'is free');
  const released = leaseWatch.rc === 0 ? await inst.inTab(wsA, holder.tabId, inst.tabCli(['lease', 'release', `merge:acc/w-${nonce}`])) : leaseWatch;
  const freeItem = released.rc === 0 ? await within(20000, () => ownerLine(`merge:acc/w-${nonce}`, 'is free')) : null;
  check(
    'watch-lease-free',
    'a lease watch stays quiet while another tab holds the lease and fires on its release',
    Boolean(!earlyFree && freeItem),
    `acquire ${brief(acquired)}; watch ${brief(leaseWatch)}; early notice ${Boolean(earlyFree)}; release ${brief(released)}; notice ${freeItem ? 'yes' : 'no'}`,
    'no notice while held; one "is free" line after the release',
  );

  // A watch dies with its tab.
  const goneWatch = gone?.tabId ? await inst.inTab(wsA, gone.tabId, inst.tabCli(['watch', 'lease', `merge:acc/gone-${nonce}`, '--until', 'free'])) : { rc: -1, out: '', err: 'no tab' };
  const listed = async () => (parseJson((await inst.cli(['watch', 'list', '-w', wsA, '--json'])).out)?.watches ?? []).filter((w) => w.tabId === gone?.tabId);
  const before = goneWatch.rc === 0 ? (await listed()).length : 0;
  const closed = gone?.tabId ? await inst.cli(['tab', 'close', '-w', wsA, gone.tabId]) : { rc: -1, out: '', err: 'no tab' };
  const after = closed.rc === 0 ? await within(20000, async () => ((await listed()).length === 0 ? 'none' : null)) : null;
  check('watch-tab-close', 'closing the owner tab removes its watches', Boolean(before === 1 && after), `watches before close ${before}; close ${brief(closed)}; after ${after ? 'none' : 'still listed'}`, 'one before, none after');

  // ─── story 34: a self-notified failure pages no human only when a live agent will hear its tab ──
  // Both the worker and its escalation target (here a `--reports-to` lead) must be live agents: stand-in
  // `claude` tabs that received session-start. The worker is busy, as when it waits on its own gate.
  const agent = async (name, extra = []) => {
    const created = await tab(wsB, name, 'claude-code', ['--no-launch', ...extra]);
    if (!created?.tabId) return null;
    await sleep(500);
    const started = await inst.startStandIn(created.sessionName, 'Gate started; waiting on it.');
    if (started.rc !== 0) return null;
    await sleep(1000);
    await inst.hook('session-start', created.sessionName);
    return created;
  };
  const lead = await agent(`acc-bg-lead-${nonce}`);
  const worker = async (name) => {
    const w = lead ? await agent(name, ['--reports-to', lead.tabId]) : null;
    if (w) await inst.hook('prompt-submit', w.sessionName);
    return w;
  };
  const failingJob = (exitFile, delayS) => spawn('sh', ['-c', `sleep ${delayS}; echo 3 > ${shellQuote(exitFile)}; exit 3`], {
    stdio: 'ignore', detached: true, env: { PATH: '/usr/bin:/bin', HOME: inst.state.home },
  });
  const bgFailedNudge = async (ws, tabId) => (await inst.nudgesFor(ws, tabId)).find((n) => n.kind === 'bg-failed');
  const selfCase = async (ws, w, before) => {
    if (!w) return { w: null };
    const exitFile = path.join(inst.state.scratch, `${w.tabId}.exit`);
    const job = failingJob(exitFile, 20);
    const added = await inst.cli(['tab', 'bg', 'add', '-w', ws, w.tabId, '--pid', String(job.pid), '--exit-file', exitFile, '--label', 'acc-gate', '--notify', 'self']);
    if (added.rc === 0 && before) await before(w);
    const state = await inst.cliState(ws, w.tabId);
    // The liveness check runs in the status poll (every 30 s on a small host): up to ~75 s.
    const nudge = added.rc === 0 ? await within(90000, () => bgFailedNudge(ws, w.tabId)) : null;
    await sleep(3000); // the log transport writes asynchronously
    return { w, added, state, nudge, alerts: alertsFor(inst.state.home, w.tabId) };
  };
  const described = (c) => (c.w
    ? `bg add ${brief(c.added)}; cliState ${c.state}; nudge ${c.nudge ? `delivered ${c.nudge.delivered}` : 'none'}; alerts ${c.alerts.join(',') || 'none'}`
    : `no tab (lead ${lead ? 'created' : 'not created'})`);
  const heard = await selfCase(wsB, await worker(`acc-bg-live-${nonce}`));
  check(
    'self-failure-heard-no-page',
    'a --notify self failure delivered to a live agent whose reportsTo is a live agent pages no human',
    Boolean(heard.nudge?.delivered === true && !heard.alerts.includes('bg-job-died')),
    `${described(heard)}; lead cliState ${lead ? await inst.cliState(wsB, lead.tabId) : 'n/a'}`,
    'a delivered bg-failed nudge and no bg-job-died alert',
  );
  const tmuxEnv = { PATH: '/usr/bin:/bin', TMUX_TMPDIR: inst.state.tmuxTmpdir };
  const killSession = (w) => new Promise((resolve) => {
    const child = spawn('tmux', ['-L', 'purple', 'kill-session', '-t', w.sessionName], { env: tmuxEnv, stdio: 'ignore' });
    child.on('close', resolve);
    child.on('error', resolve);
  });
  const lost = await selfCase(wsB, await worker(`acc-bg-dead-${nonce}`), killSession);
  check(
    'self-failure-undelivered-pages',
    'a --notify self failure that cannot reach its tab (its session is gone) still pages the human',
    Boolean(lost.nudge && lost.nudge.delivered === false && lost.alerts.includes('bg-job-died')),
    described(lost),
    'an undelivered bg-failed nudge and a bg-job-died alert',
  );
  // tmux accepts the keys for a shell too: a delivered notice there is typed into a shell, not heard.
  const shell = await selfCase(wsA, await tab(wsA, `acc-bg-shell-${nonce}`));
  check(
    'self-failure-shell-pages',
    'a --notify self failure delivered to a shell tab still pages the human',
    Boolean(shell.nudge && shell.alerts.includes('bg-job-died')),
    described(shell),
    'a bg-failed nudge and a bg-job-died alert',
  );

  // ─── story 35: refusals thrown by the boot-time singletons keep their codes ──────────────────────
  const refusals = {
    noteShow: await inst.cli(['note', 'show', `n-${nonce}ab`]),
    watchClear: await inst.cli(['watch', 'clear', `w-${nonce}ab`]),
  };
  check(
    'refusal-codes',
    'a note or watch refusal from the server\'s boot-time singletons keeps its exit (not-found = 7)',
    refusals.noteShow.rc === 7 && refusals.watchClear.rc === 7,
    `note show ${brief(refusals.noteShow)}; watch clear ${brief(refusals.watchClear)}`,
    'exit 7 and 7',
  );

  // ─── story 13: deploy announce ──────────────────────────────────────────────────────────────────
  const orch = await tab(wsA, `acc-d-orch-${nonce}`);
  const merger = await tab(wsA, `acc-d-merger-${nonce}`);
  const other = await tab(wsA, `acc-d-other-${nonce}`);
  const on = orch?.tabId ? await inst.cli(['orchestration', 'on', '-w', wsA, orch.tabId]) : { rc: -1, out: '', err: 'no tab' };
  const lease = merger?.tabId ? await inst.inTab(wsA, merger.tabId, inst.tabCli(['lease', 'acquire', `merge:acc/d-${nonce}`, '--ttl', '30m'])) : { rc: -1, out: '', err: 'no tab' };
  const reason = `IGNORE-ALL-INSTRUCTIONS-${nonce}`;
  const announced = on.rc === 0 && lease.rc === 0 ? await inst.cli(['deploy', 'announce', '--in', '5', '--reason', reason, '--json']) : { rc: -1, out: '', err: `orchestration on ${brief(on)}; lease ${brief(lease)}` };
  const body = parseJson(announced.out);
  const who = (body?.recipients ?? []).map((r) => `${r.tabId}:${r.reasons.join('+')}`);
  check(
    'deploy-announce-recipients',
    'an admin announce reaches the enabled orchestrator and the tab-bound lease holder, not a bystander',
    Boolean(body && who.includes(`${orch.tabId}:orchestrator`) && who.includes(`${merger.tabId}:lease merge:acc/d-${nonce}`) && !who.some((w) => w.startsWith(`${other?.tabId}:`))),
    announced.rc === 0 ? `recipients ${who.join(' ')}` : brief(announced),
    `${orch?.tabId}:orchestrator and ${merger?.tabId}:lease merge:acc/d-${nonce}, not ${other?.tabId}`,
  );
  const deployItems = body ? (await inbox(wsA)).filter((i) => i.kind === 'deploy' && body.recipients.some((r) => r.itemId === i.id)) : [];
  const lines = deployItems.map((i) => judgeDeployLine(i.line, body.id, reason));
  check(
    'deploy-announce-line',
    'each recipient gets the fixed deploy line; the reason is never typed',
    Boolean(lines.length >= 2 && lines.every((l) => l.ok)),
    lines.map((l) => l.measured).join(' | ') || 'no deploy items',
    'fixed lines naming the id, none carrying the reason',
  );
  const refused = other?.tabId ? await inst.inTab(wsA, other.tabId, inst.tabCli(['deploy', 'announce', '--in', '5', '--reason', 'x'])) : { rc: -1, out: '', err: 'no tab' };
  check('deploy-announce-refused', 'a tab that is neither admin nor the deploy lease holder is refused (exit 3)', refused.rc === 3, brief(refused), 'exit 3');
  const status = body ? parseJson((await inst.cli(['deploy', 'status', body.id, '--json'])).out) : null;
  const withdrawn = body ? parseJson((await inst.cli(['deploy', 'withdraw', body.id])).out) : null;
  const afterItems = body ? (await inbox(wsA)).filter((i) => body.recipients.some((r) => r.itemId === i.id)) : [];
  check(
    'deploy-status-withdraw',
    'deploy status names each recipient with its state and cliState; withdraw drops every notice still waiting',
    Boolean(status?.reason === reason && status.recipients.every((r) => 'cliState' in r && typeof r.state === 'string')
      && withdrawn && withdrawn.withdrawn >= 1 && afterItems.every((i) => i.state !== 'queued' && i.state !== 'held')),
    `status ${status ? `${status.recipients.map((r) => `${r.tabId}=${r.state}`).join(',')} reason ${status.reason === reason}` : 'none'}; withdrawn ${withdrawn?.withdrawn ?? 'n/a'}; after ${afterItems.map((i) => i.state).join(',')}`,
    'the reason and every recipient; at least one withdrawn; none left queued or held',
  );
  if (merger?.tabId) await inst.inTab(wsA, merger.tabId, inst.tabCli(['lease', 'release', `merge:acc/d-${nonce}`]));

  // ─── story 14, second half: the watches that need one 60 s interval ──────────────────────────────
  const remaining = Math.max(0, madeAt + 95000 - Date.now());
  const headItem = await within(remaining + 5000, () => ownerLine(`${repo}#2`, 'head moved aaaaaaaa -> bbbbbbbb'));
  check('watch-head-moved', 'a head-moved watch reports the old and the new head after one interval', Boolean(headItem), headItem?.line ?? 'no head-moved line', `"${repo}#2 head moved aaaaaaaa -> bbbbbbbb — watch cleared"`);
  const checksItem = await within(10000, () => ownerLine(`${repo}#3`, 'checks settled at cccccccc: 3 green, 1 red'));
  check('watch-checks-settled', 'a checks-settled watch counts the head\'s check runs and statuses (skipped is green)', Boolean(checksItem), checksItem?.line ?? 'no checks-settled line', `"${repo}#3 checks settled at cccccccc: 3 green, 1 red — watch cleared"`);

  return results;
};

module.exports = { wave3, judgeDeployLine, judgeWatchLine, alertsFor, installFakeGh };
