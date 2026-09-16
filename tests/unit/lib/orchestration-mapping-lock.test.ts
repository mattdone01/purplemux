import { describe, expect, it, vi } from 'vitest';
import { withOrchestrationMappingRead, withOrchestrationMappingWrite } from '@/lib/orchestration-mapping-lock';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('orchestration mapping leases', () => {
  it('shares active readers and gives queued writers precedence over later readers in FIFO order', async () => {
    const releaseReaders = deferred();
    const readersEntered = deferred();
    const writerEntered = deferred();
    const releaseWriter = deferred();
    const events: string[] = [];
    const read = (label: string) => withOrchestrationMappingRead('ws-fair', async () => {
      events.push(label);
      if (events.length === 2) readersEntered.resolve();
      await releaseReaders.promise;
    });
    const first = read('reader-1');
    const second = read('reader-2');
    await readersEntered.promise;
    const writer = withOrchestrationMappingWrite('ws-fair', async () => {
      events.push('writer-1');
      writerEntered.resolve();
      await releaseWriter.promise;
    });
    const third = read('reader-3');
    const nextWriter = withOrchestrationMappingWrite('ws-fair', async () => { events.push('writer-2'); });
    const fourth = read('reader-4');
    await flush();
    const beforeRelease = [...events];
    releaseReaders.resolve();
    await writerEntered.promise;
    const whileWriting = [...events];
    releaseWriter.resolve();
    await Promise.all([first, second, writer, third, nextWriter, fourth]);
    expect(beforeRelease).toEqual(['reader-1', 'reader-2']);
    expect(whileWriting).toEqual(['reader-1', 'reader-2', 'writer-1']);
    expect(events).toEqual(['reader-1', 'reader-2', 'writer-1', 'reader-3', 'writer-2', 'reader-4']);
  });

  it.each(['read', 'write'] as const)('releases a failed %s lease to queued readers and writers', async (mode) => {
    const entered = deferred();
    const release = deferred();
    const events: string[] = [];
    const hold = mode === 'read' ? withOrchestrationMappingRead : withOrchestrationMappingWrite;
    const failed = hold('ws-fail', async () => {
      entered.resolve();
      await release.promise;
      throw new Error('callback failed');
    }).catch((error: Error) => error.message);
    await entered.promise;
    const writing = withOrchestrationMappingWrite('ws-fail', async () => { events.push('writer'); });
    const reading = withOrchestrationMappingRead('ws-fail', async () => { events.push('reader'); });
    release.resolve();
    expect(await failed).toBe('callback failed');
    await Promise.all([writing, reading]);
    expect(events).toEqual(['writer', 'reader']);
  });

  it('shares lease state after module re-evaluation', async () => {
    const entered = deferred();
    const release = deferred();
    const reader = withOrchestrationMappingRead('ws-reload', async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    vi.resetModules();
    const reloaded = await import('@/lib/orchestration-mapping-lock');
    let written = false;
    const writer = reloaded.withOrchestrationMappingWrite('ws-reload', async () => { written = true; });
    await flush();
    const waited = !written;
    release.resolve();
    await Promise.all([reader, writer]);
    expect(waited).toBe(true);
    expect(written).toBe(true);
  });

  it('does not block readers in another workspace behind a writer', async () => {
    const entered = deferred();
    const release = deferred();
    const writer = withOrchestrationMappingWrite('ws-a', async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    let read = false;
    const reader = withOrchestrationMappingRead('ws-b', async () => { read = true; });
    await flush();
    const concurrent = read;
    release.resolve();
    await Promise.all([writer, reader]);
    expect(concurrent).toBe(true);
  });
});
