import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearCodexModelObservationCache,
  compareCodexModelSettings,
  getCodexModelStatus,
  readCodexModelObservation,
} from '@/lib/providers/codex/model-observation';
import type { ITab } from '@/types/terminal';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const FOREIGN_SESSION_ID = '22222222-2222-4222-8222-222222222222';
const directories: string[] = [];

const line = (value: unknown): string => `${JSON.stringify(value)}\n`;
const meta = (sessionId = SESSION_ID): string => line({
  timestamp: '2026-09-10T10:00:00.000Z',
  type: 'session_meta',
  payload: { id: sessionId, cwd: '/work/project' },
});
const turn = (model: string, effort: string, timestamp: string): string => line({
  timestamp,
  type: 'turn_context',
  payload: { model, effort },
});
const settings = (model: string, effort: string, timestamp: string, threadId?: string): string => line({
  timestamp,
  type: 'event_msg',
  payload: {
    type: 'thread_settings_applied',
    ...(threadId ? { thread_id: threadId } : {}),
    thread_settings: { model, reasoning_effort: effort },
  },
});

const writeSession = async (content: string, sessionId = SESSION_ID): Promise<string> => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-model-observation-'));
  directories.push(dir);
  const jsonlPath = path.join(dir, `rollout-2026-09-10T10-00-00-${sessionId}.jsonl`);
  await fs.writeFile(jsonlPath, content);
  return jsonlPath;
};

const tabFor = (jsonlPath: string): ITab => ({
  id: 'tab-1',
  sessionName: 'pmux-tab-1',
  name: 'worker',
  order: 0,
  panelType: 'codex-cli',
  agentState: {
    providerId: 'codex',
    sessionId: SESSION_ID,
    jsonlPath,
    summary: null,
  },
  agentLaunchConfig: { model: 'gpt-6-astra', effort: 'high' },
});

