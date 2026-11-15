import { execFile } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ILayoutData } from '@/types/terminal';

// ADR-0048: the sweep's real adapters over real files in a temp home. The jobs read fails closed (round 1 CONCERN):
// the store's own readers turn an unreadable or malformed liveness.json into no jobs, the sweep's read does not.

const run = promisify(execFile);
const mockHome = vi.hoisted(() => ({ value: '' }));
const statusManager = vi.hoisted(() => ({ dormantGuard: vi.fn() }));
const grants = vi.hoisted(() => ({ listAllGrants: vi.fn() }));

vi.mock('@/lib/logger', () => {
  const logger = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => logger };
  return { createLogger: () => logger };
});
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => mockHome.value }, homedir: () => mockHome.value };
});
vi.mock('@/lib/status-manager', () => ({ getStatusManager: () => statusManager }));
vi.mock('@/lib/grant-store', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/grant-store')>()), listAllGrants: grants.listAllGrants }));

const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;

const wsDir = (id: string) => path.join(mockHome.value, '.purplemux', 'workspaces', id);

const writeRegistry = async (workspaces: Array<{ id: string; orchestratorTabId?: string }>) => {
  await fs.mkdir(path.join(mockHome.value, '.purplemux'), { recursive: true });
  await fs.writeFile(path.join(mockHome.value, '.purplemux', 'workspaces.json'), JSON.stringify({
    workspaces: workspaces.map((ws) => ({
      id: ws.id, name: ws.id, directories: [],
      ...(ws.orchestratorTabId ? { orchestration: { enabled: true, orchestratorTabId: ws.orchestratorTabId } } : {}),
    })),
  }));
};

const writeLayout = async (id: string, raw: string) => {
  await fs.mkdir(wsDir(id), { recursive: true });
  await fs.writeFile(path.join(wsDir(id), 'layout.json'), raw);
};

const writeLiveness = async (id: string, raw: string) => {
  await fs.mkdir(wsDir(id), { recursive: true });
  await fs.writeFile(path.join(wsDir(id), 'liveness.json'), raw);
};

const layout: ILayoutData = {
  root: {
    type: 'pane', id: 'pane-1', activeTabId: 'tab-o',
    tabs: [
      { id: 'tab-o', sessionName: 's-o', name: 'orch', order: 0, panelType: 'claude-code' },
      { id: 'tab-w', sessionName: 's-w', name: 'worker', order: 1, panelType: 'claude-code' },
      { id: 'tab-sub', sessionName: 's-sub', name: 'sub', order: 2, panelType: 'codex-cli', reportsTo: 'tab-w' },
    ],
  },
  activePaneId: 'pane-1',
  updatedAt: '2026-11-16T00:00:00.000Z',
};

const job = (pid: number, tabId = 'tab-w') => ({ workspaceId: 'ws-a', tabId, pid, host: null, registeredAt: 1 });

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  delete (globalThis as { __ptLivenessManager?: unknown }).__ptLivenessManager;
  delete (globalThis as { __ptDormantTick?: unknown }).__ptDormantTick;
  mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-dormant-runtime-'));
});

afterEach(async () => {
  const { stopDormantSweep } = await import('@/lib/dormant-sweep-runtime');
  await stopDormantSweep();
  delete (globalThis as { __ptLivenessManager?: unknown }).__ptLivenessManager;
  await fs.chmod(path.join(wsDir('ws-a'), 'liveness.json'), 0o600).catch(() => {});
  await fs.chmod(path.join(wsDir('ws-c'), 'layout.json'), 0o600).catch(() => {});
  await fs.rm(mockHome.value, { recursive: true, force: true });
});

describe('listWorkspaces over the registry and the layouts on disk', () => {
  it('names the orchestrator and the reportsTo targets; a missing layout is no tabs; an unreadable one is uncertain', async () => {
    await writeRegistry([{ id: 'ws-a', orchestratorTabId: 'tab-o' }, { id: 'ws-b' }, { id: 'ws-c' }, { id: 'ws-d' }]);
    await writeLayout('ws-a', JSON.stringify(layout));
    await writeLayout('ws-c', '{ not json');
    await writeLayout('ws-d', JSON.stringify(layout));
    const { listWorkspaces } = await import('@/lib/dormant-sweep-runtime');
    const { workspaces, uncertainWorkspaceIds } = await listWorkspaces();
    expect([...uncertainWorkspaceIds]).toEqual(['ws-c']);
    expect(workspaces.map((ws) => ws.workspaceId)).toEqual(['ws-a', 'ws-d']);
    expect(workspaces[0].tabs.map((c) => [c.tab.id, c.paneId, c.isOrchestrator, c.reportsTarget])).toEqual([
      ['tab-o', 'pane-1', true, false],
      ['tab-w', 'pane-1', false, true],
      ['tab-sub', 'pane-1', false, false],
    ]);
    expect(workspaces[1].tabs.every((c) => !c.isOrchestrator)).toBe(true);
  });

  it.skipIf(IS_ROOT)('reads a layout it may not open as uncertain', async () => {
    await writeRegistry([{ id: 'ws-c' }]);
    await writeLayout('ws-c', JSON.stringify(layout));
    await fs.chmod(path.join(wsDir('ws-c'), 'layout.json'), 0o000);
    const { listWorkspaces } = await import('@/lib/dormant-sweep-runtime');
    expect([...(await listWorkspaces()).uncertainWorkspaceIds]).toEqual(['ws-c']);
  });

  it('throws when the registry cannot be read', async () => {
    const { listWorkspaces } = await import('@/lib/dormant-sweep-runtime');
    await expect(listWorkspaces()).rejects.toThrow(/Workspace registry unavailable/);
  });
});

