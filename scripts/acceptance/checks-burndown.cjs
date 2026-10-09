'use strict';
// Wave-6 acceptance checks: the epic burndown that the Scrum Master publishes each sweep, through
// the candidate's production build. The CLI publishes from a file, the store keeps the newest
// history rows, a malformed publish leaves the stored one in place, and the portfolio board's
// human route answers.
//
// `wave6(inst, helpers)` returns results in checks.cjs's shape: { status, id, what, measured?, expected? }.

const fs = require('fs');
const path = require('path');

const HISTORY_ROWS = 2100;
const HISTORY_KEPT = 2000;

const utc = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

const burndownFixture = (now) => {
  const generatedAt = utc(now - 60_000);
  const start = now - HISTORY_ROWS * 60_000;
  return {
    generated_at: generatedAt,
    epics: [{ slug: 'acc-epic', name: 'Acceptance epic', stories: 4, unpointed: 1, total: 13, burned: 5, remaining: 8,
      pct: 38.5, in_progress: 1, blocked: 1, done_events: [{ at: generatedAt, points: 5 }], undated_burned: 0 }],
    history: Array.from({ length: HISTORY_ROWS }, (_, index) => ({ at: utc(start + index * 60_000), slug: 'acc-epic',
      total: 13, burned: 5, remaining: 8, pct: 38.5, stories: 4, unpointed: 1 })),
  };
};

const wave6 = async (inst, helpers) => {
  const results = [];
  try {
    await checks(inst, helpers, results);
  } catch (e) {
    results.push({ status: 'fail', id: 'wave6-error', what: 'the burndown checks ran to the end', measured: e instanceof Error ? e.stack : String(e), expected: 'no exception' });
  }
  return results;
};

const checks = async (inst, { parseJson, brief }, results) => {
  const pass = (id, what) => results.push({ status: 'pass', id, what });
  const fail = (id, what, measured, expected) => results.push({ status: 'fail', id, what, measured, expected });
  const check = (id, what, ok, measured, expected) => (ok ? pass(id, what) : fail(id, what, measured, expected));
  const { a: wsA } = inst.state.workspaces;
  const dir = path.join(inst.state.scratch, 'io');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'burndown.json');
  const fixture = burndownFixture(Date.now());
  fs.writeFileSync(file, JSON.stringify(fixture));

  const published = await inst.cli(['burndown', 'publish', '-w', wsA, '--json', `@${file}`]);
  const receipt = parseJson(published.out);
  const shown = parseJson((await inst.cli(['burndown', 'show', '-w', wsA])).out)?.burndown;
  const history = shown?.snapshot?.history ?? [];
  check('burndown-publish', 'the CLI publishes burndown.json from a file and the store keeps the newest history rows',
    published.rc === 0 && receipt?.historyRows === HISTORY_KEPT && shown?.snapshot?.generated_at === fixture.generated_at
      && history.length === HISTORY_KEPT && history[0]?.at === fixture.history[HISTORY_ROWS - HISTORY_KEPT].at
      && history.at(-1)?.at === fixture.history.at(-1).at,
    `publish ${brief(published)}; shown generated_at ${shown?.snapshot?.generated_at}, rows ${history.length}, first ${history[0]?.at}, last ${history.at(-1)?.at}`,
    `publish 0 with historyRows ${HISTORY_KEPT}; shown generated_at ${fixture.generated_at}, rows ${HISTORY_KEPT}, first ${fixture.history[HISTORY_ROWS - HISTORY_KEPT].at}`);

  const bad = { ...fixture, epics: [{ ...fixture.epics[0], remaining: 9 }] };
  fs.writeFileSync(file, JSON.stringify(bad));
  const refused = await inst.cli(['burndown', 'publish', '-w', wsA, '--json', `@${file}`]);
  const kept = parseJson((await inst.cli(['burndown', 'show', '-w', wsA])).out)?.burndown;
  check('burndown-refusal', 'a malformed publish names the field and leaves the stored burndown in place',
    refused.rc !== 0 && refused.err.includes('epics[0]: saw burned 5 + remaining 9 = 14, expected total 13')
      && kept?.snapshot?.epics?.[0]?.remaining === 8,
    `publish ${brief(refused)}; stored remaining ${kept?.snapshot?.epics?.[0]?.remaining}`,
    'publish non-zero naming epics[0] arithmetic; stored remaining 8');

  const board = await inst.human('GET', '/api/mission-control/burndown');
  const workspaceId = board.json?.workspaceId;
  check('burndown-board-read', 'the portfolio board route serves the selected Scrum Master workspace burndown to a signed-in human',
    board.status === 200 && (workspaceId === null ? board.json?.burndown === null
      : typeof workspaceId === 'string' && (workspaceId !== wsA || board.json?.burndown?.snapshot?.generated_at === fixture.generated_at)),
    `status ${board.status}; body ${String(board.body).slice(0, 200)}`,
    `200 with { workspaceId: null, burndown: null } or the selected workspace's record (${wsA}: generated_at ${fixture.generated_at})`);
};

module.exports = { wave6, burndownFixture };
