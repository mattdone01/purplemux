import { describe, expect, it } from 'vitest';
import { MAX_RESTART_RETRIES, RESTART_RETRY_DELAY_MS, terminalCloseAction } from '@/hooks/use-terminal-websocket';
import { TAB_RESTARTING_CODE } from '@/lib/terminal-protocol';

// ADR-0028 §12: the terminal hook's close decision, pinned without a DOM. 1000 is the only code that
// ends the session (the pane then closes the tab); 4002 is a restarting tab, re-attached every second
// on its own counter, so it spends none of the backoff budget.

describe('terminalCloseAction', () => {
  it('1000 ends the session, as today', () => {
    expect(terminalCloseAction(1000, 0, 0)).toEqual({ kind: 'session-ended' });
  });

  it('4002 never ends the session: it retries after 1 s on the restart counter', () => {
    expect(RESTART_RETRY_DELAY_MS).toBe(1_000);
    expect(terminalCloseAction(TAB_RESTARTING_CODE, 0, 0)).toEqual({ kind: 'retry', delay: 1_000, restart: true });
  });

  it('4002 leaves the backoff budget untouched: the same 1 s retry with the backoff budget spent', () => {
    expect(terminalCloseAction(TAB_RESTARTING_CODE, 5, 7)).toEqual({ kind: 'retry', delay: 1_000, restart: true });
  });

  it('after 120 restart retries a 4002 falls back to the normal backoff', () => {
    expect(MAX_RESTART_RETRIES).toBe(120);
    expect(terminalCloseAction(TAB_RESTARTING_CODE, 0, 119)).toEqual({ kind: 'retry', delay: 1_000, restart: true });
    expect(terminalCloseAction(TAB_RESTARTING_CODE, 0, 120)).toEqual({ kind: 'retry', delay: 1_000, restart: false });
    expect(terminalCloseAction(TAB_RESTARTING_CODE, 2, 120)).toEqual({ kind: 'retry', delay: 4_000, restart: false });
    expect(terminalCloseAction(TAB_RESTARTING_CODE, 5, 120)).toEqual({ kind: 'exhausted' });
  });

  it.each([[1011, 'session-not-found'], [1013, 'max-connections']] as const)('%i disconnects with its reason', (code, reason) => {
    expect(terminalCloseAction(code, 0, 0)).toEqual({ kind: 'disconnected', reason });
  });

  it('4001 and any other code retry with backoff until the budget is spent', () => {
    expect(terminalCloseAction(4001, 0, 0)).toEqual({ kind: 'retry', delay: 1_000, restart: false });
    expect(terminalCloseAction(1006, 3, 0)).toEqual({ kind: 'retry', delay: 8_000, restart: false });
    expect(terminalCloseAction(4001, 5, 0)).toEqual({ kind: 'exhausted' });
  });
});
