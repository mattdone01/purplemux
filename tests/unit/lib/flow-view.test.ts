import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IFlowRecord } from '@/types/flow';

const logs = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }));

vi.mock('@/lib/logger', () => {
  const logger = { trace: () => {}, debug: () => {}, info: logs.info, warn: logs.warn, error: () => {}, fatal: () => {}, child: () => logger };
  return { createLogger: () => logger };
});

const { flowView, readFlowThresholds } = await import('@/lib/flow-view');

const MIN = 60_000;
const NOW = 1_800_000_000_000;
const DEFAULTS = { windowMinutes: 360, lockBusyPercent: 80, queueLength: 10, oldestMinutes: 240 };

const config = (values: Record<string, string>) => async (key: string) => values[key] ?? null;

describe('readFlowThresholds', () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>).__ptFlowThresholdsLogged;
    logs.info.mockClear();
    logs.warn.mockClear();
  });

  it('reads the four flow keys, and logs the answer once until it changes', async () => {
    const read = config({ 'flow.window-minutes': '120', 'flow.queue-length': '4' });
    expect(await readFlowThresholds(read)).toEqual({ ...DEFAULTS, windowMinutes: 120, queueLength: 4 });
    await readFlowThresholds(read);
    expect(logs.info).toHaveBeenCalledTimes(1);
    expect(logs.warn).not.toHaveBeenCalled();
    await readFlowThresholds(config({}));
    expect(logs.info).toHaveBeenCalledTimes(2);
  });

  it('reads an invalid value as its default and logs why', async () => {
    expect(await readFlowThresholds(config({ 'flow.lock-busy-percent': '0' }))).toEqual(DEFAULTS);
    expect(logs.warn).toHaveBeenCalledWith(expect.stringContaining('flow.lock-busy-percent is 0, outside 1..100; default 80'));
  });

  it('reads every key as its default when the config read fails, and logs the failure', async () => {
    const failing = async () => { throw new Error('fleet config is refused'); };
    expect(await readFlowThresholds(failing)).toEqual(DEFAULTS);
    expect(logs.warn).toHaveBeenCalledTimes(1);
    expect(logs.warn.mock.calls[0][0]).toContain('flow.window-minutes unreadable (fleet config is refused); default');
    expect(logs.warn.mock.calls[0][0]).toContain('flow.oldest-minutes unreadable');
  });
});

describe('flowView', () => {
  const record: IFlowRecord = {
    workspaceId: 'ws-a', receivedAt: NOW - MIN,
    snapshot: { schemaVersion: 1, generatedAt: NOW - MIN, source: 'board', queues: [], locks: [], meters: [], flags: [] },
    history: [
      { at: NOW - 30 * MIN, queues: {}, oldest: {}, locks: {}, meters: {} },
      { at: NOW - 5 * MIN, queues: {}, oldest: {}, locks: {}, meters: {} },
    ],
  };

  it('serves no derived answer without a record', () => {
    expect(flowView(null, 'window', DEFAULTS, NOW)).toEqual({ flow: null, stale: null });
  });

  it('cuts the served rows to the configured window and derives from the full record', () => {
    const view = flowView(record, 'window', { ...DEFAULTS, windowMinutes: 10 }, NOW);
    expect(view.flow?.history.map((entry) => entry.at)).toEqual([NOW - 5 * MIN]);
    expect(view.stale).toBe(false);
    expect(view.derived).toEqual({ flags: [], lockBusyShare: {}, lockKnownMinutes: {}, insufficientHistory: [], windowMinutes: 10,
      thresholds: { ...DEFAULTS, windowMinutes: 10 } });
  });
});
