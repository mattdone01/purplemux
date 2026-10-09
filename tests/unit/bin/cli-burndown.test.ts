import { execFile } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { drainRouteLocks, resetRouteGlobals, serveLeaseRoutes, writeFixture } from '../api/leases-harness';

// The installed CLI against the real burndown route, workspace token checks and store.

const mockHome = vi.hoisted(() => ({ value: '' }));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => mockHome.value }, homedir: () => mockHome.value };
});
vi.mock('@/lib/logger', () => {
  const logger = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => logger };
  return { createLogger: () => logger };
});
vi.mock('@/lib/tmux', () => ({
  hasSession: vi.fn(async () => true),
  listSessions: vi.fn(async () => []),
  workspaceSessionName: (wsId: string, paneId: string, tabId: string) => `pt-${wsId}-${paneId}-${tabId}`,
}));
vi.mock('@/lib/sync-server', () => ({ broadcastSync: vi.fn() }));

const ENTRY = path.resolve('bin/purplemux.js');
const run = promisify(execFile);

interface IResult { code: number; stdout: string; stderr: string }
let cliHome: string;

const cli = async (args: string[], env: Record<string, string>, input?: string): Promise<IResult> => {
  try {
    const child = run(process.execPath, [ENTRY, ...args], {
      env: { NODE_ENV: 'test', PATH: process.env.PATH ?? '', HOME: cliHome, NO_UPDATE_NOTIFIER: '1', ...env },
    });
    if (input !== undefined) { child.child.stdin?.end(input); } else { child.child.stdin?.end(); }
    const { stdout, stderr } = await child;
    return { code: 0, stdout, stderr };
  } catch (err) {
    const f = err as { code?: number; stdout?: string; stderr?: string };
    return { code: f.code ?? -1, stdout: f.stdout ?? '', stderr: f.stderr ?? '' };
  }
};

const minute = (index: number) => new Date(Date.parse('2026-01-01T00:00:00Z') + index * 60_000).toISOString().replace('.000', '');
const generatedAt = new Date(Date.now() - 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const row = (at: string) => ({ at, slug: 'epic-a', total: 5, burned: 2, remaining: 3, pct: 40, stories: 3, unpointed: 0 });
const snapshot = (historyRows = 1) => ({
  generated_at: generatedAt,
  epics: [{ slug: 'epic-a', name: 'Epic A', stories: 3, unpointed: 0, total: 5, burned: 2, remaining: 3, pct: 40,
    in_progress: 1, blocked: 0, done_events: [], undated_burned: 2 }],
  history: Array.from({ length: historyRows }, (_, index) => row(minute(index))),
});

describe('purplemux burndown — the installed CLI against the real route', () => {
  let server: { port: number; close: () => Promise<void> };
  let orchA: Record<string, string>;
  let file: string;

  beforeEach(async () => {
    vi.resetModules();
    resetRouteGlobals();
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-cli-burndown-srv-'));
    cliHome = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-cli-burndown-home-'));
    file = path.join(cliHome, 'burndown.json');
    await writeFixture(mockHome.value, [
      { id: 'ws-a', name: 'alpha', tabs: [{ id: 'tab-a1', name: 'scrum master' }], orchestratorTabId: 'tab-a1' },
      { id: 'ws-b', name: 'beta', tabs: [{ id: 'tab-b1', name: 'orchestrator b' }], orchestratorTabId: 'tab-b1' },
    ]);
    const { ensureTabToken } = await import('@/lib/tab-token');
    const { default: burndown } = await import('@/pages/api/cli/workspaces/[workspaceId]/burndown');
    const route = (workspaceId: string): typeof burndown => (req, res) => {
      req.query = { workspaceId };
      return burndown(req, res);
    };
    server = await serveLeaseRoutes({
      '/api/cli/workspaces/ws-a/burndown': route('ws-a'),
      '/api/cli/workspaces/ws-b/burndown': route('ws-b'),
    });
    orchA = { PMUX_PORT: String(server.port), PMUX_TAB_TOKEN: await ensureTabToken({ workspaceId: 'ws-a', tabId: 'tab-a1' }, 'pt-ws-a-pane-1-tab-a1') };
  });

  afterEach(async () => {
    await server.close();
    await drainRouteLocks();
    resetRouteGlobals();
    await fs.rm(mockHome.value, { recursive: true, force: true });
    await fs.rm(cliHome, { recursive: true, force: true });
  });

  it('publishes from @FILE and shows it back', async () => {
    await fs.writeFile(file, JSON.stringify(snapshot()));
    const published = await cli(['burndown', 'publish', '-w', 'ws-a', '--json', `@${file}`], orchA);
    expect(published.code, published.stderr).toBe(0);
    expect(JSON.parse(published.stdout)).toMatchObject({ ok: true, workspaceId: 'ws-a', epics: 1, historyRows: 1 });
    const shown = await cli(['burndown', 'show', '-w', 'ws-a'], orchA);
    expect(shown.code, shown.stderr).toBe(0);
    expect(JSON.parse(shown.stdout).burndown.snapshot).toEqual(snapshot());
  });

  it('publishes from stdin', async () => {
    const published = await cli(['burndown', 'publish', '-w', 'ws-a'], orchA, JSON.stringify(snapshot()));
    expect(published.code, published.stderr).toBe(0);
  });

  it('sends only the newest history rows', async () => {
    await fs.writeFile(file, JSON.stringify(snapshot(2_050)));
    const published = await cli(['burndown', 'publish', '-w', 'ws-a', '--json', `@${file}`], orchA);
    expect(published.code, published.stderr).toBe(0);
    expect(JSON.parse(published.stdout)).toMatchObject({ historyRows: 2_000, historyDropped: 0 });
    const shown = JSON.parse((await cli(['burndown', 'show', '-w', 'ws-a'], orchA)).stdout);
    expect(shown.burndown.snapshot.history[0].at).toBe(minute(50));
  });

  it('prints the refused field and exits non-zero', async () => {
    const bad = snapshot();
    bad.epics[0].remaining = 4;
    await fs.writeFile(file, JSON.stringify(bad));
    const refused = await cli(['burndown', 'publish', '-w', 'ws-a', '--json', `@${file}`], orchA);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain('epics[0]: saw burned 2 + remaining 4 = 6, expected total 5');
  });

  it('refuses a publish into another workspace', async () => {
    await fs.writeFile(file, JSON.stringify(snapshot()));
    const refused = await cli(['burndown', 'publish', '-w', 'ws-b', '--json', `@${file}`], orchA);
    expect(refused.code).toBe(3);
    expect(refused.stderr).toContain('forbidden');
  });

  it('names a missing file and bad JSON', async () => {
    const missing = await cli(['burndown', 'publish', '-w', 'ws-a', '--json', `@${file}.absent`], orchA);
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain('cannot read');
    await fs.writeFile(file, '{');
    const bad = await cli(['burndown', 'publish', '-w', 'ws-a', '--json', `@${file}`], orchA);
    expect(bad.stderr).toContain('burndown must be valid JSON');
  });
});
