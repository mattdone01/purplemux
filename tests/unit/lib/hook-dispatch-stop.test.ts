import { beforeEach, describe, expect, it, vi } from 'vitest';

// The Claude stop route (F6, F10 steps 1-2; design check (2) ruling): the decision comes first; a block is answered
// and never applied, so the agent continues its turn; any other decision is applied as the stop.

const status = vi.hoisted(() => ({
  decideClaudeStop: vi.fn(),
  handleProviderEvent: vi.fn(() => true),
}));
vi.mock('@/lib/status-manager', () => ({ getStatusManager: () => status }));

const { dispatchHook } = await import('@/lib/hook-dispatch');

const BODY = { hook_event_name: 'Stop', session_id: 's-1', last_assistant_message: 'DONE: x', stop_hook_active: false };

describe('the Claude stop route', () => {
  beforeEach(() => vi.clearAllMocks());

  it('answers a block and applies nothing', async () => {
    status.decideClaudeStop.mockResolvedValue({ kind: 'block', reason: 'Run purplemux done …' });
    const outcome = await dispatchHook({ query: { kind: 'stop', session: 'pt-s' }, body: BODY });
    expect(outcome).toEqual({ status: 200, body: { decision: 'block', reason: 'Run purplemux done …' } });
    expect(status.decideClaudeStop).toHaveBeenCalledWith('pt-s', { hookEvent: 'Stop', sessionId: 's-1', message: 'DONE: x' }, undefined);
    expect(status.handleProviderEvent).not.toHaveBeenCalled();
  });

  it.each([
    [{ kind: 'row', row: {} }],
    [{ kind: 'classifier', why: 'unscoped' }],
    [{ kind: 'unreported', reason: 'cap', escalation: null }],
  ])('applies the stop for %j and answers {}', async (decision) => {
    status.decideClaudeStop.mockResolvedValue(decision);
    expect(await dispatchHook({ query: { kind: 'stop', session: 'pt-s' }, body: BODY })).toEqual({ status: 200, body: {} });
    expect(status.handleProviderEvent).toHaveBeenCalledWith('claude', 'pt-s', { kind: 'stop' }, undefined, { replayed: false });
  });

  it('a replay is decided as replayed and applied at its own time; a dropped body still applies as a plain stop', async () => {
    status.decideClaudeStop.mockResolvedValue({ kind: 'unreported', reason: 'not-blockable:replayed', escalation: null });
    await dispatchHook({ query: { kind: 'stop', session: 'pt-s' }, body: null, replayedAt: 1_700_000_000_000 });
    expect(status.decideClaudeStop).toHaveBeenCalledWith('pt-s', { hookEvent: null, sessionId: null, message: null }, 1_700_000_000_000);
    expect(status.handleProviderEvent).toHaveBeenCalledWith('claude', 'pt-s', { kind: 'stop' }, 1_700_000_000_000, { replayed: true });
  });

  it('a stop with no session in its query applies nothing', async () => {
    expect(await dispatchHook({ query: { kind: 'stop' }, body: BODY })).toEqual({ status: 200, body: {} });
    expect(status.decideClaudeStop).not.toHaveBeenCalled();
  });

  it('review round 2: a live hook with occurredAt is live; only the spool drain marks a replay', async () => {
    const occurredAt = Date.now() - 1_000;
    await dispatchHook({ query: { occurredAt: String(occurredAt) }, body: { event: 'notification', session: 'pt-s', notificationType: 'idle_prompt' } });
    expect(status.handleProviderEvent).toHaveBeenLastCalledWith('claude', 'pt-s', { kind: 'notification', notificationType: 'idle_prompt' },
      occurredAt, { replayed: false });
    await dispatchHook({ query: {}, body: { event: 'notification', session: 'pt-s', notificationType: 'idle_prompt' }, replayedAt: occurredAt });
    expect(status.handleProviderEvent).toHaveBeenLastCalledWith('claude', 'pt-s', { kind: 'notification', notificationType: 'idle_prompt' },
      occurredAt, { replayed: true });
  });
});
