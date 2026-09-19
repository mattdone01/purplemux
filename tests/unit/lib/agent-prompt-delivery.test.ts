import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/layout-store', () => ({ findTabBySessionName: vi.fn() }));
vi.mock('@/lib/tmux', () => ({
  sendBracketedPasteText: vi.fn(),
  sendTypedText: vi.fn(),
  submitComposer: vi.fn(),
}));

import { findTabBySessionName } from '@/lib/layout-store';
import {
  deliverPrompt,
  deliverPromptText,
  sessionUsesTypedDelivery,
  usesTypedDelivery,
  type IPromptDeliveryDeps,
} from '@/lib/agent-prompt-delivery';
import type { ITab } from '@/types/terminal';

const SESSION = 'pt-ws-1-pane-1-tab-1';

const harness = (typed: boolean) => {
  const calls: string[] = [];
  const deps: IPromptDeliveryDeps = {
    usesTyped: async () => typed,
    typeText: async (_s, content) => void calls.push(`type:${content}`),
    pasteText: async (_s, content) => void calls.push(`paste:${content}`),
    submit: async () => void calls.push('submit'),
  };
  return { calls, deps };
};

describe('usesTypedDelivery', () => {
  it('is true for Claude Code only', () => {
    expect(usesTypedDelivery('claude-code')).toBe(true);
    expect(usesTypedDelivery('codex-cli')).toBe(false);
    expect(usesTypedDelivery('grok-cli')).toBe(false);
    expect(usesTypedDelivery('terminal')).toBe(false);
    expect(usesTypedDelivery(undefined)).toBe(false);
  });
});

describe('sessionUsesTypedDelivery', () => {
  it('reads the panel type of the tab that owns the session', async () => {
    vi.mocked(findTabBySessionName).mockResolvedValueOnce({ panelType: 'claude-code' } as ITab);
    expect(await sessionUsesTypedDelivery(SESSION)).toBe(true);
    vi.mocked(findTabBySessionName).mockResolvedValueOnce({ panelType: 'codex-cli' } as ITab);
    expect(await sessionUsesTypedDelivery(SESSION)).toBe(false);
  });

  it('falls back to a paste when no tab owns the session or the layout is unreadable', async () => {
    vi.mocked(findTabBySessionName).mockResolvedValueOnce(null);
    expect(await sessionUsesTypedDelivery(SESSION)).toBe(false);
    vi.mocked(findTabBySessionName).mockRejectedValueOnce(new Error('EIO'));
    expect(await sessionUsesTypedDelivery(SESSION)).toBe(false);
  });
});

describe('deliverPrompt', () => {
  it('types the prompt into a Claude Code composer, then submits', async () => {
    const { calls, deps } = harness(true);
    await deliverPrompt(SESSION, 'brief', deps);
    expect(calls).toEqual(['type:brief', 'submit']);
  });

  it('pastes into every other composer, then submits', async () => {
    const { calls, deps } = harness(false);
    await deliverPrompt(SESSION, 'brief', deps);
    expect(calls).toEqual(['paste:brief', 'submit']);
  });

  it('does not submit when the delivery fails', async () => {
    const { calls, deps } = harness(true);
    deps.typeText = async () => {
      throw new Error('tmux gone');
    };
    await expect(deliverPrompt(SESSION, 'brief', deps)).rejects.toThrow('tmux gone');
    expect(calls).toEqual([]);
  });
});

describe('deliverPromptText', () => {
  it('never submits', async () => {
    const typed = harness(true);
    await deliverPromptText(SESSION, 'draft', typed.deps);
    expect(typed.calls).toEqual(['type:draft']);
    const pasted = harness(false);
    await deliverPromptText(SESSION, 'draft', pasted.deps);
    expect(pasted.calls).toEqual(['paste:draft']);
  });
});
