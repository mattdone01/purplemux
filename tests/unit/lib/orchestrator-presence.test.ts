import { describe, expect, it, vi } from 'vitest';
import {
  evaluateOrchestratorPresence,
  getOrchestratorPresenceMonitor,
  type IOrchestratorPresencePersistence,
  OrchestratorPresenceMonitor,
} from '@/lib/orchestrator-presence';
import type { IOrchestratorPresenceFacts, IOrchestratorPresenceIssue } from '@/types/coordination';

const NOW = 1_800_000_000_000;

const facts = (overrides: Partial<IOrchestratorPresenceFacts> = {}): IOrchestratorPresenceFacts => ({
  workspaceId: 'ws-1',
  workspaceName: 'Payments',
  orchestration: { enabled: true, orchestratorTabId: 'orch' },
  epicLeases: ['epic:payments'],
  standupState: 'on-track',
  tabs: [{ tabId: 'orch', tabName: 'orchestrator', isAgent: true, cliState: 'busy' }],
  liveBackgroundTabIds: [],
  backgroundWorkIncomplete: false,
  ...overrides,
});

const persistence = (initial: string[] = []): IOrchestratorPresencePersistence & { value: Set<string> } => {
  const store = {
    value: new Set(initial),
    read: async () => new Set(store.value),
    replace: async (expected: ReadonlySet<string>, next: ReadonlySet<string>) => {
      if (store.value.size !== expected.size || [...store.value].some((id) => !expected.has(id))) return false;
      store.value = new Set(next);
      return true;
    },
  };
  return store;
};

const refresh = async (
  monitor: OrchestratorPresenceMonitor,
  workspaceFacts: IOrchestratorPresenceFacts[],
  observedAt: number,
): Promise<IOrchestratorPresenceIssue[]> => {
  const notifications: IOrchestratorPresenceIssue[] = [];
  await monitor.refresh(
    async () => ({ facts: workspaceFacts, observedAt }),
    async (issue) => { notifications.push(issue); },
  );
  return notifications;
};

