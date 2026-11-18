import { describe, expect, it, vi } from 'vitest';
import type { ITabEventRoute } from '@/lib/tab-event-router';
import type { TAccountQuota } from '@/lib/github-quota';
import type { IWorkspace } from '@/types/terminal';

vi.mock('@/lib/logger', () => {
  const logger = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => logger };
  return { createLogger: () => logger };
});

const { QUOTA_ALERT_SHARE, coverageText, createQuotaAlertState, quotaAlertText, runQuotaAlerts } = await import('@/lib/github-quota-alert');
type IQuotaAlertDeps = import('@/lib/github-quota-alert').IQuotaAlertDeps;

// R2: below 20 % of core, one line per agent account per reset window, to the portfolio Scrum Master seat.

const NOW = Date.UTC(2026, 10, 18, 8, 0, 0);
const RESET = Math.floor(NOW / 1000) + 40 * 60;

const agent = (remaining: number, reset = RESET, login = 'agent-bot'): TAccountQuota => ({
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
    countedRestSince: async () => 4100,
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
      `GitHub REST quota low: agent-bot core 999/5000 (19%), resets ${new Date(RESET * 1000).toISOString()}; `
      + `counted 4100 REST calls (any account) of 4001 spent since ${new Date(RESET * 1000 - 60 * 60_000).toISOString()} (102%); `
      + 'top counted owners, last hour: worker-1 (epic-a) 900 REST, runner (ci) 400 REST, worker-2 (epic-a) 120 REST',
    );
    expect(routed[0].text).not.toContain('quiet');
    expect(result.sent).toEqual(['agent-bot']);
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
    expect(routed.map((e) => e.text.split(' ')[4])).toEqual(['agent-bot', 'bot-2']);
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
    expect((await runQuotaAlerts(none.d, state, [agent(10)], NOW)).noTarget).toEqual(['agent-bot: no-scrum-master']);
    const disabled = deps({ workspaces: async () => [workspace('ws-sm', 'tab-sm', false)] });
    expect((await runQuotaAlerts(disabled.d, state, [agent(10)], NOW)).noTarget).toEqual(['agent-bot: orchestrator-disabled']);
    const refused = deps({ routeTabEvent: async () => { throw new Error('tab gone'); } });
    expect((await runQuotaAlerts(refused.d, state, [agent(10)], NOW)).sent).toEqual([]);
    const ok = deps();
    await runQuotaAlerts(ok.d, state, [agent(10)], NOW + 5 * 60_000);
    expect(ok.routed).toHaveLength(1);
  });

  it('says so when no owner was counted', () => {
    expect(quotaAlertText('a', { remaining: 0, limit: 5000, reset: RESET }, [], 0)).toContain('top counted owners, last hour: none counted');
  });

  it('asks for the counted calls since the core window began, one hour before the reset', async () => {
    const asked: number[] = [];
    const { d, routed } = deps({ countedRestSince: async (from) => { asked.push(from); return 300; } });
    await runQuotaAlerts(d, createQuotaAlertState(), [agent(999)], NOW);
    expect(asked).toEqual([RESET * 1000 - 60 * 60_000]);
    expect(routed[0].text).toContain('counted 300 REST calls (any account) of 4001 spent');
  });

  it('says most calls are not counted when the count is below half of the quota spent (a process or host outside the tabs)', () => {
    const core = { remaining: 900, limit: 5000, reset: RESET };
    expect(coverageText(core, 2049)).toMatch(/\(49%\); most calls are not counted: another process or host on the account, or a long poll such as gh run watch$/);
    expect(coverageText(core, 2050)).toMatch(/\(50%\)$/);
    expect(coverageText({ remaining: 5000, limit: 5000, reset: RESET }, 0)).toMatch(/of 0 spent since .* \(none spent\)$/);
  });

  it('does not send, and tries again, when the counted calls cannot be read', async () => {
    const state = createQuotaAlertState();
    const broken = deps({ countedRestSince: async () => { throw new Error('log unreadable'); } });
    expect((await runQuotaAlerts(broken.d, state, [agent(10)], NOW)).sent).toEqual([]);
    expect(broken.routed).toHaveLength(0);
    const ok = deps();
    expect((await runQuotaAlerts(ok.d, state, [agent(10)], NOW + 5 * 60_000)).sent).toEqual(['agent-bot']);
  });
});
