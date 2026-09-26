import { describe, expect, it, vi } from 'vitest';
import { checkComposerReady } from '@/lib/composer-readiness';
import type { TCliState } from '@/types/timeline';

const EMPTY = 'done\n────────\n❯ \n────────\n';

const check = (cliState: TCliState | null, extra: { waitingAtPrompt?: boolean; permission?: boolean; pane?: string | null } = {}) => {
  const capture = vi.fn(async () => (extra.pane === undefined ? EMPTY : extra.pane));
  const result = checkComposerReady({
    panelType: 'claude-code',
    status: cliState === null ? undefined : { cliState, permissionRequest: extra.permission ? ({ id: 'p' } as never) : null },
    capture,
    waitingAtPrompt: extra.waitingAtPrompt,
  });
  return { result, capture };
};

describe('checkComposerReady (ADR-0008, ADR-0012)', () => {
  it.each(['idle', 'ready-for-review'] as TCliState[])('accepts %s with an empty composer', async (state) => {
    expect(await check(state).result).toEqual({ ok: true });
  });

  it('accepts busy only when waiting at the prompt (ruling A′)', async () => {
    expect(await check('busy', { waitingAtPrompt: true }).result).toEqual({ ok: true });
    expect(await check('busy').result).toEqual({ ok: false, reason: 'composer-not-ready:busy' });
  });

  it.each(['needs-input', 'inactive', 'unknown'] as TCliState[])('refuses %s even with the waiting flag', async (state) => {
    expect(await check(state, { waitingAtPrompt: true }).result).toEqual({ ok: false, reason: `composer-not-ready:${state}` });
  });

  it('checks status before reading the pane', async () => {
    const missing = check(null);
    expect(await missing.result).toEqual({ ok: false, reason: 'status-unavailable' });
    expect(missing.capture).not.toHaveBeenCalled();
    const prompt = check('idle', { permission: true });
    expect(await prompt.result).toEqual({ ok: false, reason: 'native-prompt-active' });
    expect(prompt.capture).not.toHaveBeenCalled();
  });

  it('refuses an unreadable pane, an option list and a typed composer', async () => {
    expect(await check('idle', { pane: null }).result).toEqual({ ok: false, reason: 'composer-unreadable' });
    expect(await check('idle', { pane: 'Proceed?\n❯ 1. Yes\n  2. No\n' }).result).toEqual({ ok: false, reason: 'interactive-prompt-active' });
    expect(await check('idle', { pane: 'x\n❯ typed\n' }).result).toEqual({ ok: false, reason: 'composer-not-empty' });
  });

  it('turns a capture that throws into composer-unreadable', async () => {
    const result = await checkComposerReady({
      panelType: 'claude-code',
      status: { cliState: 'idle', permissionRequest: null },
      capture: async () => { throw new Error('tmux gone'); },
    });
    expect(result).toEqual({ ok: false, reason: 'composer-unreadable' });
  });
});
