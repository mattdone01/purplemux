import { execFile } from 'child_process';
import fs from 'fs/promises';
import http from 'http';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// ADR-0031: `mission events` carries class and defaultOptionId to the server unchanged, and the help names both.

const ENTRY = path.resolve('bin/purplemux.js');
const run = promisify(execFile);

describe('purplemux mission events: attention class (ADR-0031)', { timeout: 30_000 }, () => {
  let server: http.Server;
  let port = 0;
  let home = '';
  let bodies: unknown[] = [];

  beforeEach(async () => {
    bodies = [];
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-cli-class-'));
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (d) => { raw += d; });
      req.on('end', () => {
        bodies.push(raw ? JSON.parse(raw) : null);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ events: [], cursor: 1, replayed: false }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(home, { recursive: true, force: true });
  });

  const cli = async (args: string[]) => {
    try {
      const { stdout, stderr } = await run(process.execPath, [ENTRY, ...args], {
        env: { NODE_ENV: 'test', PATH: process.env.PATH ?? '', HOME: home, NO_UPDATE_NOTIFIER: '1', PMUX_PORT: String(port), PMUX_TOKEN: 'ws-token' },
      });
      return { code: 0, stdout, stderr };
    } catch (err) {
      const f = err as { code?: number; stdout?: string; stderr?: string };
      return { code: f.code ?? -1, stdout: f.stdout ?? '', stderr: f.stderr ?? '' };
    }
  };

  it('forwards class and defaultOptionId unchanged', async () => {
    const batch = { events: [{
      eventId: 'evt-open-1', schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-1', expectedRevision: 0, producerAt: 1,
      bindingGeneration: 1, type: 'attention.opened',
      payload: { itemId: 'q-1', kind: 'question', title: 'T', context: 'C', storyIds: [], options: [{ id: 'yes', label: 'Yes' }],
        recommendation: null, blockingScope: 'story', canContinue: true, class: 'bookkeeping', defaultOptionId: 'yes' },
    }] };
    const result = await cli(['mission', 'events', '-w', 'ws-a', '--json', JSON.stringify(batch)]);
    expect(result.code).toBe(0);
    expect(bodies).toEqual([batch]);
  });

  it('names both fields and the producer rule in the help', async () => {
    const result = await cli(['help']);
    const text = result.stdout + result.stderr;
    expect(text).toMatch(/"class":"bookkeeping"/);
    expect(text).toMatch(/"defaultOptionId":"gradual"/);
    expect(text).toContain('class (money|irreversible|scope|bookkeeping) and defaultOptionId');
    expect(text).toContain('a producer that cannot name the class omits it');
  });
});
