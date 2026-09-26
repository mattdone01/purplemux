import type { NextApiResponse } from 'next';
import { isCodedError } from '@/lib/coded-error';
import type { DeployError } from '@/lib/deploy-announce';
import { createLogger } from '@/lib/logger';
import type { TDeployErrorCode } from '@/types/deploy';

const log = createLogger('deploy-http');

// Typed by the code union, so tsc refuses a code without a status (story 35 review r2).
const STATUS: Record<TDeployErrorCode, number> = {
  'deploy-invalid': 400,
  forbidden: 403,
  'deploy-not-found': 404,
};

/** Every refusal carries `code`, which the CLI maps to its exit (ADR-0016). */
export const sendDeployError = (res: NextApiResponse, err: unknown): void => {
  if (isCodedError<DeployError>(err, 'DeployError', STATUS)) {
    res.status(STATUS[err.code]).json({ error: err.message, code: err.code });
    return;
  }
  log.error(`deploy route failed: ${err instanceof Error ? err.message : err}`);
  res.status(500).json({ error: 'deploy operation failed', code: 'deploy-internal' });
};
