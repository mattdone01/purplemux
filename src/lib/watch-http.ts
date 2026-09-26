import type { NextApiResponse } from 'next';
import { createLogger } from '@/lib/logger';
import { isCodedError } from '@/lib/coded-error';
import type { WatchError } from '@/lib/watch-store';

const log = createLogger('watch-http');

const STATUS: Record<string, number> = {
  'watch-invalid': 400,
  'caller-unresolved': 403,
  forbidden: 403,
  'watch-not-found': 404,
  'watch-cap': 409,
  'gh-unavailable': 503,
};

/** Every refusal carries `code`, which the CLI maps to its exit (ADR-0016). */
export const sendWatchError = (res: NextApiResponse, err: unknown): void => {
  if (isCodedError<WatchError>(err, 'WatchError')) {
    res.status(STATUS[err.code] ?? 500).json({ error: err.message, code: err.code });
    return;
  }
  log.error(`watch route failed: ${err instanceof Error ? err.message : err}`);
  res.status(500).json({ error: 'watch operation failed', code: 'watch-internal' });
};
