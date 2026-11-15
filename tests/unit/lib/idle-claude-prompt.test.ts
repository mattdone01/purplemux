import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { paneShowsIdleClaudePrompt } from '@/lib/composer-readiness';

// PMUX-STUCK-BUSY: the pane half of the busy reconcile. A busy Claude Code pane also shows an empty composer (its
// footer says `esc to interrupt`), so an empty box alone never reads as idle. Real captures: tests/fixtures/panes.

const pane = (name: string) => fs.readFileSync(path.join(__dirname, '../../fixtures/panes', name), 'utf-8');

describe('paneShowsIdleClaudePrompt', () => {
  it.each([
    'claude-empty-composer.ansi',
    'claude-dim-suggestion.ansi',
    'claude-dim-suggestion-footer.ansi',
    'claude-cursor-on-suggestion.ansi',
    'claude-fresh-80x24.ansi',
  ])('reads %s as an idle prompt', (name) => {
    expect(paneShowsIdleClaudePrompt(pane(name))).toBe(true);
  });

  it.each([
    ['a busy pane with an empty box', 'claude-busy-empty-composer.ansi'],
    ['a busy pane with a queued line', 'claude-busy-line-queued.ansi'],
    ['a busy pane with a typed line', 'claude-busy-line-in-composer.ansi'],
    ['the trust dialog', 'claude-trust-prompt.ansi'],
    ['the trust dialog at 120x40', 'claude-trust-prompt-120x40.ansi'],
    ['the theme picker', 'claude-onboarding-theme.ansi'],
    ['the external imports dialog', 'claude-external-imports-prompt.ansi'],
    ['a typed numbered composer', 'claude-composer-numbered-80x24.ansi'],
    ['a typed wrapped composer', 'claude-composer-wrapped-80x24.ansi'],
  ])('refuses %s (%s)', (_label, name) => {
    expect(paneShowsIdleClaudePrompt(pane(name))).toBe(false);
  });

  it('refuses an empty or missing capture', () => {
    expect(paneShowsIdleClaudePrompt(null)).toBe(false);
    expect(paneShowsIdleClaudePrompt('')).toBe(false);
  });

  it('refuses an AskUserQuestion menu drawn above an empty framed box', () => {
    const rule = '─'.repeat(40);
    const menu = ['Which one?', '❯ 1. First', '  2. Second', '  3. Third', rule, '❯ ', rule, '  ? for shortcuts'].join('\n');
    expect(paneShowsIdleClaudePrompt(menu)).toBe(false);
  });

  it('refuses a framed empty box whose spinner line above it says esc to interrupt (older layout)', () => {
    const rule = '─'.repeat(40);
    const busy = ['✻ Thinking… (12s · esc to interrupt)', rule, '❯ ', rule, '  ? for shortcuts'].join('\n');
    expect(paneShowsIdleClaudePrompt(busy)).toBe(false);
    const idle = ['✻ Baked for 16s', rule, '❯ ', rule, '  ? for shortcuts'].join('\n');
    expect(paneShowsIdleClaudePrompt(idle)).toBe(true);
  });

  it('refuses an unframed composer line (a transcript that quotes one)', () => {
    expect(paneShowsIdleClaudePrompt(['some output', '❯ ', 'more output'].join('\n'))).toBe(false);
  });
});
