import fs from 'fs';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { checkComposerReady, paneShowsEmptyComposer } from '@/lib/composer-readiness';
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

// Real captures (`capture-pane -p -e`), 2026-09-26: tests/fixtures/panes.
const pane = (name: string) => fs.readFileSync(path.join(__dirname, '../../fixtures/panes', name), 'utf-8');

describe('suggestion-aware readiness (story 17, L7)', () => {
  it('accepts an idle tab whose composer shows only a dim suggestion (8 of 12 idle claude tabs measured)', async () => {
    expect(await check('idle', { pane: pane('claude-dim-suggestion.ansi') }).result).toEqual({ ok: true });
    expect(await check('ready-for-review', { pane: pane('claude-dim-suggestion-footer.ansi') }).result).toEqual({ ok: true });
  });

  it('still refuses text typed on the composer, escapes or not', async () => {
    expect(await check('idle', { pane: 'x\n\x1b[39m❯\u00a0typed by the owner\x1b[0m\n' }).result).toEqual({ ok: false, reason: 'composer-not-empty' });
  });

  it('accepts the cursor cell drawn over the suggestion (ws-5TO0NJ tab-v76BaE: 30 false refusals, 2026-10-08)', async () => {
    expect(await check('idle', { pane: pane('claude-cursor-on-suggestion.ansi') }).result).toEqual({ ok: true });
  });

  it.each([
    ['the cursor inside a draft', `x\n\x1b[39m❯\u00a0fix th\x1b[7me\x1b[0m build\n`],
    ['the cursor after a draft', `x\n\x1b[39m❯\u00a0typed\x1b[7m \x1b[0m\n`],
    ['the cursor on a draft\'s first character', `x\n\x1b[39m❯\u00a0\x1b[7mk\x1b[0meep going\n`],
    ['a draft that a dim completion follows', `x\n\x1b[39m❯\u00a0k\x1b[7me\x1b[0;2mep going\x1b[0m\n`],
  ])('still refuses a human draft: %s', async (_label, captured) => {
    expect(await check('idle', { pane: captured }).result).toEqual({ ok: false, reason: 'composer-not-empty' });
  });

  it.each([
    ['an empty composer', 'claude-empty-composer.ansi', true],
    ['a dim suggestion', 'claude-dim-suggestion.ansi', true],
    ['a fresh Claude, 80x24 detached (dim placeholder)', 'claude-fresh-80x24.ansi', true],
    ['a fresh Claude, 200x60', 'claude-fresh-200x60.ansi', true],
    ['a trust prompt (❯ No, exit)', 'claude-trust-prompt.ansi', false],
    ['the first-run theme picker (❯ 2. Dark mode)', 'claude-onboarding-theme.ansi', false],
  ])('paneShowsEmptyComposer: %s → %s', (_label, name, ready) => {
    expect(paneShowsEmptyComposer('claude-code', pane(name))).toBe(ready);
  });

  it('reads a fresh Claude as not ready without escapes: why every composer capture keeps them', () => {
    const plain = pane('claude-fresh-80x24.ansi').replace(/\x1b\[[0-9;:?]*[A-Za-z]/g, '');
    expect(paneShowsEmptyComposer('claude-code', plain)).toBe(false);
  });

  it('paneShowsEmptyComposer knows no composer for a terminal', () => {
    expect(paneShowsEmptyComposer('terminal', pane('claude-empty-composer.ansi'))).toBe(false);
  });
});

// ppc-48 (architect ruling, option C): a Codex native subagent's PermissionRequest is dropped, so the
// tab may read ready-for-review with no permission request while its pane shows the approval dialog.
// An automated send must still refuse to type into it. Real Codex 0.158 captures (on-request,
// read-only sandbox, 2026-09-29), at 80 columns and wrapped at 50.
describe("a Codex approval dialog the tab does not know about (ppc-48, option C)", () => {
  it.each(['codex-0158-approval-80x24.txt', 'codex-0158-approval-50x24.txt'])('%s refuses the send', async (name) => {
    const pane = fs.readFileSync(path.join(__dirname, '../../fixtures/panes', name), 'utf-8');

    const result = await checkComposerReady({
      panelType: 'codex-cli',
      status: { cliState: 'ready-for-review', permissionRequest: null },
      capture: async () => pane,
    });

    expect(result).toEqual({ ok: false, reason: 'interactive-prompt-active' });
  });
});
