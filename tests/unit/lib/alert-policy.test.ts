import { describe, expect, it } from 'vitest';
import { alertFor, isStallEpisodeEnd, shouldAlert, standupAlertTabId } from '@/lib/alert-policy';
import type { IWorkspace } from '@/types/terminal';
import type { IWorkspaceStandup } from '@/types/status';

const ORCH_TAB = 'T1';
const WORKER_TAB = 'T2';
const AT = 1_700_000_000_000;

const workspace = (orchestration?: IWorkspace['orchestration']): IWorkspace => ({
  id: 'ws-1',
  name: 'Epic',
  directories: ['/tmp/epic'],
  orchestration,
});

const orchestrated = workspace({ enabled: true, orchestratorTabId: ORCH_TAB });
const plain = workspace(undefined);
const disabledOrch = workspace({ enabled: false, orchestratorTabId: ORCH_TAB });

describe('shouldAlert', () => {
  describe('orchestrator-only (default, alertsOrchestratorOnly === true)', () => {
    it('alerts for the orchestrator tab of an orchestrated workspace', () => {
      expect(shouldAlert({ id: ORCH_TAB }, orchestrated, { alertsOrchestratorOnly: true })).toBe(true);
    });

    it('stays silent for worker tabs of an orchestrated workspace', () => {
      expect(shouldAlert({ id: WORKER_TAB }, orchestrated, { alertsOrchestratorOnly: true })).toBe(false);
    });

    it('stays silent for every tab of a workspace without orchestration', () => {
      expect(shouldAlert({ id: ORCH_TAB }, plain, { alertsOrchestratorOnly: true })).toBe(false);
      expect(shouldAlert({ id: WORKER_TAB }, plain, { alertsOrchestratorOnly: true })).toBe(false);
    });

    it('treats orchestration.enabled === false as no orchestrator', () => {
      expect(shouldAlert({ id: ORCH_TAB }, disabledOrch, { alertsOrchestratorOnly: true })).toBe(false);
    });

    it('is the default when the config key is absent', () => {
      expect(shouldAlert({ id: WORKER_TAB }, orchestrated, {})).toBe(false);
      expect(shouldAlert({ id: ORCH_TAB }, orchestrated, undefined)).toBe(true);
      expect(shouldAlert({ id: WORKER_TAB }, plain, null)).toBe(false);
    });
  });

  // The pre-dispatcher rule: every agent tab alerted, and workers were muted
  // only when the workspace had an orchestrator to handle them.
  describe('legacy rule (alertsOrchestratorOnly === false)', () => {
    it('alerts for every tab of a workspace without orchestration', () => {
      expect(shouldAlert({ id: ORCH_TAB }, plain, { alertsOrchestratorOnly: false })).toBe(true);
      expect(shouldAlert({ id: WORKER_TAB }, plain, { alertsOrchestratorOnly: false })).toBe(true);
      expect(shouldAlert({ id: WORKER_TAB }, undefined, { alertsOrchestratorOnly: false })).toBe(true);
    });

    it('alerts for the orchestrator and mutes workers when an orchestrator exists', () => {
      expect(shouldAlert({ id: ORCH_TAB }, orchestrated, { alertsOrchestratorOnly: false })).toBe(true);
      expect(shouldAlert({ id: WORKER_TAB }, orchestrated, { alertsOrchestratorOnly: false })).toBe(false);
    });

    it('alerts for every tab when orchestration is configured but disabled', () => {
      expect(shouldAlert({ id: WORKER_TAB }, disabledOrch, { alertsOrchestratorOnly: false })).toBe(true);
    });

    it('alerts for every tab when orchestration is enabled with no orchestrator tab', () => {
      const noTab = workspace({ enabled: true, orchestratorTabId: null });
      expect(shouldAlert({ id: WORKER_TAB }, noTab, { alertsOrchestratorOnly: false })).toBe(true);
      expect(shouldAlert({ id: WORKER_TAB }, noTab, { alertsOrchestratorOnly: true })).toBe(false);
    });
  });
});

