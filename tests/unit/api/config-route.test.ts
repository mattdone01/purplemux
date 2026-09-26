import type { NextApiRequest, NextApiResponse } from 'next';
import { describe, expect, it, vi } from 'vitest';

// Story 20: GET /api/config never serves the host-signal command (it stays server-side).

vi.mock('@/lib/config-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/config-store')>()),
  getConfig: vi.fn(async () => ({
    authPassword: 'scrypt:x', authSecret: 's', hostSignalCommand: '/opt/host-signals.py --token abc', locale: 'en', updatedAt: 't',
  })),
}));

describe('GET /api/config', () => {
  it('omits hostSignalCommand, the password and the secret', async () => {
    const { default: handler } = await import('@/pages/api/config');
    const state = { status: 0, body: undefined as Record<string, unknown> | undefined };
    const res = { status(c: number) { state.status = c; return this; }, json(b: Record<string, unknown>) { state.body = b; return this; }, setHeader() { return this; } } as unknown as NextApiResponse;
    await handler({ method: 'GET', headers: {}, query: {}, socket: {} } as unknown as NextApiRequest, res);
    expect(state.status).toBe(200);
    expect(state.body).toMatchObject({ locale: 'en', hasAuthPassword: true });
    expect(state.body).not.toHaveProperty('hostSignalCommand');
    expect(state.body).not.toHaveProperty('authPassword');
    expect(state.body).not.toHaveProperty('authSecret');
  });
});
