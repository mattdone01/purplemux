import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

// ADR-0050 (S1): the route only resolves the caller and hands the lookup to `lookupAddress` (its own tests pin the rules).

const m = vi.hoisted(() => ({
  lookup: vi.fn(async () => ({ status: 200, body: { address: 'uds:/run/user/1000/cc-socks/1.sock' } }) as { status: number; body: Record<string, unknown> }),
  caller: { workspaceId: 'ws-A', tabId: 'tab-1' },
}));
vi.mock('@/lib/address-lookup', () => ({ lookupAddress: m.lookup, defaultAddressLookupDeps: async () => ({ deps: true }) }));
vi.mock('@/lib/caller', () => ({ resolveCaller: async () => m.caller }));

const call = async (method: string, query: Record<string, string>) => {
  const state = { statusCode: 0, body: undefined as unknown, headers: {} as Record<string, string> };
  const res = {
    status(code: number) { state.statusCode = code; return this; },
    json(payload: unknown) { state.body = payload; return this; },
    setHeader(name: string, value: string) { state.headers[name] = value; return this; },
  } as unknown as NextApiResponse;
  const { default: handler } = await import('@/pages/api/cli/tabs/[tabId]/address');
  await handler({ method, query, headers: {} } as unknown as NextApiRequest, res);
  return state;
};

describe('GET /api/cli/tabs/[tabId]/address', () => {
  beforeEach(() => vi.clearAllMocks());

  it('answers what the lookup answers, for the resolved caller and the named target', async () => {
    const answer = await call('GET', { tabId: 'tab-2', workspaceId: 'ws-A' });
    expect(answer).toMatchObject({ statusCode: 200, body: { address: 'uds:/run/user/1000/cc-socks/1.sock' } });
    expect(m.lookup).toHaveBeenCalledWith({ deps: true }, m.caller, { workspaceId: 'ws-A', tabId: 'tab-2' });
  });

  it('passes a refusal through with its status', async () => {
    m.lookup.mockResolvedValueOnce({ status: 409, body: { code: 'address-unknown', hint: 'use `purplemux tab send`; it queues' } });
    expect(await call('GET', { tabId: 'tab-2', workspaceId: 'ws-A' })).toMatchObject({ statusCode: 409, body: { code: 'address-unknown' } });
  });

  it('405s another method with no lookup', async () => {
    expect(await call('POST', { tabId: 'tab-2', workspaceId: 'ws-A' })).toMatchObject({ statusCode: 405, headers: { Allow: 'GET' } });
    expect(m.lookup).not.toHaveBeenCalled();
  });

  it('hands a missing workspaceId to the lookup, which refuses it 400 and audits it (review N2)', async () => {
    m.lookup.mockResolvedValueOnce({ status: 400, body: { code: 'invalid-request' } });
    expect(await call('GET', { tabId: 'tab-2' })).toMatchObject({ statusCode: 400, body: { code: 'invalid-request' } });
    expect(m.lookup).toHaveBeenCalledWith({ deps: true }, m.caller, { workspaceId: '', tabId: 'tab-2' });
  });
});
