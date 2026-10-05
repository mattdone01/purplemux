import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
vi.mock('@/lib/cli-token', () => ({ verifyTokenValue: (token: string) => token === 'global' }));
vi.mock('@/lib/auth', () => ({
  SESSION_COOKIE: 'session-token', MAX_AGE: 604800,
  verifySessionToken: async (token: string) => token === 'human' ? { sub: 'human', exp: Math.floor(Date.now() / 1000) + 604800 } : null,
  signSessionToken: vi.fn(), buildCookieHeader: vi.fn(),
}));

const paths = [
  '/api/tabs/tab-1/send', '/api/tmux/send-input', '/api/tmux/reset', '/api/tmux/recover-unknown',
  '/api/status/agent-launch', '/api/layout', '/api/layout/pane', '/api/layout/pane/p1/tabs/t1',
  '/api/workspace', '/api/workspace/ws-a', '/api/workspace/ws-a/orchestrate',
];
describe('proxy does not turn a global CLI token into human mutation authority', () => {
  it.each(paths)('rejects global token mutation at %s and admits the human cookie', async (path) => {
    const { proxy } = await import('@/proxy');
    for (const method of ['POST', 'PATCH', 'DELETE']) {
      expect((await proxy(new NextRequest(`http://localhost${path}`, { method, headers: { 'x-pmux-token': 'global' } }))).status).toBe(401);
      expect((await proxy(new NextRequest(`http://localhost${path}`, { method, headers: { cookie: 'session-token=human' } }))).status).toBe(200);
    }
  });
  it('preserves global-token diagnostic reads', async () => {
    const { proxy } = await import('@/proxy');
    expect((await proxy(new NextRequest('http://localhost/api/layout', { headers: { 'x-pmux-token': 'global' } }))).status).toBe(200);
  });
  it.each(['args', 'confirm', 'command', 'submit'])('passes scoped launch-%s to the route authentication', async (name) => {
    const { proxy } = await import('@/proxy');
    expect((await proxy(new NextRequest(`http://localhost/api/codex/launch-${name}`, { method: 'POST', headers: { 'x-pmux-token': 'scoped' } }))).status).toBe(200);
  });
});
