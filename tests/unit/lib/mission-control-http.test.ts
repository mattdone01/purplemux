import type { NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { logError } = vi.hoisted(() => ({ logError: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: logError }),
}));

import { isMissionControlError, MissionControlError } from '@/lib/mission-control-errors';
import { sendMissionError } from '@/lib/mission-control-http';

const response = () => {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  return { res: { status } as unknown as NextApiResponse, status, json };
};

class ForeignMissionControlError extends Error {
  readonly status = 409;
  readonly code = 'conflict';
  readonly current = {
    id: 'item-a',
    workspaceId: 'ws-a',
    runId: 'run-a',
    revision: 1,
    state: 'open',
    title: 'Action required',
  };

  constructor() {
    super('foreign graph conflict');
    Object.defineProperty(this, Symbol.for('purplemux.mission-control-error'), { value: true });
    this.name = 'MissionControlError';
  }
}

describe('Mission Control HTTP errors', () => {
  beforeEach(() => logError.mockClear());

  it('preserves a branded domain error from a separate module constructor', () => {
    const error = new ForeignMissionControlError();
    expect(error).not.toBeInstanceOf(MissionControlError);
    expect(isMissionControlError(error)).toBe(true);
    const { res, status, json } = response();

    sendMissionError(res, error);

    expect(status).toHaveBeenCalledWith(409);
    expect(json).toHaveBeenCalledWith({
      error: 'foreign graph conflict',
      code: 'conflict',
      current: error.current,
    });
    expect(logError).not.toHaveBeenCalled();
  });

  it('rejects an invalid branded shape and logs no error message or request data', () => {
    const error = Object.assign(new Error('sensitive detail'), {
      [Symbol.for('purplemux.mission-control-error')]: true,
      status: 503,
      code: 'conflict',
    });
    expect(isMissionControlError(error)).toBe(false);
    const { res, status, json } = response();

    sendMissionError(res, error);

    expect(status).toHaveBeenCalledWith(503);
    expect(json).toHaveBeenCalledWith({ error: 'Mission Control storage unavailable', code: 'storage-unavailable' });
    expect(logError).toHaveBeenCalledWith(
      { errorName: 'Error' },
      'Unexpected Mission Control request failure',
    );
  });

  it('logs a safe classification for genuine storage failures', () => {
    const error = new MissionControlError(503, 'storage-unavailable', 'Mission Control storage unavailable');
    const { res, status } = response();

    sendMissionError(res, error);

    expect(status).toHaveBeenCalledWith(503);
    expect(logError).toHaveBeenCalledWith(
      { status: 503, code: 'storage-unavailable' },
      'Mission Control storage failure',
    );
  });
});