describe('alertFor', () => {
  const base = {
    tabId: ORCH_TAB,
    workspaceId: 'ws-1',
    workspaceName: 'Epic',
    tabName: 'orchestrator',
    providerId: 'claude' as const,
    isOrchestrator: true,
    at: AT,
  };

  it('builds a needs-input alert with the existing push title and body', () => {
    expect(alertFor({ ...base, kind: 'needs-input', lastUserMessage: 'run the migration' })).toEqual({
      ...base,
      kind: 'needs-input',
      title: 'Input Required',
      body: 'run the migration',
    });
  });

  it('builds a review alert with the existing push title', () => {
    const alert = alertFor({ ...base, kind: 'review', lastUserMessage: null });
    expect(alert.title).toBe('Task Complete');
    expect(alert.body).toBe('orchestrator');
  });

  it('clamps the body to the first 100 characters of the last user message', () => {
    const alert = alertFor({ ...base, kind: 'review', lastUserMessage: 'x'.repeat(200) });
    expect(alert.body).toHaveLength(100);
  });

  it('falls back to the tab id when there is no message and no tab name', () => {
    expect(alertFor({ ...base, kind: 'review', tabName: '' }).body).toBe(ORCH_TAB);
  });

  it('uses the standup headline as the body of a standup-needs-human alert', () => {
    const alert = alertFor({ ...base, kind: 'standup-needs-human', headline: 'blocked on a schema decision' });
    expect(alert.kind).toBe('standup-needs-human');
    expect(alert.body).toBe('blocked on a schema decision');
  });

  it('describes a stall with the supplied detail', () => {
    const alert = alertFor({ ...base, kind: 'orchestrator-stalled', detail: 'idle 30 min, no workers' });
    expect(alert.title).toBe('Orchestrator Stalled');
    expect(alert.body).toBe('idle 30 min, no workers');
  });

  it('describes a stall without a detail', () => {
    expect(alertFor({ ...base, kind: 'orchestrator-stalled' }).body.length).toBeGreaterThan(0);
  });
});

describe('standupAlertTabId', () => {
  const standup = (overrides: Partial<IWorkspaceStandup> = {}): Pick<IWorkspaceStandup, 'needsHuman' | 'state'> => ({
    needsHuman: false,
    state: 'on-track',
    ...overrides,
  });

  it('addresses the orchestrator tab when the tick needs a human', () => {
    expect(standupAlertTabId(standup({ needsHuman: true }), orchestrated, {})).toBe(ORCH_TAB);
  });

  it('stays silent when the tick needs nobody', () => {
    expect(standupAlertTabId(standup(), orchestrated, {})).toBeNull();
  });

  it('treats blocked and awaiting-human as needing a human', () => {
    expect(standupAlertTabId(standup({ state: 'blocked' }), orchestrated, {})).toBe(ORCH_TAB);
    expect(standupAlertTabId(standup({ state: 'awaiting-human' }), orchestrated, {})).toBe(ORCH_TAB);
    expect(standupAlertTabId(standup({ state: 'done' }), orchestrated, {})).toBeNull();
  });

  it('has nothing to address in a workspace without an orchestrator', () => {
    expect(standupAlertTabId(standup({ needsHuman: true }), plain, {})).toBeNull();
    expect(standupAlertTabId(standup({ needsHuman: true }), disabledOrch, {})).toBeNull();
  });

  it('still addresses the orchestrator with the orchestrator-only flag off', () => {
    expect(standupAlertTabId(standup({ needsHuman: true }), orchestrated, { alertsOrchestratorOnly: false })).toBe(ORCH_TAB);
  });
});

describe('isStallEpisodeEnd', () => {
  it('fires once on the last heartbeat of an episode', () => {
    const MAX = 3;
    let alerted = false;
    const fired: number[] = [];
    // One idle episode: three heartbeats, then the keeper stops beating.
    for (const beats of [1, 2, 3]) {
      if (isStallEpisodeEnd(beats, MAX, alerted)) {
        fired.push(beats);
        alerted = true;
      }
    }
    expect(fired).toEqual([3]);
  });

  it('does not fire again while the same episode is still exhausted', () => {
    expect(isStallEpisodeEnd(4, 3, true)).toBe(false);
  });

  it('fires again for a fresh episode once the keeper resets the flag', () => {
    expect(isStallEpisodeEnd(3, 3, false)).toBe(true);
  });

  it('stays quiet before the heartbeat budget is spent', () => {
    expect(isStallEpisodeEnd(1, 3, false)).toBe(false);
    expect(isStallEpisodeEnd(2, 3, false)).toBe(false);
  });
});
