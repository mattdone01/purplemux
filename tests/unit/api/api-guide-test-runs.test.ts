import type { NextApiRequest, NextApiResponse } from 'next';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/workspace-token', () => ({ resolveCliScope: () => ({ type: 'admin' }) }));

// Story 57 AC 4: the rule is written where workers read it. The api-guide states it beside the events it governs.

const guide = async (): Promise<string> => {
  const { default: handler } = await import('@/pages/api/cli/api-guide');
  let body = '';
  const res = {
    status() { return this; }, json() { return this; }, setHeader() { return this; },
    send(payload: unknown) { body = String(payload); return this; },
  } as unknown as NextApiResponse;
  await handler({ method: 'GET', headers: {} } as NextApiRequest, res);
  return body.replace(/\s+/g, ' ');
};

describe('api-guide: test-only runs (story 57)', () => {
  it('states the rule, the declaration, the refusals and the explicit read', async () => {
    const text = await guide();
    for (const phrase of [
      'no test opens an attention item that a human sees on the live server',
      'A test uses a test-only run or a scratch server',
      'POST /api/workspace { ..., "scratch": true }',
      '"test": true on run.started and on attention.opened',
      'refused with 403 forbidden',
      'GET /api/mission-control?includeTest=1',
      'the board and the pulse refuse includeTest with 403',
      'resolution "workspace deleted"',
    ]) expect(text).toContain(phrase);
  });
});
