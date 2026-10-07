import { describe, expect, it } from 'vitest';
import { runPortfolioPass } from '@/lib/portfolio-runtime';
import { PortfolioStore } from '@/lib/portfolio-store';
import type { IPortfolioReport } from '@/types/portfolio';
import type { IWatch } from '@/types/watch';

const base: IPortfolioReport = {
  eventId: 'event-a', schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-a', bindingGeneration: 1, sourceKey: 'source-a',
  revision: 0, producerAt: 1, resourceKey: 'lease:merge:owner/repo', kind: 'lease', watchId: 'w-a', watchHead: null,
  outcome: 'Release A', priority: 90, stage: 'implemented', owner: 'tab-a', cause: 'Lease held',
  evidence: 'orchestrator report', nextAction: 'Wait for release', decisionOwner: 'tab-a', checkpointAt: 2,
  capacity: { host: 'host-a', measuredReason: 'lease held', limit: '1', use: '1', holder: 'tab-holder', clearingCondition: 'lease free' },
};

describe('portfolio durable notifications', () => {
  it('routes one checkpoint and one cross-workspace proof wake through notes after a restart pass', async () => {
    const store = new PortfolioStore(':memory:');
    try {
      store.report(base);
      store.report({ ...base, eventId: 'event-b', workspaceId: 'ws-b', runId: 'run-b', sourceKey: 'source-b',
        checkpointAt: null });
      const sent: string[] = [];
      const deps = {
        store, now: () => Date.now() + 10,
        coordinatorOf: async (workspaceId: string) => workspaceId === 'ws-a' ? 'tab-a' : 'tab-b',
        send: async (_workspaceId: string, input: { externalKey: string }) => { sent.push(input.externalKey); },
      };
      await runPortfolioPass(deps);
      expect(sent).toEqual([expect.stringMatching(/^portfolio:checkpoint:/)]);
      expect(store.dueCheckpoints(Date.now() + 10)).toHaveLength(0);
      store.clearByWatch({ id: 'w-a', workspaceId: 'ws-a', tabId: 'tab-a', kind: 'lease',
        target: 'merge:owner/repo' } as IWatch, { notice: 'free' });
      expect(store.pendingWakes()).toHaveLength(2);
      await runPortfolioPass(deps);
      expect(sent).toHaveLength(2);
      expect(sent[1]).toMatch(/^portfolio:resolved:/);
      expect(store.pendingWakes()).toHaveLength(0);
      await runPortfolioPass(deps);
      expect(sent).toHaveLength(2);
    } finally { store.close(); }
  });

  it('reuses an identical checkpoint note after a report races the send and marks the escalation on retry', async () => {
    const store = new PortfolioStore(':memory:');
    try {
      const first = store.report(base).impact;
      const notes = new Map<string, { subject: string; body: string }>();
      const sent: string[] = [];
      const deps = {
        store, now: () => Date.now() + 10,
        coordinatorOf: async () => 'tab-a',
        send: async (_workspaceId: string, input: { externalKey: string; subject: string; body: string }) => {
          const existing = notes.get(input.externalKey);
          if (existing && (existing.subject !== input.subject || existing.body !== input.body)) {
            throw new Error('note key reused with different content');
          }
          notes.set(input.externalKey, { subject: input.subject, body: input.body });
          sent.push(input.externalKey);
          if (sent.length === 1) store.report({ ...base, eventId: 'race-report', revision: 1,
            watchId: 'w-new', nextAction: 'Ask for a new lease', outcome: 'Renamed release' });
        },
      };
      await runPortfolioPass(deps);
      expect(store.impact(first.id)?.escalatedAt).toBeNull();
      await runPortfolioPass(deps);
      expect(sent).toHaveLength(2);
      expect(sent[1]).toBe(sent[0]);
      expect(notes).toHaveProperty('size', 1);
      expect(store.dueCheckpoints(Date.now() + 10)).toEqual([]);
    } finally { store.close(); }
  });

  it('sends one durable claim to another capacity owner without resolving that owner', async () => {
    const store = new PortfolioStore(':memory:');
    try {
      const own = store.report({ ...base, kind: 'worker-limit', watchId: null,
        resourceKey: 'worker-limit:host-a', capacity: { ...base.capacity!, clearingCondition: 'one free slot' } }).impact;
      const other = store.report({ ...base, eventId: 'other', workspaceId: 'ws-b', runId: 'run-b',
        sourceKey: 'other-source', kind: 'worker-limit', watchId: null, checkpointAt: null,
        resourceKey: 'worker-limit:host-a', capacity: { ...base.capacity!, clearingCondition: 'one free slot' } }).impact;
      store.resolveCapacity({ schemaVersion: 1, type: 'resolved', eventId: 'proof-a', workspaceId: 'ws-a',
        runId: 'run-a', bindingGeneration: 1, impactId: own.id, expectedRevision: 0, observedAt: 2,
        evidence: { host: 'host-a', measuredReason: 'one slot freed', limit: '4', use: '3', holder: null,
          clearingCondition: 'one free slot', reference: 'measurement-1' } });
      const sent: Array<{ workspaceId: string; subject: string; body: string; externalKey: string }> = [];
      const deps = { store, now: () => 1,
        coordinatorOf: async () => 'tab-b',
        send: async (workspaceId: string, input: { subject: string; body: string; externalKey: string }) => {
          sent.push({ workspaceId, ...input });
        } };
      await runPortfolioPass(deps);
      expect(sent).toMatchObject([{ workspaceId: 'ws-b', subject: expect.stringContaining('claim'),
        body: expect.stringContaining('remains blocked') }]);
      expect(store.impact(other.id)?.state).toBe('received');
      expect(store.milestones()).toEqual([]);
      await runPortfolioPass(deps);
      expect(sent).toHaveLength(1);
    } finally { store.close(); }
  });
});
