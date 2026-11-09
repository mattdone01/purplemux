import { describe, expect, it, vi } from 'vitest';
import { RemoteProofScheduler, type IRemoteProofRequest } from '@/lib/remote-proof-scheduler';
import type { TStrictRuntimeObservation } from '@/lib/process-utils';

// vel-D61 review r1 F1: what the scheduler keeps, for how long, and what it never keeps.

const req = (tabId: string, key = 'k1', host = 'agent-exec-v2'): IRemoteProofRequest =>
  ({ tabId, host, sessionName: `pt-ws-1-pane-a-${tabId}`, want: 'claude', key });

const make = (answer: () => TStrictRuntimeObservation | Promise<TStrictRuntimeObservation>) => {
  let now = 1_000_000;
  const observe = vi.fn(async (_sessionName: string, _want: string) => answer());
  const onUnknown = vi.fn();
  const scheduler = new RemoteProofScheduler({ observe, now: () => now, onUnknown });
  return { scheduler, observe, onUnknown, advance: (ms: number) => { now += ms; } };
};

describe('RemoteProofScheduler', () => {
  it('an absent answer is read once: a relaunch with the same key never meets it', async () => {
    const { scheduler } = make(() => ({ state: 'absent', reason: 'no claude process in the pane' }));
    await scheduler.schedule([req('tab-a')]);
    expect(scheduler.read(req('tab-a'))).toBe(false);
    expect(scheduler.read(req('tab-a'))).toBeNull();
  });

  it('a present answer is kept for its key only', async () => {
    const { scheduler } = make(() => ({ state: 'present', identity: 'x' }));
    await scheduler.schedule([req('tab-a')]);
    expect(scheduler.read(req('tab-a'))).toBe(true);
    expect(scheduler.read(req('tab-a'))).toBe(true);
    expect(scheduler.read(req('tab-a', 'k2'))).toBeNull();
    expect(scheduler.read(req('tab-a'))).toBeNull();
  });

  it('an unknown answer is not kept, backs the host off and names the reason; an observe that throws is unknown', async () => {
    const { scheduler, observe, onUnknown, advance } = make(() => { throw new Error('ssh died'); });
    await scheduler.schedule([req('tab-a')]);
    expect(scheduler.read(req('tab-a'))).toBeNull();
    expect(onUnknown).toHaveBeenCalledWith(expect.objectContaining({ tabId: 'tab-a' }), 'ssh died');
    await scheduler.schedule([req('tab-b')]);
    await scheduler.schedule([req('tab-c', 'k1', 'agent-exec-harness')]);
    expect(observe.mock.calls.map((c) => c[0])).toEqual(['pt-ws-1-pane-a-tab-a', 'pt-ws-1-pane-a-tab-c']);
    advance(30_000);
    await scheduler.schedule([req('tab-b')]);
    expect(observe).toHaveBeenCalledTimes(3);
  });

  it('prove: one awaited proof through the cache and the backoff; an in-flight tab is not proven twice', async () => {
    let release: (o: TStrictRuntimeObservation) => void = () => {};
    const { scheduler, observe } = make(() => new Promise((resolve) => { release = resolve; }));
    const first = scheduler.prove(req('tab-a'));
    expect(await scheduler.prove(req('tab-a'))).toBeNull();
    release({ state: 'present', identity: 'x' });
    expect(await first).toBe(true);
    expect(await scheduler.prove(req('tab-a'))).toBe(true);
    expect(observe).toHaveBeenCalledTimes(1);
  });

  it('forget drops a tab\'s answer and its rotation place', async () => {
    const { scheduler } = make(() => ({ state: 'present', identity: 'x' }));
    await scheduler.schedule([req('tab-a')]);
    scheduler.forget('tab-a');
    expect(scheduler.read(req('tab-a'))).toBeNull();
  });
});