describe('readAllGrants: a partial read is no read', () => {
  it('throws when one grant file is refused, and when both are', async () => {
    const { readAllGrants } = await import('@/lib/dormant-sweep-runtime');
    grants.listAllGrants.mockReturnValue({ ok: true, grants: [], refused: [{ capability: 'owner', file: 'owner-grants.json', error: 'malformed', code: 'grant-store-unreadable' }] });
    expect(() => readAllGrants()).toThrow('owner-grants.json: malformed');
    grants.listAllGrants.mockReturnValue({ ok: false, error: 'both unreadable' });
    expect(() => readAllGrants()).toThrow('both unreadable');
    grants.listAllGrants.mockReturnValue({ ok: true, grants: [{ id: 'g-1' }], refused: [] });
    expect(readAllGrants()).toEqual([{ id: 'g-1' }]);
  });
});

describe('readHeldJobs: the jobs hold fails closed (round 1 CONCERN)', () => {
  it('answers no jobs when the workspace has no liveness.json', async () => {
    const { readHeldJobs } = await import('@/lib/dormant-sweep-runtime');
    expect(await readHeldJobs('ws-a', 'tab-w')).toBe(0);
  });

  it('holds a live registered job, and not one whose process exited or another tab\'s', async () => {
    const child = await run(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
    const exitedPid = Number(child.stdout);
    await writeLiveness('ws-a', JSON.stringify({ probes: [], jobs: [job(process.pid), job(exitedPid), job(process.pid, 'tab-o')] }));
    const { readHeldJobs } = await import('@/lib/dormant-sweep-runtime');
    expect(await readHeldJobs('ws-a', 'tab-w')).toBe(1);
  });

  it.skipIf(IS_ROOT)('throws on a liveness.json it may not read (mode 000)', async () => {
    await writeLiveness('ws-a', JSON.stringify({ probes: [], jobs: [] }));
    await fs.chmod(path.join(wsDir('ws-a'), 'liveness.json'), 0o000);
    const { readHeldJobs } = await import('@/lib/dormant-sweep-runtime');
    await expect(readHeldJobs('ws-a', 'tab-w')).rejects.toThrow('liveness.json of ws-a is unreadable or malformed');
  });

  it.each([
    ['malformed JSON', '{ "jobs": ['],
    ['a job of the wrong shape', JSON.stringify({ probes: [], jobs: [{ tabId: 'tab-w', pid: 'x' }] })],
    ['no jobs array', JSON.stringify({ probes: [] })],
  ])('throws on %s', async (_label, raw) => {
    await writeLiveness('ws-a', raw);
    const { readHeldJobs } = await import('@/lib/dormant-sweep-runtime');
    await expect(readHeldJobs('ws-a', 'tab-w')).rejects.toThrow('unreadable or malformed');
  });

  it('holds a job on disk that the manager does not know (its hydrate saw no file)', async () => {
    const { readHeldJobs } = await import('@/lib/dormant-sweep-runtime');
    const { getLivenessManager } = await import('@/lib/liveness-manager');
    await getLivenessManager().statusForTab('tab-w');
    await writeLiveness('ws-a', JSON.stringify({ probes: [], jobs: [job(4_000_000)] }));
    expect(await readHeldJobs('ws-a', 'tab-w')).toBe(1);
  });

  it('turns the throw into the jobs-unreadable hold in a sweep pass', async () => {
    await writeLiveness('ws-a', '{ broken');
    const { readHeldJobs } = await import('@/lib/dormant-sweep-runtime');
    const { holdsOf } = await import('@/lib/dormant-sweep');
    const jobs = await readHeldJobs('ws-a', 'tab-w').then((value) => ({ ok: true as const, value }), (err: Error) => ({ ok: false as const, error: err.message }));
    expect(jobs.ok).toBe(false);
    const status = {
      cliState: 'idle', panelType: 'codex-cli', providerId: 'codex', eventSeq: 1, lastEventAt: 0, busySince: null, lastResumeOrStartedAt: null,
      retired: false, restarting: false, halted: false, seatPhase: null, seatAdvancing: false, turnOpen: false, waitingMarker: null,
      agentSessionId: null, jsonlPath: null, snapshot: { read: 'none' }, heldDigests: { ok: true, value: 0 }, lastDeliveredAt: { ok: true, value: null },
    } as const;
    const empty = { ok: true as const, value: [] };
    expect(holdsOf({
      candidate: { workspaceId: 'ws-a', paneId: 'pane-1', tab: { id: 'tab-w', sessionName: 's-w', name: 'worker', order: 1, panelType: 'codex-cli' }, isOrchestrator: false, reportsTarget: false },
      status,
      pass: { leases: empty, watches: empty, inbox: empty, notes: empty, grants: empty },
      workspace: { ledger: { ok: true, value: new Map() }, missionWork: { ok: true, value: new Map() } },
      jobs,
    }, Date.now())).toEqual(['jobs-unreadable']);
  });
});

describe('startDormantSweep installs the status manager\'s guard', () => {
  it('routes the close guard to StatusManager.dormantGuard, never the default null', async () => {
    const guard = { cliState: 'idle', eventSeq: 4, retired: false, restarting: false };
    statusManager.dormantGuard.mockReturnValue(guard);
    const { dormantSweepDeps, startDormantSweep, stopDormantSweep } = await import('@/lib/dormant-sweep-runtime');
    expect(dormantSweepDeps()).toBeNull();
    await startDormantSweep({ intervalMs: 3_600_000 });
    const deps = dormantSweepDeps();
    expect(deps?.guard('tab-w')).toEqual(guard);
    expect(statusManager.dormantGuard).toHaveBeenCalledWith('tab-w');
    expect(deps?.jobs).toBeDefined();
    await stopDormantSweep();
    expect(dormantSweepDeps()).toBeNull();
  });
});
