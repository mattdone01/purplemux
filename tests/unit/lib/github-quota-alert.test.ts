import { describe, expect, it, vi } from 'vitest';
import type { ITabEventRoute } from '@/lib/tab-event-router';
import type { TAccountQuota } from '@/lib/github-quota';
import type { IWorkspace } from '@/types/terminal';

vi.mock('@/lib/logger', () => {
  const logger = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => logger };
  return { createLogger: () => logger };
});

const { QUOTA_ALERT_SHARE, createQuotaAlertState, quotaAlertText, runQuotaAlerts } = await import('@/lib/github-quota-alert');
type IQuotaAlertDeps = import('@/lib/github-quota-alert').IQuotaAlertDeps;

// engineering#810 R2: below 20 % of core, one line per agent account per reset window, to the orchestrator.

const NOW = Date.UTC(2026, 10, 18, 8, 0, 0);
const RESET = Math.floor(NOW / 1000) + 40 * 60;

const agent = (remaining: number, reset = RESET, login = 'mattdone-ai'): TAccountQuota => ({
  login, role: 'agent', state: 'read', readAt: NOW,
  core: { remaining, limit: 5000, reset }, graphql: { remaining: 5000, limit: 5000, reset },
});

const OWNERS = [
  { label: 'worker-1 (epic-a)', rest: 900 },
  { label: 'runner (ci)', rest: 400 },
  { label: 'worker-2 (epic-a)', rest: 120 },
  { label: 'quiet (epic-b)', rest: 3 },
];

const workspace = (id: string, orchestratorTabId: string, enabled = true): IWorkspace => ({
  id, name: `name-${id}`, directories: ['/tmp'], orchestration: { enabled, orchestratorTabId },
} as unknown as IWorkspace);

const deps = (overrides: Partial<IQuotaAlertDeps> = {}) => {
  const routed: ITabEventRoute[] = [];
  const d: IQuotaAlertDeps = {
    scrumMaster: async () => ({ managerWorkspaceId: 'ws-sm', managerTabId: 'tab-sm', workspaceIds: [] }),
    workspaces: async () => [workspace('ws-sm', 'tab-sm')],
    routeTabEvent: async (event) => { routed.push(event); return { delivered: 'queued' }; },
    topOwners: async () => OWNERS,
    ...overrides,
  };
  return { d, routed };
};

describe('quota alert', () => {
  it('is 20 %', () => {
    expect(QUOTA_ALERT_SHARE).toBe(0.2);
  });

  it('sends one line below 20 % naming the account, remaining/limit, the reset and the top 3 owners', async () => {
    const { d, routed } = deps();
    const state = createQuotaAlertState();
    const result = await runQuotaAlerts(d, state, [agent(999)], NOW);
    expect(routed).toHaveLength(1);
    expect(routed[0]).toMatchObject({ workspaceId: 'ws-sm', tabId: 'tab-sm', kind: 'flag', rule: 'github-quota-low' });
    expect(routed[0].text).toBe(
      `GitHub REST quota low: mattdone-ai core 999/5000 (19%), resets ${new Date(RESET * 1000).toISOString()}; `
      + 'top owners, last hour: worker-1 (epic-a) 900 REST, runner (ci) 400 REST, worker-2 (epic-a) 120 REST',
    );
    expect(routed[0].text).not.toContain('quiet');
    expect(result.sent).toEqual(['mattdone-ai']);
  });

  it('is quiet at or above 20 %', async () => {
    const { d, routed } = deps();
    await runQuotaAlerts(d, createQuotaAlertState(), [agent(1000), agent(4000, RESET, 'bot-2')], NOW);
    expect(routed).toEqual([]);
  });

  it('is not repeated in the same reset window, and fires again in the next one', async () => {
    const { d, routed } = deps();
    const state = createQuotaAlertState();
    await runQuotaAlerts(d, state, [agent(900)], NOW);
    await runQuotaAlerts(d, state, [agent(500)], NOW + 5 * 60_000);
    await runQuotaAlerts(d, state, [agent(10)], NOW + 10 * 60_000);
    expect(routed).toHaveLength(1);
    const next = RESET + 3600;
    await runQuotaAlerts(d, state, [agent(800, next)], (RESET + 60) * 1000);
    expect(routed).toHaveLength(2);
  });

  it('one line per account', async () => {
    const { d, routed } = deps();
    await runQuotaAlerts(d, createQuotaAlertState(), [agent(10), agent(20, RESET, 'bot-2')], NOW);
    expect(routed.map((e) => e.text.split(' ')[4])).toEqual(['mattdone-ai', 'bot-2']);
  });

  it('never alerts on an unknown, owner or unset account, nor past the reset', async () => {
    const { d, routed } = deps();
    await runQuotaAlerts(d, createQuotaAlertState(), [
      { login: 'x', role: 'agent', state: 'unknown', reason: 'rate_limit did not parse', readAt: NOW },
      { login: 'mattdone01', role: 'owner', state: 'not-read', reason: 'not read (owner account)' },
      agent(1, Math.floor(NOW / 1000) - 1),
    ], NOW);
    expect(routed).toEqual([]);
  });

  it('a line with no target, or one the router refuses, is tried again on the next read', async () => {
    const state = createQuotaAlertState();
    const none = deps({ scrumMaster: async () => null });
    expect((await runQuotaAlerts(none.d, state, [agent(10)], NOW)).noTarget).toEqual(['mattdone-ai: no-scrum-master']);
    const disabled = deps({ workspaces: async () => [workspace('ws-sm', 'tab-sm', false)] });
    expect((await runQuotaAlerts(disabled.d, state, [agent(10)], NOW)).noTarget).toEqual(['mattdone-ai: orchestrator-disabled']);
    const refused = deps({ routeTabEvent: async () => { throw new Error('tab gone'); } });
    expect((await runQuotaAlerts(refused.d, state, [agent(10)], NOW)).sent).toEqual([]);
    const ok = deps();
    await runQuotaAlerts(ok.d, state, [agent(10)], NOW + 5 * 60_000);
    expect(ok.routed).toHaveLength(1);
  });

  it('says so when no owner was counted', () => {
    expect(quotaAlertText('a', { remaining: 0, limit: 5000, reset: RESET }, [])).toContain('top owners, last hour: none counted');
  });
});