describe('Codex model observation', () => {
  beforeEach(() => {
    clearCodexModelObservationCache();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it('uses append order and reports both last-turn and changed thread settings', async () => {
    const jsonlPath = await writeSession([
      meta(),
      turn('gpt-6-astra', 'high', '2026-09-10T10:00:01.000Z'),
      settings('gpt-5.6-luna', 'medium', '2026-09-10T10:00:02.000Z'),
    ].join(''));

    const changed = await getCodexModelStatus(tabFor(jsonlPath), { runtimeAlive: true });

    expect(changed).toMatchObject({
      expected: { model: 'gpt-6-astra', effort: 'high' },
      observed: {
        model: 'gpt-5.6-luna',
        effort: 'medium',
        source: 'thread_settings_applied',
        timestamp: '2026-09-10T10:00:02.000Z',
        sessionId: SESSION_ID,
      },
      latestTurn: { model: 'gpt-6-astra', effort: 'high' },
      latestSettings: { model: 'gpt-5.6-luna', effort: 'medium' },
      status: 'mismatch',
    });

    await fs.appendFile(jsonlPath, turn('gpt-6-astra', 'high', '2026-09-10T10:00:03.000Z'));
    const restored = await getCodexModelStatus(tabFor(jsonlPath), { runtimeAlive: true });

    expect(restored.observed).toMatchObject({
      model: 'gpt-6-astra',
      effort: 'high',
      source: 'turn_context',
      timestamp: '2026-09-10T10:00:03.000Z',
    });
    expect(restored.status).toBe('match');
  });

  it('keeps malformed and incomplete records unknown until a complete record is appended', async () => {
    const complete = turn('gpt-6-astra', 'high', '2026-09-10T10:00:01.000Z');
    const splitAt = complete.indexOf('high') + 2;
    const jsonlPath = await writeSession(`${meta()}{malformed}\n${complete.slice(0, splitAt)}`);

    expect((await readCodexModelObservation(jsonlPath, SESSION_ID)).observed).toBeNull();

    await fs.appendFile(jsonlPath, complete.slice(splitAt));
    expect((await readCodexModelObservation(jsonlPath, SESSION_ID)).observed).toMatchObject({
      model: 'gpt-6-astra',
      effort: 'high',
    });
  });

  it('returns explicit unknown status when the observed file is missing', async () => {
    const missingPath = path.join(
      os.tmpdir(),
      `missing-rollout-${SESSION_ID}-${String(Date.now())}.jsonl`,
    );

    const result = await getCodexModelStatus(tabFor(missingPath), { runtimeAlive: true });

    expect(result).toMatchObject({ observed: null, status: 'unknown' });
  });

  it('reports fresh, rebound, and dead runtime unknown states distinctly', async () => {
    const fresh = tabFor('/unused');
    delete fresh.agentState;
    expect(await getCodexModelStatus(fresh, { runtimeAlive: true })).toMatchObject({
      status: 'unknown',
      reason: 'lifecycle-unverified',
    });

    const rebound = tabFor('/unused');
    rebound.agentState!.jsonlPath = null;
    expect(await getCodexModelStatus(rebound, { runtimeAlive: true })).toMatchObject({
      status: 'unknown',
      reason: 'session-unavailable',
    });

    expect(await getCodexModelStatus(tabFor('/unused'), { runtimeAlive: false })).toMatchObject({
      status: 'unknown',
      reason: 'runtime-unavailable',
    });
  });

  it('suppresses historical observations while a replacement generation is pending', async () => {
    const jsonlPath = await writeSession(
      `${meta()}${turn('gpt-6-astra', 'high', '2026-09-10T10:00:01.000Z')}`,
    );
    const pending = tabFor(jsonlPath);
    pending.codexLaunchRuntime = {
      pending: {
        generation: 'codex-generation-b',
        workspaceId: 'ws-test',
        tabId: pending.id,
        sessionName: pending.sessionName,
        resumeSessionId: SESSION_ID,
        launchedConfig: { ...pending.agentLaunchConfig },
        observationBoundary: { sessionId: SESSION_ID, jsonlPath, byteOffset: 0 },
        priorLauncher: null,
        priorAgent: null,
        phase: 'prepared',
        preparedAt: '2026-09-10T10:01:00.000Z',
      },
    };

    expect(await getCodexModelStatus(pending, { runtimeAlive: true })).toMatchObject({
      observed: null,
      status: 'unknown',
      reason: 'launch-pending',
    });
  });

  it('does not treat observations before a generation boundary as current activity', async () => {
    const historical = `${meta()}${turn('gpt-5.6-luna', 'low', '2026-09-10T10:00:01.000Z')}`;
    const jsonlPath = await writeSession(historical);

    const beforeCurrentTurn = await readCodexModelObservation(jsonlPath, SESSION_ID, {
      minimumByteOffset: Buffer.byteLength(historical),
    });
    expect(beforeCurrentTurn).toMatchObject({
      observed: null,
      hasActivity: false,
      scanState: 'complete',
    });

    await fs.appendFile(jsonlPath, turn('gpt-6-astra', 'high', '2026-09-10T10:02:00.000Z'));
    expect(await readCodexModelObservation(jsonlPath, SESSION_ID, {
      minimumByteOffset: Buffer.byteLength(historical),
    })).toMatchObject({
      observed: { model: 'gpt-6-astra', effort: 'high' },
      hasActivity: true,
      scanState: 'complete',
    });
  });

  it('rejects a stale JSONL belonging to another session', async () => {
    const jsonlPath = await writeSession(
      `${meta(FOREIGN_SESSION_ID)}${turn('gpt-6-astra', 'high', '2026-09-10T10:00:01.000Z')}`,
    );

    const result = await readCodexModelObservation(jsonlPath, SESSION_ID);

    expect(result).toEqual({
      observed: null,
      latestTurn: null,
      latestSettings: null,
      scanState: 'invalid-session',
      hasActivity: false,
    });
  });

  it('ignores a settings event whose own thread identity is foreign', async () => {
    const jsonlPath = await writeSession([
      meta(),
      turn('gpt-6-astra', 'high', '2026-09-10T10:00:01.000Z'),
      settings('gpt-5.6-luna', 'low', '2026-09-10T10:00:02.000Z', FOREIGN_SESSION_ID),
    ].join(''));

    const result = await readCodexModelObservation(jsonlPath, SESSION_ID);

    expect(result.observed).toMatchObject({ model: 'gpt-6-astra', effort: 'high' });
    expect(result.latestSettings).toBeNull();
  });

  it('resets cached observations after truncation', async () => {
    const jsonlPath = await writeSession(
      `${meta()}${turn('gpt-6-astra', 'high', '2026-09-10T10:00:01.000Z')}`,
    );
    expect((await readCodexModelObservation(jsonlPath, SESSION_ID)).observed?.model).toBe('gpt-6-astra');

    await fs.truncate(jsonlPath, 0);
    await fs.writeFile(jsonlPath, `${meta()}${turn('gpt-5.6-luna', 'low', '2026-09-10T10:01:00.000Z')}`);

    expect((await readCodexModelObservation(jsonlPath, SESSION_ID)).observed).toMatchObject({
      model: 'gpt-5.6-luna',
      effort: 'low',
    });
  });

  it('resets cached observations when the file is replaced at the same path', async () => {
    const jsonlPath = await writeSession(
      `${meta()}${turn('gpt-6-astra', 'high', '2026-09-10T10:00:01.000Z')}`,
    );
    expect((await readCodexModelObservation(jsonlPath, SESSION_ID)).observed?.model).toBe('gpt-6-astra');

    const replacement = `${jsonlPath}.replacement`;
    await fs.writeFile(replacement, `${meta()}${turn('gpt-5.6-luna', 'medium', '2026-09-10T10:01:00.000Z')}`);
    await fs.rename(replacement, jsonlPath);

    expect((await readCodexModelObservation(jsonlPath, SESSION_ID)).observed).toMatchObject({
      model: 'gpt-5.6-luna',
      effort: 'medium',
    });
  });

  it('bounds each cold poll and continues backward past a large trailing tool record', async () => {
    const hugeToolRecord = line({
      timestamp: '2026-09-10T10:00:02.000Z',
      type: 'response_item',
      payload: { type: 'function_call_output', output: 'x'.repeat(12 * 1024 * 1024) },
    });
    const jsonlPath = await writeSession(
      `${meta()}${turn('gpt-6-astra', 'high', '2026-09-10T10:00:01.000Z')}${hugeToolRecord}`,
    );
    const realOpen = fs.open.bind(fs);
    const bytesByPoll = [0, 0, 0, 0, 0];
    let poll = 0;
    vi.spyOn(fs, 'open').mockImplementation((async (...args: Parameters<typeof fs.open>) => {
      const handle = await realOpen(...args);
      const realRead = handle.read.bind(handle);
      handle.read = (async (...readArgs: Parameters<typeof handle.read>) => {
        const result = await realRead(...readArgs);
        bytesByPoll[poll] += result.bytesRead;
        return result;
      }) as typeof handle.read;
      return handle;
    }) as typeof fs.open);

    const results = [];
    for (poll = 0; poll < bytesByPoll.length; poll += 1) {
      const result = await readCodexModelObservation(jsonlPath, SESSION_ID);
      results.push(result);
      if (result.scanState === 'complete') break;
    }

    expect(results[0]).toMatchObject({ observed: null, scanState: 'scanning' });
    expect(results.at(-1)).toMatchObject({
      observed: { model: 'gpt-6-astra', effort: 'high' },
      scanState: 'complete',
    });
    expect(bytesByPoll.filter((bytes) => bytes > 0).every((bytes) => bytes <= READ_BOUND_PER_POLL)).toBe(true);
  });

  it('compares only pinned fields and never treats missing evidence as a match', () => {
    const observed = {
      model: 'gpt-6-astra',
      effort: null,
      source: 'turn_context' as const,
      timestamp: null,
      sessionId: SESSION_ID,
    };

    expect(compareCodexModelSettings({ model: null, effort: null }, observed)).toBe('unpinned');
    expect(compareCodexModelSettings({ model: 'gpt-6-astra', effort: null }, observed)).toBe('match');
    expect(compareCodexModelSettings({ model: 'gpt-6-astra', effort: 'high' }, observed)).toBe('unknown');
    expect(compareCodexModelSettings({ model: 'gpt-5.6-luna', effort: null }, observed)).toBe('mismatch');
    expect(compareCodexModelSettings({ model: 'gpt-5.6-luna', effort: 'high' }, observed)).toBe('mismatch');
  });
});

const READ_BOUND_PER_POLL = 4 * 1024 * 1024 + 2 * 64 * 1024;
