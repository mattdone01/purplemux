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
