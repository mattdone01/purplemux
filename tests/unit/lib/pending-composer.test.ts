import { describe, expect, it } from 'vitest';
import { isPaneShowingPendingContent } from '@/lib/tmux';

/**
 * The stranded-paste detector. Its job is to notice that a `tab send` landed
 * in a worker's composer and never submitted — the state in which a line the
 * operator never typed waits in a worker's input box for anyone's Enter.
 *
 * Both directions matter. A miss lets the stray sit unnoticed; a false alarm
 * teaches an orchestrator to ignore the signal, which costs more than not
 * having it.
 */
/**
 * The REAL Claude Code composer, captured from a live pane on 2026-08-12
 * (`tmux -L purple capture-pane -p`) rather than sketched from memory. Both
 * details below were wrong in the first draft of this file and are the reason
 * it is pinned to a real capture: the prompt marker is `❯` followed by a
 * NON-BREAKING space (U+00A0), and the box rules are `─` (U+2500), not `│`.
 */
const composer = (text: string) =>
  [
    'some earlier output',
    '─'.repeat(10),
    `❯ ${text}`,
    '─'.repeat(10),
    '',
    '  ⏵⏵ bypass permissions on · 1 shell',
  ].join('\n');

describe('isPaneShowingPendingContent', () => {
  it('flags content still sitting on the prompt row', () => {
    expect(isPaneShowingPendingContent(composer('commit this'), 'commit this')).toBe(true);
  });

  it('reports nothing pending once the composer is empty', () => {
    const pane = ['⏺ Committed 3 files.', '─'.repeat(10), '❯\u00a0', '─'.repeat(10)].join('\n');
    expect(isPaneShowingPendingContent(pane, 'commit this')).toBe(false);
  });

  it('does NOT mistake the transcript echo of a submitted message for a pending one', () => {
    // The agent submitted it and the TUI printed it back, far above the
    // composer. Only the bottom of the pane counts.
    const pane = [
      '> commit this',
      '⏺ Running git commit…',
      ...Array.from({ length: 10 }, (_, i) => `  line ${i}`),
      '─'.repeat(10),
      '❯\u00a0',
      '─'.repeat(10),
    ].join('\n');
    expect(isPaneShowingPendingContent(pane, 'commit this')).toBe(false);
  });

  it('matches on the first line of a multi-line paste', () => {
    const content = 'wait for precommit to finish\nthen report the result';
    expect(isPaneShowingPendingContent(composer('wait for precommit to finish'), content)).toBe(true);
  });

  it('ignores plain output lines that carry no composer marker', () => {
    const pane = ['commit this', 'commit this', 'commit this'].join('\n');
    expect(isPaneShowingPendingContent(pane, 'commit this')).toBe(false);
  });

  it('stays silent on content too short to identify', () => {
    // A two-character send cannot be distinguished from incidental pane text,
    // so the detector declines rather than guessing.
    expect(isPaneShowingPendingContent(composer('ok'), 'ok')).toBe(false);
  });
});