describe('orchestrator presence', () => {
  it('reports remaining work with an absent designation', () => {
    const issue = evaluateOrchestratorPresence(facts({
      orchestration: { enabled: true, orchestratorTabId: null },
      tabs: [{ tabId: 'worker', tabName: 'worker', isAgent: true, cliState: 'busy' }],
    }), NOW);

    expect(issue).toMatchObject({ state: 'missing', workState: 'remaining', orchestratorState: 'missing' });
    expect(issue?.evidence).toEqual(expect.arrayContaining(['active epic lease: epic:payments', 'active agent tab: worker']));
    expect(issue?.reason).toContain('Select a local orchestrator');
  });

  it('reports a closed or dead designation without choosing a live worker', () => {
    const issue = evaluateOrchestratorPresence(facts({
      epicLeases: [],
      standupState: 'at-risk',
      tabs: [
        { tabId: 'orch', tabName: 'former owner', isAgent: true, cliState: 'inactive' },
        { tabId: 'worker', tabName: 'worker', isAgent: true, cliState: 'busy' },
      ],
    }), NOW);

    expect(issue).toMatchObject({ state: 'missing', orchestratorState: 'dead', designatedTabId: 'orch' });
    expect(issue?.designatedTabId).not.toBe('worker');
  });

  it('reports disabled orchestration when registered background work remains', () => {
    const issue = evaluateOrchestratorPresence(facts({
      orchestration: { enabled: false, orchestratorTabId: 'orch' },
      epicLeases: [],
      standupState: 'done',
      tabs: [{ tabId: 'worker', tabName: 'worker', isAgent: true, cliState: 'inactive' }],
      liveBackgroundTabIds: ['worker'],
    }), NOW);

    expect(issue).toMatchObject({ state: 'missing', workState: 'remaining', orchestratorState: 'disabled' });
    expect(issue?.evidence).toContain('live registered background work: worker');
  });

  it('keeps unreadable evidence and unknown incumbent liveness uncertain, never green or replaceable', () => {
    const unreadable = evaluateOrchestratorPresence(facts({
      epicLeases: null,
      standupState: undefined,
      tabs: null,
      liveBackgroundTabIds: null,
    }), NOW);
    expect(unreadable).toMatchObject({ state: 'uncertain', workState: 'unknown', orchestratorState: 'unknown' });

    const unknownIncumbent = evaluateOrchestratorPresence(facts({
      tabs: [
        { tabId: 'orch', tabName: 'orchestrator', isAgent: true, cliState: 'unknown' },
        { tabId: 'worker', tabName: 'worker', isAgent: true, cliState: 'busy' },
      ],
    }), NOW);
    expect(unknownIncumbent).toMatchObject({ state: 'uncertain', workState: 'remaining', orchestratorState: 'unknown', designatedTabId: 'orch' });
  });

  it('keeps mixed unreadable evidence uncertain beside known work and a live coordinator', () => {
    const issue = evaluateOrchestratorPresence(facts({
      epicLeases: null,
      standupState: 'on-track',
      tabs: [{ tabId: 'orch', tabName: 'orchestrator', isAgent: true, cliState: 'busy' }],
    }), NOW);

    expect(issue).toMatchObject({ state: 'uncertain', workState: 'remaining', orchestratorState: 'usable' });
    expect(issue?.evidence).toContain('epic leases unreadable');
    expect(issue?.reason).toBe('Work evidence is incomplete. Coverage remains uncertain.');
  });

  it('preserves a live coordinator that is awaiting a human answer or merely idle', () => {
    expect(evaluateOrchestratorPresence(facts({
      standupState: 'awaiting-human',
      tabs: [{ tabId: 'orch', tabName: 'orchestrator', isAgent: true, cliState: 'needs-input' }],
    }), NOW)).toBeNull();
    expect(evaluateOrchestratorPresence(facts({
      tabs: [{ tabId: 'orch', tabName: 'orchestrator', isAgent: true, cliState: 'idle' }],
    }), NOW)).toBeNull();
  });

  it('does not create an issue for a genuinely completed or empty workspace', () => {
    expect(evaluateOrchestratorPresence(facts({
      orchestration: null,
      epicLeases: [],
      standupState: 'done',
      tabs: [],
      liveBackgroundTabIds: [],
    }), NOW)).toBeNull();
    expect(evaluateOrchestratorPresence(facts({
      orchestration: null,
      epicLeases: [],
      standupState: null,
      tabs: [],
      liveBackgroundTabIds: [],
    }), NOW)).toBeNull();
  });

  it('deduplicates across monitor reconstruction and rearms only after confirmed recovery', async () => {
    const store = persistence();
    let monitor = new OrchestratorPresenceMonitor(store);
    const missing = facts({ orchestration: { enabled: true, orchestratorTabId: null } });
    const uncertain = facts({ tabs: null, liveBackgroundTabIds: null });
    const recovered = facts();

    expect(await refresh(monitor, [missing], NOW)).toHaveLength(1);
    monitor = new OrchestratorPresenceMonitor(store);
    expect(await refresh(monitor, [missing], NOW + 1)).toHaveLength(0);
    expect(await refresh(monitor, [uncertain], NOW + 2)).toHaveLength(0);
    expect(await refresh(monitor, [], NOW + 3)).toHaveLength(0);
    expect(await refresh(monitor, [missing], NOW + 4)).toHaveLength(0);
    expect(await refresh(monitor, [recovered], NOW + 5)).toHaveLength(0);
    expect(await refresh(monitor, [missing], NOW + 6)).toHaveLength(1);
  });

  it('rearms on a positively usable owner with amber work evidence but not an unknown owner', async () => {
    const store = persistence();
    const monitor = new OrchestratorPresenceMonitor(store);
    const missing = facts({ orchestration: { enabled: true, orchestratorTabId: null } });
    const usableWithUnknownWork = facts({
      epicLeases: null,
      standupState: undefined,
      tabs: [{ tabId: 'orch', tabName: 'orchestrator', isAgent: true, cliState: 'busy' }],
      liveBackgroundTabIds: null,
      backgroundWorkIncomplete: true,
    });
    const unknownOwner = facts({ tabs: null, liveBackgroundTabIds: null, backgroundWorkIncomplete: true });

    expect(await refresh(monitor, [missing], NOW)).toHaveLength(1);
    expect(await refresh(monitor, [usableWithUnknownWork], NOW + 1)).toHaveLength(0);
    expect(await refresh(monitor, [missing], NOW + 2)).toHaveLength(1);
    expect(await refresh(monitor, [unknownOwner], NOW + 3)).toHaveLength(0);
    expect(await refresh(monitor, [missing], NOW + 4)).toHaveLength(0);
  });

  it('coalesces an overlapping refresh before either collector can apply stale facts', async () => {
    const monitor = new OrchestratorPresenceMonitor(persistence());
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const notifications: IOrchestratorPresenceIssue[] = [];
    const first = monitor.refresh(async () => {
      await blocked;
      return { facts: [facts({ orchestration: { enabled: true, orchestratorTabId: null } })], observedAt: NOW };
    }, async (issue) => { notifications.push(issue); });
    const secondCollector = vi.fn(async () => ({ facts: [facts()], observedAt: NOW + 1 }));
    const second = monitor.refresh(secondCollector, async (issue) => { notifications.push(issue); });

    release();
    await Promise.all([first, second]);

    expect(secondCollector).not.toHaveBeenCalled();
    expect(notifications).toHaveLength(1);
    expect(monitor.snapshot()).toMatchObject({ state: 'ready', checkedAt: NOW });
  });

  it('shares its singleton across server and route module graphs through globalThis', () => {
    expect(getOrchestratorPresenceMonitor()).toBe(getOrchestratorPresenceMonitor());
  });
});
