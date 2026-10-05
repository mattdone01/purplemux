import { describe, expect, it } from 'vitest';
import {
  evaluateOrchestratorPresence,
  getOrchestratorPresenceMonitor,
  OrchestratorPresenceMonitor,
} from '@/lib/orchestrator-presence';
import type { IOrchestratorPresenceFacts } from '@/types/coordination';

const NOW = 1_800_000_000_000;

const facts = (overrides: Partial<IOrchestratorPresenceFacts> = {}): IOrchestratorPresenceFacts => ({
  workspaceId: 'ws-1',
  workspaceName: 'Payments',
  orchestration: { enabled: true, orchestratorTabId: 'orch' },
  epicLeases: ['epic:payments'],
  standupState: 'on-track',
  tabs: [{ tabId: 'orch', tabName: 'orchestrator', isAgent: true, cliState: 'busy' }],
  liveBackgroundTabIds: [],
  ...overrides,
});

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

  it('deduplicates one missing-owner episode and rearms only after confirmed recovery', () => {
    const monitor = new OrchestratorPresenceMonitor();
    const missing = facts({ orchestration: { enabled: true, orchestratorTabId: null } });
    const uncertain = facts({ tabs: null, liveBackgroundTabIds: null });
    const recovered = facts();

    expect(monitor.reconcile([missing], NOW)).toHaveLength(1);
    expect(monitor.reconcile([missing], NOW + 1)).toHaveLength(0);
    expect(monitor.reconcile([uncertain], NOW + 2)).toHaveLength(0);
    expect(monitor.reconcile([missing], NOW + 3)).toHaveLength(0);
    expect(monitor.reconcile([recovered], NOW + 4)).toHaveLength(0);
    expect(monitor.reconcile([missing], NOW + 5)).toHaveLength(1);
  });

  it('shares its singleton across server and route module graphs through globalThis', () => {
    expect(getOrchestratorPresenceMonitor()).toBe(getOrchestratorPresenceMonitor());
  });
});
