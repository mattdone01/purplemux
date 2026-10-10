'use strict';
// Wave-7 acceptance checks: the default Mission Control page through the candidate's production
// build. A signed-in human gets the page with the Needs you section ahead of the portfolio board,
// and the snapshot route that section reads answers.
//
// `wave7(inst, helpers)` returns results in checks.cjs's shape: { status, id, what, measured?, expected? }.

const NEEDS_YOU = 'id="needs-you-heading"';
const BOARD = '>Portfolio board</h1>';

/** Where the Needs you section and the board heading sit in the served HTML; -1 when absent. */
const pageOrder = (html) => {
  const text = String(html);
  const needsYou = text.indexOf(NEEDS_YOU);
  const board = text.indexOf(BOARD);
  return { needsYou, board, first: needsYou >= 0 && board >= 0 && needsYou < board };
};

const wave7 = async (inst) => {
  const results = [];
  try {
    await checks(inst, results);
  } catch (e) {
    results.push({ status: 'fail', id: 'wave7-error', what: 'the Mission Control page checks ran to the end', measured: e instanceof Error ? e.stack : String(e), expected: 'no exception' });
  }
  return results;
};

const checks = async (inst, results) => {
  const check = (id, what, ok, measured, expected) => results.push(ok
    ? { status: 'pass', id, what }
    : { status: 'fail', id, what, measured, expected });

  const page = await inst.human('GET', '/mission-control');
  const order = pageOrder(page.body);
  check('mission-control-needs-you-first', 'the default Mission Control page renders the Needs you section before the portfolio board',
    page.status === 200 && order.first,
    `status ${page.status}; ${NEEDS_YOU} at ${order.needsYou}, ${BOARD} at ${order.board}`,
    `200 with ${NEEDS_YOU} before ${BOARD}`);

  const snapshot = await inst.human('GET', '/api/mission-control');
  check('mission-control-needs-you-snapshot', 'the snapshot route the Needs you section reads serves items to a signed-in human',
    snapshot.status === 200 && Array.isArray(snapshot.json?.items) && Array.isArray(snapshot.json?.workspaces),
    `status ${snapshot.status}; body ${String(snapshot.body).slice(0, 200)}`,
    '200 with items[] and workspaces[]');
};

module.exports = { wave7, pageOrder };
