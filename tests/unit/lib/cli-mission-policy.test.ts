import { execFile } from 'child_process';
import { createServer } from 'http';
import path from 'path';
import { promisify } from 'util';
import { afterEach, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const cli = path.resolve('bin/cli.js');
const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

const humanInboxPolicy = {
  version: 1,
  legacyReviewPending: 2,
  guidance: 'Review legacy candidates on the next ordinary turn.',
};

const runMission = async (
  args: string[],
  responseBody: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(responseBody));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind a port');
  const result = await run(process.execPath, [cli, 'mission', ...args, '-w', 'ws-one'], {
    env: { ...process.env, PMUX_PORT: String(address.port), PMUX_TOKEN: 'test-token' },
  });
  return JSON.parse(result.stdout) as Record<string, unknown>;
};

describe('Mission Control CLI policy forwarding', () => {
  it.each([false, true])('keeps human inbox guidance in answers output (all=%s)', async (all) => {
    const output = await runMission(
      ['answers', ...(all ? ['--all'] : [])],
      { answers: [], deliveries: [], items: [], runs: [], humanInboxPolicy },
    );

    expect(output.humanInboxPolicy).toEqual(humanInboxPolicy);
  });

  it.each([
    ['snapshot', ['snapshot'], { cursor: 1, humanInboxPolicy }],
    ['events', ['events', '--json', '{"events":[]}'], { events: [], cursor: 1, replayed: false, humanInboxPolicy }],
  ])('keeps human inbox guidance in %s output', async (_name, args, responseBody) => {
    const output = await runMission(args as string[], responseBody as Record<string, unknown>);

    expect(output.humanInboxPolicy).toEqual(humanInboxPolicy);
  });
});

describe('Mission Control CLI pull commands (story 12)', () => {
  const answer = { id: '3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b', runId: "run one's", itemId: 'item-a', createdAt: 1_700_000_000_500 };
  const item = { id: 'item-a', runId: "run one's", state: 'answered', revision: 4, title: 'Choose' };
  const delivery = { answerId: answer.id, runId: answer.runId, state: 'submitted' };

  it('prints the exact ack command for each pending answer, shell-quoting producer-chosen ids', async () => {
    const output = await runMission(['answers'], {
      answers: [answer], deliveries: [delivery], items: [item],
      runs: [{ id: answer.runId, binding: { generation: 7 } }], humanInboxPolicy,
    });

    const [row] = output.answers as Array<Record<string, unknown>>;
    expect(row.ackCommand).toBe(
      `purplemux mission ack -w ws-one --run 'run one'\\''s' --answer ${answer.id} --generation 7 --revision 4 --event-id mission-ack-${answer.id} --producer-at 1700000000500`,
    );
  });

  it('prints no ack command while the run has no binding', async () => {
    const output = await runMission(['answers'], {
      answers: [answer], deliveries: [delivery], items: [item], runs: [{ id: answer.runId, binding: null }], humanInboxPolicy,
    });
    expect((output.answers as Array<Record<string, unknown>>)[0].ackCommand).toBeNull();
  });

  it('prints the reconcile steps for this workspace\'s pending bootstrap entries only', async () => {
    const output = await runMission(['bootstrap'], {
      bootstrap: {
        id: 'bootstrap-one',
        entries: [
          { workspaceId: 'ws-one', runId: 'run-a', state: 'queued', binding: { tabId: 'tab-orch' } },
          { workspaceId: 'ws-one', runId: 'run-b', state: 'confirmed', binding: { tabId: 'tab-orch' } },
          { workspaceId: 'ws-two', runId: 'run-c', state: 'queued', binding: { tabId: 'tab-other' } },
        ],
      },
      runs: [{ id: 'run-a', revision: 0, objective: 'Ship it', phase: 'implementation' }],
      items: [{ id: 'q-1', runId: 'run-a', state: 'candidate', title: 'Rollout?' }],
    });

    expect(output.workspaceId).toBe('ws-one');
    const entries = output.entries as Array<{ runId: string; steps: string[] }>;
    expect(entries.map((entry) => entry.runId)).toEqual(['run-a']);
    expect(entries[0].steps).toContain('Observed objective: Ship it; phase: implementation; possible outstanding questions: q-1: Rollout?.');
    expect(entries[0].steps.join('\n')).toContain('emitting run.resumed for run run-a with tabId tab-orch, expectedRevision 0, bindingGeneration 0, transferPendingAnswers false');
  });

  it('prints an empty list when there is no bootstrap', async () => {
    const output = await runMission(['bootstrap'], { bootstrap: null, runs: [], items: [] });
    expect(output.entries).toEqual([]);
  });
});
