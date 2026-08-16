import { describe, expect, it } from 'vitest';
import type { TPanelType } from '@/types/terminal';
import type { TCliState } from '@/types/timeline';
import {
  awaitSendReadiness,
  DEFAULT_SEND_READY_TIMEOUT_MS,
  MAX_SEND_READY_TIMEOUT_MS,
  SEND_READY_POLL_INTERVAL_MS,
  resolveSendWaitMs,
  type ITabSendTarget,
  type TSendReadiness,
} from '@/lib/tab-send';

const SESSION = 'pmux-ws-pane-1-tab-1';

interface IStep {
  cliState: TCliState | null;
  panelType?: TPanelType;
  alive?: boolean;
}

/**
 * One `IStep` per readiness poll, so a test reads as the sequence of tab states
 * the loop observes. `null` stands for a tab that vanished from the layout.
 */
const runReadiness = async (
  steps: (IStep | null)[],
  timeoutMs: number,
): Promise<{ result: TSendReadiness; sleeps: number[]; polls: number }> => {
  const sleeps: number[] = [];
  let clock = 0;
  let polls = 0;
  let current: IStep | null = null;

  const result = await awaitSendReadiness(
    {
      findTarget: async (): Promise<ITabSendTarget | null> => {
        current = steps[Math.min(polls, steps.length - 1)];
        polls += 1;
        if (!current) return null;
        return { sessionName: SESSION, cliState: current.cliState, panelType: current.panelType };
      },
      hasSession: async () => current !== null && current.alive !== false,
      now: () => clock,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        clock += ms;
      },
    },
    { workspaceId: 'ws', tabId: 'tab-1', timeoutMs },
  );

  return { result, sleeps, polls };
};

const agent = (cliState: TCliState | null, alive = true): IStep => ({
  cliState,
  panelType: 'claude-code',
  alive,
});

describe('awaitSendReadiness', () => {
  it('is ready immediately when the agent already holds a composer', async () => {
    const { result, sleeps, polls } = await runReadiness([agent('idle')], 5_000);

    expect(result).toEqual({
      ok: true,
      target: { sessionName: SESSION, cliState: 'idle', panelType: 'claude-code' },
    });
    expect(sleeps).toEqual([]);
    expect(polls).toBe(1);
  });

  it.each<TCliState>(['idle', 'ready-for-review', 'needs-input'])('accepts %s without waiting', async (state) => {
    const { result } = await runReadiness([agent(state)], 5_000);

    expect(result.ok).toBe(true);
  });

  it('waits for a booting agent and reports ready once it settles', async () => {
    const { result, sleeps, polls } = await runReadiness(
      [agent('busy'), agent('busy'), agent('idle')],
      5_000,
    );

    expect(result).toMatchObject({ ok: true, target: { cliState: 'idle' } });
    expect(sleeps).toEqual([SEND_READY_POLL_INTERVAL_MS, SEND_READY_POLL_INTERVAL_MS]);
    expect(polls).toBe(3);
  });

  it('gives up at the deadline and reports the state it last saw', async () => {
    const { result, sleeps } = await runReadiness([agent('busy')], 1_200);

    expect(result).toEqual({ ok: false, reason: 'readiness-timeout', cliState: 'busy', waitedMs: 1_200 });
    expect(sleeps).toEqual([500, 500, 200]);
  });

  it('never overshoots the deadline on the final sleep', async () => {
    const { result, sleeps } = await runReadiness([agent('unknown')], 700);

    expect(sleeps).toEqual([500, 200]);
    expect(result).toMatchObject({ reason: 'readiness-timeout', waitedMs: 700 });
  });

  it('answers without sleeping at all when the caller asked not to wait', async () => {
    const { result, sleeps, polls } = await runReadiness([agent('busy')], 0);

    expect(result).toEqual({ ok: false, reason: 'readiness-timeout', cliState: 'busy', waitedMs: 0 });
    expect(sleeps).toEqual([]);
    expect(polls).toBe(1);
  });

  it('reports a dead tmux session instead of waiting out the deadline', async () => {
    const { result, sleeps } = await runReadiness([agent('busy', false)], 60_000);

    expect(result).toEqual({ ok: false, reason: 'session-not-running', cliState: 'busy' });
    expect(sleeps).toEqual([]);
  });

  it('reports a session that dies while the wait is in flight', async () => {
    const { result } = await runReadiness([agent('busy'), agent('busy', false)], 5_000);

    expect(result).toMatchObject({ reason: 'session-not-running' });
  });

  it('reports a tab that is closed while the wait is in flight', async () => {
    const { result } = await runReadiness([agent('busy'), null], 5_000);

    expect(result).toEqual({ ok: false, reason: 'tab-not-found' });
  });

  it.each<TPanelType>(['terminal', 'web-browser', 'diff', 'agent-sessions'])(
    'skips the composer gate for a %s panel',
    async (panelType) => {
      const { result, sleeps } = await runReadiness([{ cliState: null, panelType }], 5_000);

      expect(result).toMatchObject({ ok: true, target: { panelType } });
      expect(sleeps).toEqual([]);
    },
  );

  it('still refuses a non-agent panel whose tmux session is gone', async () => {
    const { result } = await runReadiness([{ cliState: null, panelType: 'terminal', alive: false }], 5_000);

    expect(result).toEqual({ ok: false, reason: 'session-not-running', cliState: null });
  });

  it('gates every agent panel type, including the newest provider', async () => {
    for (const panelType of ['claude-code', 'codex-cli', 'grok-cli'] as const) {
      const { result } = await runReadiness([{ cliState: 'busy', panelType }], 0);

      expect(result).toMatchObject({ reason: 'readiness-timeout' });
    }
  });
});

describe('resolveSendWaitMs', () => {
  it('defaults when the caller says nothing', () => {
    expect(resolveSendWaitMs(undefined)).toBe(DEFAULT_SEND_READY_TIMEOUT_MS);
  });

  it('accepts zero as "answer now"', () => {
    expect(resolveSendWaitMs(0)).toBe(0);
  });

  it('accepts a bounded positive wait', () => {
    expect(resolveSendWaitMs(1_500)).toBe(1_500);
    expect(resolveSendWaitMs(MAX_SEND_READY_TIMEOUT_MS)).toBe(MAX_SEND_READY_TIMEOUT_MS);
  });

  it.each([-1, MAX_SEND_READY_TIMEOUT_MS + 1, 1.5, Number.NaN, '30000', null, {}])(
    'rejects %s',
    (value) => {
      expect(resolveSendWaitMs(value)).toBeNull();
    },
  );
});
