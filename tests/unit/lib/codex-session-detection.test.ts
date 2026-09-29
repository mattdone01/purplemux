import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { codexHookEvents } from '@/lib/providers/codex/hook-events';
import {
  findCodexSessionById,
  findLatestCodexSessionForCwd,
  watchSessionsDir,
} from '@/lib/providers/codex/session-detection';
import type { ISessionInfo } from '@/types/timeline';

describe('codex watchSessionsDir', () => {
  it('forwards matching hook session-info events and unsubscribes on stop', () => {
    const info: ISessionInfo = {
      status: 'running',
      sessionId: '11111111-1111-4111-8111-111111111111',
      jsonlPath: '/tmp/rollout-11111111-1111-4111-8111-111111111111.jsonl',
      pid: null,
      startedAt: null,
      cwd: '/tmp/project',
    };
    const onChange = vi.fn();
    const watcher = watchSessionsDir(12345, onChange, {
      skipInitial: true,
      tmuxSession: 'target-session',
    });

    codexHookEvents.emit('session-info', 'other-session', info);
    expect(onChange).not.toHaveBeenCalled();

    codexHookEvents.emit('session-info', 'target-session', info);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(info);

    watcher.stop();
    codexHookEvents.emit('session-info', 'target-session', info);
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

describe('findLatestCodexSessionForCwd', () => {
  it('returns the most recently modified Codex session for a cwd', async () => {
    const sessionsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'purplemux-codex-sessions-'));
    const dayDir = path.join(sessionsRoot, '2026', '05', '02');
    await fs.mkdir(dayDir, { recursive: true });

    const projectCwd = '/tmp/project-a';
    const oldPath = path.join(dayDir, 'rollout-old.jsonl');
    const latestPath = path.join(dayDir, 'rollout-latest.jsonl');
    const otherPath = path.join(dayDir, 'rollout-other.jsonl');

    await fs.writeFile(oldPath, JSON.stringify({
      type: 'session_meta',
      timestamp: '2026-05-02T01:00:00.000Z',
      payload: {
        id: '11111111-1111-4111-8111-111111111111',
        timestamp: '2026-05-02T01:00:00.000Z',
        cwd: projectCwd,
      },
    }) + '\n');
    await fs.writeFile(latestPath, JSON.stringify({
      type: 'session_meta',
      timestamp: '2026-05-02T02:00:00.000Z',
      payload: {
        id: '22222222-2222-4222-8222-222222222222',
        timestamp: '2026-05-02T02:00:00.000Z',
        cwd: projectCwd,
      },
    }) + '\n');
    await fs.writeFile(otherPath, JSON.stringify({
      type: 'session_meta',
      timestamp: '2026-05-02T03:00:00.000Z',
      payload: {
        id: '33333333-3333-4333-8333-333333333333',
        timestamp: '2026-05-02T03:00:00.000Z',
        cwd: '/tmp/project-b',
      },
    }) + '\n');

    await fs.utimes(oldPath, new Date('2026-05-02T01:00:00.000Z'), new Date('2026-05-02T01:00:00.000Z'));
    await fs.utimes(latestPath, new Date('2026-05-02T03:00:00.000Z'), new Date('2026-05-02T03:00:00.000Z'));
    await fs.utimes(otherPath, new Date('2026-05-02T04:00:00.000Z'), new Date('2026-05-02T04:00:00.000Z'));

    const session = await findLatestCodexSessionForCwd(projectCwd, {
      sessionsRoot,
      daysBack: 1,
      now: new Date('2026-05-02T12:00:00.000Z'),
    });

    expect(session?.sessionId).toBe('22222222-2222-4222-8222-222222222222');
    expect(session?.jsonlPath).toBe(latestPath);
    expect(session?.startedAt).toBe(new Date('2026-05-02T02:00:00.000Z').getTime());
  });

  it("skips a native subagent's rollout: it shares the root's cwd and writes more recently (tab-QizeO4, 2026-09-29)", async () => {
    const sessionsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'purplemux-codex-subagent-'));
    const dayDir = path.join(sessionsRoot, '2026', '09', '29');
    await fs.mkdir(dayDir, { recursive: true });
    const projectCwd = '/tmp/ci-spot-runners';
    const rootPath = path.join(dayDir, 'rollout-2026-09-29T01-34-19-01a0eacc-66cd-7700-a4ae-72adbd13aa58.jsonl');
    const childPath = path.join(dayDir, 'rollout-2026-09-29T01-56-26-01a0eae0-a62b-79e1-b096-5c959155263e.jsonl');
    await fs.writeFile(rootPath, JSON.stringify({
      type: 'session_meta',
      payload: { id: '01a0eacc-66cd-7700-a4ae-72adbd13aa58', cwd: projectCwd, source: 'cli', thread_source: 'user' },
    }) + '\n');
    await fs.writeFile(childPath, JSON.stringify({
      type: 'session_meta',
      payload: {
        id: '01a0eae0-a62b-79e1-b096-5c959155263e',
        cwd: projectCwd,
        source: { subagent: { thread_spawn: { parent_thread_id: '01a0eacc-66cd-7700-a4ae-72adbd13aa58', depth: 1 } } },
        thread_source: 'subagent',
      },
    }) + '\n');
    await fs.utimes(rootPath, new Date('2026-09-29T02:04:23.000Z'), new Date('2026-09-29T02:04:23.000Z'));
    await fs.utimes(childPath, new Date('2026-09-29T02:09:40.000Z'), new Date('2026-09-29T02:09:40.000Z'));

    const session = await findLatestCodexSessionForCwd(projectCwd, {
      sessionsRoot,
      daysBack: 1,
      now: new Date('2026-09-29T12:00:00.000Z'),
    });

    expect(session?.sessionId).toBe('01a0eacc-66cd-7700-a4ae-72adbd13aa58');
    expect(session?.jsonlPath).toBe(rootPath);
  });

  it('resolves a Codex session by id without using cwd recency', async () => {
    const sessionsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'purplemux-codex-session-id-'));
    const dayDir = path.join(sessionsRoot, '2026', '05', '02');
    await fs.mkdir(dayDir, { recursive: true });

    const sessionId = '44444444-4444-4444-8444-444444444444';
    const jsonlPath = path.join(dayDir, `rollout-2026-05-02T03-00-00-${sessionId}.jsonl`);
    await fs.writeFile(jsonlPath, JSON.stringify({
      type: 'session_meta',
      timestamp: '2026-05-02T03:00:00.000Z',
      payload: {
        id: sessionId,
        timestamp: '2026-05-02T03:00:00.000Z',
        cwd: '/tmp/project-a',
      },
    }) + '\n');

    const session = await findCodexSessionById(sessionId, {
      sessionsRoot,
      daysBack: 1,
      now: new Date('2026-05-02T12:00:00.000Z'),
    });

    expect(session?.sessionId).toBe(sessionId);
    expect(session?.jsonlPath).toBe(jsonlPath);
  });
});
