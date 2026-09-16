import { describe, expect, it, vi } from 'vitest';
import { AutomatedPromptDispatcher, type IAutomatedPromptDispatcherDeps } from '@/lib/automated-prompt-dispatcher';
import type { ITab } from '@/types/terminal';

const target: ITab = {
  id: 'root',
  name: 'root',
  order: 0,
  sessionName: 'tmux-root',
  panelType: 'codex-cli',
  agentLaunchConfig: { model: 'gpt-6-astra', effort: 'medium' },
};

const policyLock = (
  checkPolicy: (...args: unknown[]) => Promise<{ ok: boolean; error?: string }>,
): IAutomatedPromptDispatcherDeps['withPolicyLock'] =>
  async (workspaceId, target, deliver) => deliver((options) => checkPolicy(workspaceId, target, options));

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

const request = (message: string) => ({
  workspaceId: 'ws-1',
  targetTabId: target.id,
  message,
});

describe('automated prompt delivery', () => {
  it('serializes prompts per target and rechecks policy when each reaches delivery', async () => {
    const firstPaste = deferred<void>();
    const paste = vi.fn(async (_session: string, message: string) => {
      if (message === 'first') await firstPaste.promise;
    });
    const checkPolicy = vi.fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, error: 'agent-model-mismatch' });
    const dispatcher = new AutomatedPromptDispatcher({
      findTarget: vi.fn(async () => target),
      withPolicyLock: policyLock(checkPolicy),
      hasSession: vi.fn(async () => true),
      paste,
    });

    const first = dispatcher.dispatch(request('first'));
    const second = dispatcher.dispatch(request('second'));
    await vi.waitFor(() => expect(paste).toHaveBeenCalledTimes(1));
    expect(checkPolicy).toHaveBeenCalledTimes(1);
    firstPaste.resolve();

    await expect(first).resolves.toEqual({ delivered: true });
    await expect(second).resolves.toMatchObject({ delivered: false, reason: 'model-policy' });
    expect(paste).toHaveBeenCalledTimes(1);
    expect(checkPolicy).toHaveBeenLastCalledWith(
      'ws-1',
      target,
      { consumeBootstrapForTarget: true },
    );
  });

  it('allows different targets to deliver concurrently', async () => {
    const release = deferred<void>();
    const bothPasting = deferred<void>();
    let active = 0;
    const paste = vi.fn(async () => {
      active += 1;
      if (active === 2) bothPasting.resolve();
      await release.promise;
      active -= 1;
    });
    const dispatcher = new AutomatedPromptDispatcher({
      findTarget: vi.fn(async (_workspaceId: string, tabId: string) => ({ ...target, id: tabId, sessionName: tabId })),
      withPolicyLock: policyLock(vi.fn(async () => ({ ok: true as const }))),
      hasSession: vi.fn(async () => true),
      paste,
    });

    const first = dispatcher.dispatch({ ...request('first'), targetTabId: 'root-a' });
    const second = dispatcher.dispatch({ ...request('second'), targetTabId: 'root-b' });
    await bothPasting.promise;
    expect(paste).toHaveBeenCalledTimes(2);
    release.resolve();
    await Promise.all([first, second]);
  });

  it('fails closed when policy inspection errors', async () => {
    const paste = vi.fn(async () => {});
    const dispatcher = new AutomatedPromptDispatcher({
      findTarget: vi.fn(async () => target),
      withPolicyLock: policyLock(vi.fn(async () => { throw new Error('metadata unreadable'); })),
      hasSession: vi.fn(async () => true),
      paste,
    });

    await expect(dispatcher.dispatch(request('held'))).resolves.toMatchObject({
      delivered: false,
      reason: 'policy-error',
    });
    expect(paste).not.toHaveBeenCalled();
  });
});
