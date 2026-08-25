import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ISessionInfo } from '@/types/timeline';

const mockHome = vi.hoisted(() => ({ value: '' }));
const processUtils = vi.hoisted(() => ({
  getChildPids: vi.fn(),
  getProcessArgs: vi.fn(),
  getProcessCwd: vi.fn(),
  getProcessStartTimeMs: vi.fn(),
  isProcessRunning: vi.fn(),
}));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    default: { ...actual, homedir: () => mockHome.value },
    homedir: () => mockHome.value,
  };
});

vi.mock('@/lib/process-utils', () => processUtils);

vi.mock('@/lib/providers/grok/preflight', () => ({
  runGrokPreflight: vi.fn(async () => ({
    installed: true,
    version: null,
    binaryPath: null,
    loggedIn: true,
  })),
}));

const PANE_PID = 4001;
const GROK_PID = 4002;
const OTHER_PID = 4003;
const CWD = '/repo';

const UNSCOPED_ID = '01a00000-0000-7000-8000-00000000000a';
const WS_A_ID = '01a00000-0000-7000-8000-00000000000b';
const WS_B_ID = '01a00000-0000-7000-8000-00000000000c';
const NEIGHBOUR_ID = '01a00000-0000-7000-8000-00000000000d';

const seedSession = async (home: string, sessionId: string, mtimeMs: number): Promise<string> => {
  const dir = path.join(home, 'sessions', encodeURIComponent(CWD), sessionId);
  await fs.mkdir(dir, { recursive: true });
  const jsonlPath = path.join(dir, 'updates.jsonl');
  await fs.writeFile(jsonlPath, '');
  const when = new Date(mtimeMs);
  await fs.utimes(jsonlPath, when, when);
  return jsonlPath;
};

const seedActiveSessions = async (
  home: string,
  rows: Array<{ sessionId: string; pid: number }>,
): Promise<void> => {
  await fs.mkdir(home, { recursive: true });
  await fs.writeFile(
    path.join(home, 'active_sessions.json'),
    JSON.stringify(rows.map((row) => ({
      session_id: row.sessionId,
      pid: row.pid,
      cwd: CWD,
    }))),
  );
};

const workspaceHome = (wsId: string) =>
  path.join(mockHome.value, '.purplemux', 'workspaces', wsId, 'grok-home');

describe('grok session bind is by process identity, never newest-for-cwd', () => {
  let detectActiveSession: (
    panePid: number,
    childPids?: number[],
    options?: { allowCwdFallback?: boolean; tmuxSession?: string },
  ) => Promise<ISessionInfo>;

  beforeEach(async () => {
    vi.resetModules();
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-grok-home-'));

    processUtils.getChildPids.mockImplementation(async (pid: number) =>
      (pid === PANE_PID ? [GROK_PID] : []));
    processUtils.getProcessArgs.mockImplementation(async () => `grok --cwd ${CWD}`);
    processUtils.getProcessCwd.mockImplementation(async () => CWD);

    await seedSession(path.join(mockHome.value, '.grok'), UNSCOPED_ID, Date.now());
    await seedSession(workspaceHome('ws-a'), WS_A_ID, Date.now() - 60_000);
    await seedSession(workspaceHome('ws-b'), WS_B_ID, Date.now() - 120_000);
    await seedSession(workspaceHome('ws-b'), NEIGHBOUR_ID, Date.now());

    ({ detectActiveSession } = await import('@/lib/providers/grok/session-detection'));
  });

  it('does not bind a no-id process to the newest session for the cwd', async () => {
    const info = await detectActiveSession(PANE_PID, undefined, {
      allowCwdFallback: true,
      tmuxSession: 'pt-ws-b-pane-1',
    });

    expect(info).toMatchObject({ status: 'running', sessionId: null, jsonlPath: null, pid: GROK_PID });
  });

  it('binds a no-id process to its own row in active_sessions.json', async () => {
    await seedActiveSessions(workspaceHome('ws-b'), [
      { sessionId: WS_B_ID, pid: GROK_PID },
      { sessionId: NEIGHBOUR_ID, pid: OTHER_PID },
    ]);

    const info = await detectActiveSession(PANE_PID, undefined, {
      tmuxSession: 'pt-ws-b-pane-1',
    });

    expect(info.sessionId).toBe(WS_B_ID);
    expect(info.jsonlPath).toBe(path.join(
      workspaceHome('ws-b'), 'sessions', encodeURIComponent(CWD), WS_B_ID, 'updates.jsonl',
    ));
  });

  it('does not reach into another workspace home for the same pid', async () => {
    await seedActiveSessions(workspaceHome('ws-a'), [{ sessionId: WS_A_ID, pid: GROK_PID }]);
    await seedActiveSessions(workspaceHome('ws-b'), [{ sessionId: WS_B_ID, pid: GROK_PID }]);

    const info = await detectActiveSession(PANE_PID, undefined, {
      tmuxSession: 'pt-ws-a-pane-1',
    });

    expect(info.sessionId).toBe(WS_A_ID);
    expect(info.jsonlPath).toContain(path.join('workspaces', 'ws-a', 'grok-home'));
  });

  it('reports no session when the pane own home has no active_sessions row', async () => {
    await seedActiveSessions(workspaceHome('ws-a'), [{ sessionId: WS_A_ID, pid: GROK_PID }]);

    const info = await detectActiveSession(PANE_PID, undefined, {
      tmuxSession: 'pt-ws-empty-pane-1',
    });

    expect(info).toMatchObject({ status: 'running', sessionId: null, jsonlPath: null });
  });

  it('still scans every home for an ad-hoc pane', async () => {
    await seedActiveSessions(path.join(mockHome.value, '.grok'), [
      { sessionId: UNSCOPED_ID, pid: GROK_PID },
    ]);

    const info = await detectActiveSession(PANE_PID, undefined, {
      tmuxSession: 'pt-adhoc-1',
    });

    expect(info.sessionId).toBe(UNSCOPED_ID);
    expect(info.jsonlPath).toContain(path.join('.grok', 'sessions'));
  });

  it('keeps binding by session id when the process carries one', async () => {
    processUtils.getProcessArgs.mockImplementation(async () =>
      `grok --cwd ${CWD} --session-id ${UNSCOPED_ID}`);
    await seedActiveSessions(workspaceHome('ws-b'), [{ sessionId: WS_B_ID, pid: GROK_PID }]);

    const info = await detectActiveSession(PANE_PID, undefined, {
      tmuxSession: 'pt-ws-b-pane-1',
    });

    expect(info.sessionId).toBe(UNSCOPED_ID);
  });

  it('binds the session id from active_sessions even before the transcript exists', async () => {
    const pendingId = '01a00000-0000-7000-8000-0000000000ee';
    await seedActiveSessions(workspaceHome('ws-b'), [{ sessionId: pendingId, pid: GROK_PID }]);

    const info = await detectActiveSession(PANE_PID, undefined, {
      tmuxSession: 'pt-ws-b-pane-1',
    });

    expect(info.sessionId).toBe(pendingId);
  });
});
