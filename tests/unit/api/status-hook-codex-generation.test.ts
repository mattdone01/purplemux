import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const lifecycle = vi.hoisted(() => ({
  withValidatedCodexHookGeneration: vi.fn(),
  withValidatedLegacyCodexHook: vi.fn(),
}));
const status = vi.hoisted(() => ({
  applyAgentHookMeta: vi.fn(),
  handleProviderEvent: vi.fn(),
}));
vi.mock('@/lib/providers/codex/launch-lifecycle', () => lifecycle);
vi.mock('@/lib/status-manager', () => ({ getStatusManager: () => status }));
vi.mock('@/lib/cli-token', () => ({ verifyCliToken: vi.fn(() => true) }));
vi.mock('@/lib/access-filter', () => ({ isRequestAllowed: vi.fn(() => true) }));

const response = () => ({
  status: vi.fn().mockReturnThis(),
  json: vi.fn().mockReturnThis(),
  end: vi.fn().mockReturnThis(),
  setHeader: vi.fn(),
}) as unknown as NextApiResponse;

const request = (generation = 'codex-generation') => ({
  method: 'POST',
  headers: { 'x-pmux-token': 'token' },
  socket: { remoteAddress: '127.0.0.1' },
  query: {
    provider: 'codex',
    tmuxSession: 'pt-ws-pins-pane-one-tab-pins',
    generation,
  },
  body: {
    hook_event_name: 'SessionStart',
    session_id: '01a008c1-bb96-71d1-9769-b63ff478fd9f',
    transcript_path: '/tmp/session.jsonl',
    source: 'resume',
  },
}) as unknown as NextApiRequest;

describe('Codex hook generation gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    status.applyAgentHookMeta.mockReturnValue({ tabId: 'tab-pins', cliState: 'inactive' });
    lifecycle.withValidatedCodexHookGeneration.mockImplementation(
      async (_session: string, _generation: string, work: () => unknown) => ({ ok: true, value: await work() }),
    );
    lifecycle.withValidatedLegacyCodexHook.mockImplementation(
      async (_session: string, _meta: unknown, work: () => unknown) => ({ ok: true, value: await work() }),
    );
  });

  it('applies metadata and events inside the validated active-generation callback', async () => {
    const { default: handler } = await import('@/pages/api/status/hook');
    await handler(request(), response());
    expect(lifecycle.withValidatedCodexHookGeneration).toHaveBeenCalledWith(
      'pt-ws-pins-pane-one-tab-pins', 'codex-generation', expect.any(Function),
    );
    expect(status.applyAgentHookMeta).toHaveBeenCalled();
    expect(status.handleProviderEvent).toHaveBeenCalledWith(
      'codex', 'pt-ws-pins-pane-one-tab-pins', { kind: 'session-start' },
    );
  });

  it('does not let a stale generation restore old session metadata', async () => {
    lifecycle.withValidatedCodexHookGeneration.mockResolvedValue({
      ok: false,
      reason: 'generation-not-active',
    });
    const { default: handler } = await import('@/pages/api/status/hook');
    await handler(request('old-generation'), response());
    expect(status.applyAgentHookMeta).not.toHaveBeenCalled();
    expect(status.handleProviderEvent).not.toHaveBeenCalled();
  });

  it('routes an untagged legacy hook through the strict legacy binding validator', async () => {
    const { default: handler } = await import('@/pages/api/status/hook');
    await handler(request(''), response());
    expect(lifecycle.withValidatedLegacyCodexHook).toHaveBeenCalledWith(
      'pt-ws-pins-pane-one-tab-pins',
      {
        sessionId: '01a008c1-bb96-71d1-9769-b63ff478fd9f',
        jsonlPath: '/tmp/session.jsonl',
      },
      expect.any(Function),
    );
  });
});
