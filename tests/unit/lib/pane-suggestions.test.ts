import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { composerLineIndex, parseSgrLine, renderPaneResult } from '@/lib/pane-suggestions';

// `tab result` (story 17, L7). Fixtures are real captures (`capture-pane -p -e -J`)
// of idle Claude tabs, 2026-09-26.
const pane = (name: string) => fs.readFileSync(path.join(__dirname, '../../fixtures/panes', name), 'utf-8');
const ESC = '\x1b';
const composerOf = (content: string) => content.split('\n').find((line) => line.startsWith('❯')) ?? '';

describe('parseSgrLine', () => {
  it('tracks dim on (2) and off (22, 0, empty)', () => {
    const { segments } = parseSgrLine(`a${ESC}[2mb${ESC}[22mc${ESC}[2md${ESC}[0me${ESC}[2mf${ESC}[mg`);
    expect(segments).toEqual([
      { text: 'a', dim: false }, { text: 'b', dim: true }, { text: 'c', dim: false },
      { text: 'd', dim: true }, { text: 'e', dim: false }, { text: 'f', dim: true }, { text: 'g', dim: false },
    ]);
  });

  it('never reads a colour argument as an attribute (38;5;2 is colour 2, not dim)', () => {
    expect(parseSgrLine(`${ESC}[38;5;2mgreen`).segments).toEqual([{ text: 'green', dim: false }]);
    expect(parseSgrLine(`${ESC}[38;2;2;2;2mrgb`).segments).toEqual([{ text: 'rgb', dim: false }]);
    expect(parseSgrLine(`${ESC}[1;2mboth`).segments).toEqual([{ text: 'both', dim: true }]);
  });

  it('reads only the head of a `:` group: 4:2 is double underline, not dim; 38:5:2 is a colour', () => {
    expect(parseSgrLine(`${ESC}[4:2mdouble`).segments).toEqual([{ text: 'double', dim: false }]);
    expect(parseSgrLine(`${ESC}[38:5:2mcolon-colour`).segments).toEqual([{ text: 'colon-colour', dim: false }]);
    expect(parseSgrLine(`${ESC}[38:2::2:2:2;2mthen-dim`).segments).toEqual([{ text: 'then-dim', dim: true }]);
  });

  it('carries dim across lines and strips OSC links', () => {
    const first = parseSgrLine(`x${ESC}[2my`);
    expect(first.dimAtEnd).toBe(true);
    expect(parseSgrLine(`${ESC}]8;;https://e.x${ESC}\\link${ESC}]8;;${ESC}\\z`, first.dimAtEnd).segments)
      .toEqual([{ text: 'linkz', dim: true }]);
  });
});

describe('composerLineIndex', () => {
  it('finds the last line carrying the provider marker', () => {
    expect(composerLineIndex(['❯ old', 'x', '❯ ', 'footer'], 'claude-code')).toBe(2);
    expect(composerLineIndex(['› '], 'codex-cli')).toBe(0);
    expect(composerLineIndex(['> '], 'grok-cli')).toBe(0);
    expect(composerLineIndex(['❯ '], 'terminal')).toBe(-1);
    expect(composerLineIndex(['❯ '], undefined)).toBe(-1);
  });
});

describe('renderPaneResult', () => {
  it('marks the dim composer text as a suggestion and returns it', () => {
    const { content, suggestion } = renderPaneResult(pane('claude-dim-suggestion.ansi'), 'claude-code');
    expect(suggestion).toBe('Billing cleared: re-run the listed runs and continue M2');
    expect(composerOf(content)).toBe('❯ [suggestion] Billing cleared: re-run the listed runs and continue M2');
    expect(content).not.toContain(ESC);
  });

  it('marks the suggestion under a footer line above the composer, and nothing above it', () => {
    const { content, suggestion } = renderPaneResult(pane('claude-dim-suggestion-footer.ansi'), 'claude-code');
    expect(suggestion).toBe('GH Actions billing restored; re-ran refused runs');
    expect(content.match(/\[suggestion\]/g)).toHaveLength(1);
    expect(content).toContain('new task? /clear to save 743.7k tokens');
  });

  it('prints typed (non-dim) composer text plainly, next to a suggestion', () => {
    const captured = `done\n${ESC}[39m❯ fix the ${ESC}[2mbuild and rerun${ESC}[0m\n`;
    const { content, suggestion } = renderPaneResult(captured, 'claude-code');
    expect(composerOf(content)).toBe('❯ fix the [suggestion] build and rerun');
    expect(suggestion).toBe('build and rerun');
  });

  it('--no-suggestions drops the dim text and reports none', () => {
    const { content, suggestion } = renderPaneResult(pane('claude-dim-suggestion.ansi'), 'claude-code', 'no-suggestions');
    expect(suggestion).toBeNull();
    expect(composerOf(content)).toBe('❯');
    expect(content).not.toContain('Billing cleared');
  });

  it('--raw returns the capture untouched, escapes included, with the suggestion alongside', () => {
    const captured = pane('claude-dim-suggestion.ansi');
    const { content, suggestion } = renderPaneResult(captured, 'claude-code', 'raw');
    expect(content).toBe(captured);
    expect(content).toContain(`${ESC}[2m`);
    expect(suggestion).toBe('Billing cleared: re-run the listed runs and continue M2');
  });

  it.each(['claude-dim-suggestion.ansi', 'claude-dim-suggestion-footer.ansi', 'claude-fresh-80x24.ansi', 'claude-empty-composer.ansi'])(
    '--raw and the default report the same suggestion (%s)', (name) => {
      const captured = pane(name);
      expect(renderPaneResult(captured, 'claude-code', 'raw').suggestion).toBe(renderPaneResult(captured, 'claude-code').suggestion);
    },
  );

  it('reads the dim placeholder of a fresh Claude composer as a suggestion', () => {
    expect(renderPaneResult(pane('claude-fresh-80x24.ansi'), 'claude-code').suggestion).toBe('Try "how do I log an error?"');
  });

  it('marks nothing on an empty composer, a terminal, or a screen with no composer', () => {
    expect(renderPaneResult(pane('claude-empty-composer.ansi'), 'claude-code')).toMatchObject({ suggestion: null });
    const terminal = renderPaneResult(`${ESC}[2m❯ dim prompt${ESC}[0m\n`, 'terminal');
    expect(terminal).toEqual({ content: '❯ dim prompt\n', suggestion: null });
    expect(renderPaneResult(pane('claude-trust-prompt.ansi'), 'claude-code').content).not.toContain('[suggestion]');
  });
});
