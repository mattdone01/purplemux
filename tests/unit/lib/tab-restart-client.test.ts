import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestTabRestart } from '@/lib/tab-restart-client';

const ANSWER = { ok: true, workspaceId: 'ws-a', tabId: 'tab-t', resumed: true, identity: 'launch', reaped: { killed: 1, survivors: 0 } };

const reply = (status: number, body: unknown) => vi.fn(async () => new Response(
  typeof body === 'string' ? body : JSON.stringify(body),
  { status, headers: { 'content-type': 'application/json' } },
));

describe('requestTabRestart (web tab menu)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('posts the flags to the cookie route and returns the answer', async () => {
    const fetchMock = reply(200, ANSWER);
    vi.stubGlobal('fetch', fetchMock);
    expect(await requestTabRestart('ws-a', 'tab-t', { clear: true, interrupt: false })).toEqual({ ok: true, answer: ANSWER });
    expect(fetchMock).toHaveBeenCalledWith('/api/tabs/tab-t/restart?workspaceId=ws-a', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ clear: true, interrupt: false }),
    }));
  });

  it('returns the server refusal with its code', async () => {
    vi.stubGlobal('fetch', reply(409, { error: 'the tab is mid-turn', code: 'tab-busy' }));
    expect(await requestTabRestart('ws-a', 'tab-t', { clear: false, interrupt: false })).toEqual({ ok: false, code: 'tab-busy', message: 'the tab is mid-turn' });
  });

  it('a failure without a code is a read error, never a refusal', async () => {
    vi.stubGlobal('fetch', reply(502, 'Bad gateway'));
    expect(await requestTabRestart('ws-a', 'tab-t', { clear: false, interrupt: false })).toEqual({ ok: false, code: null, message: 'The restart failed (HTTP 502)' });
  });

  it('a 200 without ok: true is not a restart', async () => {
    vi.stubGlobal('fetch', reply(200, { tabId: 'tab-t' }));
    expect(await requestTabRestart('ws-a', 'tab-t', { clear: false, interrupt: false })).toMatchObject({ ok: false, code: null });
  });

  it('a lost connection says the outcome is unknown', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    expect(await requestTabRestart('ws-a', 'tab-t', { clear: false, interrupt: true })).toEqual({
      ok: false, code: null, message: 'The server did not answer; whether the tab restarted is unknown',
    });
  });
});
