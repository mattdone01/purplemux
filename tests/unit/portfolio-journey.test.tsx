import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PortfolioBoardContent } from '@/components/features/mission-control/portfolio-board';
import { NotesService, type INotesDeps } from '@/lib/notes-service';
import { PortfolioStore } from '@/lib/portfolio-store';
import type { ICaller } from '@/lib/caller';
import type { INotesState } from '@/types/note';
import type { IPortfolioReport } from '@/types/portfolio';
import type { IWatch } from '@/types/watch';

const caller = (workspaceId: string, tabId: string): ICaller => ({
  scope: { type: 'workspace', workspaceId, tabId, tabVerified: true, tabIdentity: 'launch' },
  workspaceId, tabId, tabName: null, verified: true, identity: 'launch', admin: false,
});

describe('synthetic local portfolio journey', () => {
  it.each(['queued', 'held'] as const)('blocks a %s persisted action after a newer report, even after restart', async (itemState) => {
    const store = new PortfolioStore(':memory:');
    let state: INotesState = { notes: [] };
    const inbox = { id: 'i-orphan', state: itemState, deliveredAt: null, lastRefusal: null, heldReason: null };
    const deps = {
      now: () => Date.now(), newId: () => 'n-orphan',
      mutate: async (fn: (current: INotesState) => Promise<{ state: INotesState; value: unknown }>) => {
        const result = await fn(state); state = result.state; return result.value;
      },
      read: async () => state, epicHolder: async () => null, holdsEpic: async () => false,
      orchestratorOf: async () => 'tab-a',
      withMappingRead: async (_workspaceId: string, work: () => Promise<unknown>) => work(),
      workspaceExists: async () => true,
      liveTabs: async () => ({ tabs: [{ workspaceId: 'ws-a', tabId: 'tab-a' }],
        uncertainWorkspaceIds: new Set<string>() }),
      enqueue: async () => ({ item: inbox }), withdraw: async () => true,
      inboxItems: async () => [inbox],
      portfolioActionDeliverable: async (actionId: string, noteId: string, workspaceId: string) =>
        store.actionNoteDeliverable(actionId, noteId, workspaceId),
    } as unknown as INotesDeps;
    try {
      const report: IPortfolioReport = { eventId: 'first', schemaVersion: 1, workspaceId: 'ws-a',
        runId: 'run-a', bindingGeneration: 1, sourceKey: 'capacity-a', revision: 0, producerAt: 1,
        resourceKey: 'worker-limit:host-a', kind: 'worker-limit', watchId: null, watchHead: null,
        outcome: 'Release A', priority: 100, stage: 'implemented', owner: 'tab-a', cause: 'No slot',
        evidence: 'Worker limit 4/4', nextAction: 'Wait for slot', decisionOwner: 'tab-a', checkpointAt: null,
        capacity: { host: 'host-a', measuredReason: '4 of 4', limit: '4', use: '4', holder: null,
          clearingCondition: 'one free slot' } };
      const impact = store.report(report).impact;
      store.reserveAction('orphan-action', impact.id, 0, 'Use current slot', 'human');
      const note = await new NotesService(deps).sendHumanPortfolio('human', 'ws-a', {
        toWorkspace: 'ws-a', subject: 'Portfolio action', body: 'Use current slot',
        externalKey: 'portfolio:action:orphan-action',
      });
      expect(store.actionNoteDeliverable('orphan-action', note.id, 'ws-a')).toBe(true);
      store.report({ ...report, eventId: 'newer', revision: 1, nextAction: 'Wait for next slot' });
      expect(store.reserveAction('orphan-action', impact.id, 0, 'Use current slot', 'human').state).toBe('superseded');
      const restarted = new NotesService(deps);
      const result = await restarted.preflight({ ...inbox, dedupeKey: `note:${note.id}:delivered:tab-a`,
        targetWorkspaceId: 'ws-a', targetTabId: 'tab-a' } as never);
      expect(result).toEqual({ ok: false, reason: 'note-policyblocked:portfolio-action-superseded' });
      expect(state.notes[0]).toMatchObject({ routingStatus: 'policyblocked',
        routingReason: 'portfolio-action-superseded' });
      expect(store.impact(impact.id)?.state).toBe('received');
    } finally { store.close(); }
  });

  it.each(['watch', 'capacity'] as const)('retains actual delivery and authorized ACK after %s clearance', async (proofKind) => {
    const store = new PortfolioStore(':memory:');
    let state: INotesState = { notes: [] };
    let coordinator = 'tab-a';
    let enqueueCount = 0;
    const inbox = { id: 'i-delivered', state: 'queued', deliveredAt: null as number | null,
      lastRefusal: null, heldReason: null };
    const deps = {
      now: () => 2_000, newId: () => 'n-delivered',
      mutate: async (fn: (current: INotesState) => Promise<{ state: INotesState; value: unknown }>) => {
        const result = await fn(state); state = result.state; return result.value;
      },
      read: async () => state, epicHolder: async () => null, holdsEpic: async () => false,
      orchestratorOf: async () => coordinator,
      withMappingRead: async (_workspaceId: string, work: () => Promise<unknown>) => work(),
      workspaceExists: async () => true,
      liveTabs: async () => ({ tabs: [{ workspaceId: 'ws-a', tabId: 'tab-a' },
        { workspaceId: 'ws-a', tabId: 'tab-b' }], uncertainWorkspaceIds: new Set<string>() }),
      enqueue: async () => { enqueueCount += 1; return { item: inbox }; },
      withdraw: async () => true,
      inboxItems: async () => [inbox],
      portfolioActionDeliverable: async (actionId: string, noteId: string, workspaceId: string) =>
        store.actionNoteDeliverable(actionId, noteId, workspaceId),
    } as unknown as INotesDeps;
    const report: IPortfolioReport = { eventId: 'blocked', schemaVersion: 1, workspaceId: 'ws-a',
      runId: 'run-a', bindingGeneration: 1, sourceKey: 'shared-resource', revision: 0, producerAt: 1,
      resourceKey: proofKind === 'watch' ? 'lease:merge:owner/repo' : 'worker-limit:host-a',
      kind: proofKind === 'watch' ? 'lease' : 'worker-limit',
      watchId: proofKind === 'watch' ? 'w-delivered' : null, watchHead: null,
      outcome: 'Release A', priority: 100, stage: 'implemented', owner: 'tab-a', cause: 'Resource held',
      evidence: 'Coordinator report', nextAction: 'Wait for capacity', decisionOwner: 'tab-a', checkpointAt: null,
      capacity: { host: 'host-a', measuredReason: 'all slots held', limit: '4', use: '4', holder: null,
        clearingCondition: 'one free slot' } };
    try {
      const impact = store.report(report).impact;
      store.reserveAction('delivered-action', impact.id, 0, 'Wait for proof', 'human');
      const note = await new NotesService(deps).sendHumanPortfolio('human', 'ws-a', {
        subject: 'Portfolio action', body: 'Wait for proof', externalKey: 'portfolio:action:delivered-action',
      });
      store.completeAction('delivered-action', note.id);
      const pending = { ...inbox, dedupeKey: `note:${note.id}:delivered:tab-a`,
        targetWorkspaceId: 'ws-a', targetTabId: 'tab-a' };
      const preflight = await new NotesService(deps).preflight(pending as never);
      expect(preflight.ok).toBe(true);
      if (preflight.ok) preflight.settle();
      inbox.state = 'delivered'; inbox.deliveredAt = 2_001;
      if (proofKind === 'watch') {
        store.clearByWatch({ id: 'w-delivered', workspaceId: 'ws-a', tabId: 'tab-a', kind: 'lease',
          target: 'merge:owner/repo' } as IWatch, { notice: 'free' });
      } else {
        store.resolveCapacity({ schemaVersion: 1, type: 'resolved', eventId: 'capacity-cleared',
          workspaceId: 'ws-a', runId: 'run-a', bindingGeneration: 1, impactId: impact.id,
          expectedRevision: 0, observedAt: 2, evidence: { host: 'host-a', measuredReason: 'slot freed',
            limit: '4', use: '3', holder: null, clearingCondition: 'one free slot', reference: 'sample-2' } });
      }
      expect(store.actionNoteDeliverable('delivered-action', note.id, 'ws-a')).toBe(false);
      coordinator = 'tab-b';
      const restarted = new NotesService(deps);
      await restarted.tick();
      expect(state.notes[0]).toMatchObject({ state: 'delivered', deliveredAt: 2_001,
        deliveredTo: { workspaceId: 'ws-a', tabId: 'tab-a' }, routingStatus: 'routed' });
      expect(enqueueCount).toBe(1);
      state = { notes: [{ ...state.notes[0], reminderItemId: 'i-stale-reminder' }] };
      await expect(restarted.preflight({ ...pending, id: 'i-stale-reminder',
        dedupeKey: `note:${note.id}:reminder:tab-a` } as never)).resolves.toEqual({
        ok: false, reason: 'note-policyblocked:portfolio-action-superseded',
      });
      expect(state.notes[0]).toMatchObject({ state: 'delivered', deliveredAt: 2_001 });
      await expect(restarted.ack(caller('ws-b', 'tab-a'), note.id, 'Received')).rejects.toThrow('recipient workspace');
      await expect(restarted.ack({ ...caller('ws-a', 'tab-a'), verified: false }, note.id, 'Received'))
        .rejects.toThrow('currently routed coordinator');
      await expect(restarted.ack(caller('ws-a', 'tab-a'), note.id, 'Received'))
        .rejects.toThrow('currently routed coordinator');
      await expect(restarted.ack(caller('ws-a', 'tab-b'), note.id, 'Received'))
        .rejects.toThrow('currently routed coordinator');
      coordinator = 'tab-a';
      const acked = await restarted.ack(caller('ws-a', 'tab-a'), note.id, 'Received');
      expect(acked).toMatchObject({ state: 'acked', deliveredAt: 2_001,
        ackedBy: { workspaceId: 'ws-a', tabId: 'tab-a' } });
      expect(store.impact(impact.id)?.state).toBe('resolved');
      expect(store.actions()[0]).toMatchObject({ state: 'sent', noteId: note.id });
      expect(() => store.markApplied(impact.id, note.id, 'apply-after-proof', 0)).toThrow('stale blocker');
    } finally { store.close(); }
  });

  it('reports, routes a decision, records receipt and application, proves dependency clearance, and renders the update', async () => {
    const store = new PortfolioStore(':memory:');
    let state: INotesState = { notes: [] };
    let delivered = false;
    const inbox = { id: 'i-synthetic', state: 'queued', deliveredAt: null as number | null,
      lastRefusal: null, heldReason: null };
    const deps = {
      now: () => 1_000,
      newId: () => 'n-synthetic',
      mutate: async (fn: (current: INotesState) => Promise<{ state: INotesState; value: unknown }>) => {
        const result = await fn(state); state = result.state; return result.value;
      },
      read: async () => state,
      epicHolder: async () => null,
      holdsEpic: async () => false,
      orchestratorOf: async (workspaceId: string) => workspaceId === 'ws-root' ? 'tab-root' : 'tab-a',
      withMappingRead: async (_workspaceId: string, work: () => Promise<unknown>) => work(),
      workspaceExists: async () => true,
      liveTabs: async () => ({ tabs: [{ workspaceId: 'ws-root', tabId: 'tab-root' }, { workspaceId: 'ws-a', tabId: 'tab-a' }], uncertainWorkspaceIds: new Set<string>() }),
      enqueue: async () => ({ item: inbox }),
      withdraw: async () => true,
      inboxItems: async () => [{ ...inbox, state: delivered ? 'delivered' : 'queued', deliveredAt: delivered ? 1_100 : null }],
      portfolioActionDeliverable: async (actionId: string, noteId: string, workspaceId: string) =>
        store.actionNoteDeliverable(actionId, noteId, workspaceId),
    } as unknown as INotesDeps;
    const notes = new NotesService(deps);
    const report: IPortfolioReport = {
      eventId: 'event-a', schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-a', bindingGeneration: 1,
      sourceKey: 'lease-a', revision: 0, producerAt: 1_000, resourceKey: 'lease:merge:owner/repo',
      kind: 'lease', watchId: 'w-a', watchHead: null, outcome: 'Release A', priority: 100,
      stage: 'implemented', owner: 'tab-a', cause: 'Merge lease held', evidence: 'Orchestrator report',
      nextAction: 'Wait for release', decisionOwner: 'tab-root', checkpointAt: 1_200,
      capacity: { host: 'host-a', measuredReason: 'lease held', limit: '1', use: '1', holder: 'tab-holder', clearingCondition: 'lease free' },
    };
    try {
      const impact = store.report(report).impact;
      store.reserveAction('action-a', impact.id, 0, 'Ask holder to release', 'human');
      const note = await notes.sendHumanPortfolio('human', 'ws-a', {
        toWorkspace: 'ws-a', subject: 'Portfolio action', body: 'Ask holder to release', externalKey: 'portfolio:action:action-a',
      });
      const replay = await notes.sendHumanPortfolio('human', 'ws-a', {
        toWorkspace: 'ws-a', subject: 'Portfolio action', body: 'Ask holder to release', externalKey: 'portfolio:action:action-a',
      });
      expect(replay.id).toBe(note.id);
      expect(note.from).toMatchObject({ humanActor: 'human', verified: false, workspaceId: null, tabId: null });
      expect(state.notes).toHaveLength(1);
      store.completeAction('action-a', note.id);
      expect(store.impact(impact.id)?.state).toBe('action-assigned');
      expect(note.receipt?.routingStatus).toBe('routed');
      delivered = true;
      const acked = await notes.ack(caller('ws-a', 'tab-a'), note.id, 'Read and applying');
      expect(acked.state).toBe('acked');
      expect(store.impact(impact.id)?.state).toBe('action-assigned');
      store.markApplied(impact.id, note.id, 'apply-a', 0);
      expect(store.impact(impact.id)?.state).toBe('waiting');
      const watch = { id: 'w-a', workspaceId: 'ws-a', tabId: 'tab-a', kind: 'lease', target: 'merge:owner/repo' } as IWatch;
      expect(store.clearByWatch(watch, { notice: 'free' })).toHaveLength(1);
      const updated = store.impact(impact.id)!;
      expect(updated.state).toBe('resolved');
      expect(updated.stage).toBe('implemented');
      const html = renderToStaticMarkup(<PortfolioBoardContent snapshot={{ selection: {
        managerWorkspaceId: 'ws-root', managerTabId: 'tab-root', workspaceIds: ['ws-a'] },
      coverage: [{ workspaceId: 'ws-a', name: 'A', access: 'available' }],
      dependencies: [{ resourceKey: updated.resourceKey, kind: updated.kind, firstBlockedAt: updated.firstBlockedAt,
        impacts: [{ ...updated, noteState: acked.state, noteDeliveredAt: 1_100 }] }],
      actions: store.actions(), milestones: [], generatedAt: Date.now() }}
      priorityFilter="all" onPriorityFilter={() => {}} showResolved onShowResolved={() => {}} decisions={{}} onDecision={() => {}}
      pendingId={null} onAcknowledge={() => {}} onAssign={() => {}} />);
      expect(html).toContain('Dependency proof: free');
      expect(html).toContain('Decision note');
      expect(html).toContain('application reported');
      expect(html).toContain('Last human-confirmed milestone: none');
    } finally { store.close(); }
  });
});
