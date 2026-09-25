import { describe, expect, it, vi } from 'vitest';
import { createMissionPollScheduler } from '@/hooks/use-mission-control';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe('Mission Control polling scheduler', () => {
  it('allows only the current visibility epoch to schedule the next poll', async () => {
    const request = deferred();
    const refresh = vi.fn(() => request.promise);
    const scheduled: Array<() => void> = [];
    const scheduler = createMissionPollScheduler({
      refresh,
      isHidden: () => false,
      schedule: (callback) => {
        scheduled.push(callback);
        return scheduled.length as unknown as ReturnType<typeof setTimeout>;
      },
      cancel: vi.fn(),
    });

    scheduler.start();
    scheduler.restart();
    expect(refresh).toHaveBeenCalledTimes(2);

    request.resolve();
    await request.promise;
    await Promise.resolve();

    expect(scheduled).toHaveLength(1);
    scheduler.stop();
  });
});
