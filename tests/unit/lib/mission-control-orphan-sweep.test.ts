import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MissionControlStore, WORKSPACE_DELETED_REASON } from '@/lib/mission-control-store';
import { ORPHAN_SWEEP_LIMIT, cancelDeletedWorkspace, runOrphanSweep, type IOrphanSweepDeps } from '@/lib/mission-control-orphan-sweep';
import type { IMissionBinding, TMissionProducerEvent } from '@/types/mission-control';

// Story 57 review r1 findings 2-4: the orphan sweep and the delete cancel, over a real store, with the registry and the
// audit injected. The sweep never acts on a registry it cannot read or that lists no workspace.

const scratchDirs: string[] = [];
const binding: IMissionBinding = { tabId: 'tab-orch', providerId: 'claude', sessionId: 'session-1', generation: 1, runtimeGeneration: 'launch-1' };
const identity = { tabId: binding.tabId, providerId: binding.providerId, sessionId: binding.sessionId, runtimeGeneration: binding.runtimeGeneration };
const reviewAuthority = { resolvedIdentity: identity, configuredOrchestratorTabId: binding.tabId };
const humanReview = { humanNeed: 'decision' as const, humanReason: 'Only the owner picks.', handling: 'Checked.', reviewerTabId: binding.tabId };

const newStore = (): MissionControlStore => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'purplemux-orphan-sweep-'));
  scratchDirs.push(directory);
  return new MissionControlStore(path.join(directory, 'mission.sqlite'));
};

const start = (workspaceId: string): TMissionProducerEvent => ({
  eventId: `${workspaceId}-start`, schemaVersion: 1, workspaceId, runId: `run-${workspaceId}`, expectedRevision: 0, producerAt: 1, bindingGeneration: 0,
  type: 'run.started', payload: { objective: 'Fixture', tabId: binding.tabId },
});

const open = (workspaceId: string, itemId: string): TMissionProducerEvent => ({
  eventId: `${itemId}-open`, schemaVersion: 1, workspaceId, runId: `run-${workspaceId}`, expectedRevision: 0, producerAt: 2, bindingGeneration: 1,
  type: 'attention.opened',
  payload: {
    itemId, kind: 'question', title: 'Pick one', context: 'Fixture.', storyIds: [], options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
    recommendation: 'a', blockingScope: 'none', canContinue: true, humanReview,
  },
});

/** ws-live and ws-gone, each with one item; ws-gone's is a fleet standing-order proposal with an open record. */
const seed = (store: MissionControlStore): void => {
  for (const workspaceId of ['ws-live', 'ws-gone']) {
    const started = start(workspaceId);
    store.applyEvents([started], new Map([[started.eventId, identity]]));
  }
  const live = open('ws-live', 'item-live');
  store.applyEvents([live], new Map([[live.eventId, reviewAuthority]]));
  const proposal = open('ws-gone', 'so-proposal-gone');
  store.applyEvents([proposal], new Map([[proposal.eventId, reviewAuthority]]), {
    soProposals: new Map([[proposal.eventId, { proposerTabId: 'tab-sm', text: 'Always X.', scope: 'fleet', checkName: 'prose', cites: null }]]),
  });
};

const depsFor = (store: MissionControlStore, ids: () => Promise<string[]>) => {
  const audit = vi.fn(async () => true);
  const deps: IOrphanSweepDeps = { store: () => store, workspaceIds: ids, audit, now: () => 1_800_000_000_000 };
  return { deps, audit };
};

afterEach(() => {
  for (const directory of scratchDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('runOrphanSweep', () => {
  it("cancels a gone workspace's items, writes the withdrawn proposal's audit row once, and leaves live items", async () => {
    const store = newStore();
    seed(store);
    const { deps, audit } = depsFor(store, async () => ['ws-live']);

    expect((await runOrphanSweep(deps)).itemIds).toEqual(['so-proposal-gone']);
    expect(store.attentionItem('so-proposal-gone')).toMatchObject({ state: 'cancelled', resolution: WORKSPACE_DELETED_REASON });
    expect(store.soProposal('so-proposal-gone')).toMatchObject({ state: 'withdrawn', reason: WORKSPACE_DELETED_REASON });
    expect(store.attentionItem('item-live')?.state).toBe('open');
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      event: 'so-proposal-withdrawn', itemId: 'so-proposal-gone', workspaceId: 'ws-gone', tabId: 'tab-sm', reason: WORKSPACE_DELETED_REASON, answerId: null,
    }));

    // A second pass finds nothing and audits nothing.
    expect((await runOrphanSweep(deps)).itemIds).toEqual([]);
    expect(audit).toHaveBeenCalledTimes(1);
    store.close();
  });

  it('cancels nothing when the registry lists no workspace, and throws when the registry cannot be read', async () => {
    const store = newStore();
    seed(store);
    expect((await runOrphanSweep(depsFor(store, async () => []).deps)).itemIds).toEqual([]);
    await expect(runOrphanSweep(depsFor(store, async () => { throw new Error('workspaces.json is not valid JSON'); }).deps))
      .rejects.toThrow(/not valid JSON/);
    expect(store.attentionItem('so-proposal-gone')?.state).toBe('open');
    store.close();
  });

  it('cancels at most ORPHAN_SWEEP_LIMIT items per pass', async () => {
    const cancelOrphanedItems = vi.fn(() => ({ itemIds: [], withdrawnProposals: [] }));
    const deps: IOrphanSweepDeps = {
      store: () => ({ cancelOrphanedItems, cancelWorkspaceItems: vi.fn() }), workspaceIds: async () => ['ws-live'], audit: vi.fn(), now: () => 5,
    };
    await runOrphanSweep(deps);
    expect(cancelOrphanedItems).toHaveBeenCalledWith(['ws-live'], ORPHAN_SWEEP_LIMIT, 5);
  });
});

describe('cancelDeletedWorkspace', () => {
  it("cancels the deleted workspace's items and audits its withdrawn proposal", async () => {
    const store = newStore();
    seed(store);
    const { deps, audit } = depsFor(store, async () => ['ws-live']);
    expect(await cancelDeletedWorkspace('ws-gone', deps)).toMatchObject({ itemIds: ['so-proposal-gone'] });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ event: 'so-proposal-withdrawn', itemId: 'so-proposal-gone' }));
    expect(store.attentionItem('item-live')?.state).toBe('open');
    store.close();
  });
});
