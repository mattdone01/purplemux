import { afterEach, describe, expect, it } from 'vitest';
import { PortfolioStore } from '@/lib/portfolio-store';
import { parsePortfolioReport, parsePortfolioResolution } from '@/lib/portfolio-validation';
import type { IPortfolioReport } from '@/types/portfolio';
import type { IWatch } from '@/types/watch';

const now = Date.now();
const report = (overrides: Partial<IPortfolioReport> = {}): IPortfolioReport => ({
  eventId: 'event-a', schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-a', bindingGeneration: 1,
  sourceKey: 'resource-a', revision: 0, producerAt: now, resourceKey: 'lease:merge:owner/repo',
  kind: 'lease', watchId: 'w-shared', watchHead: null,
  outcome: 'Ship release A', priority: 90, stage: 'implemented', owner: 'orchestrator A',
  cause: 'Merge lease held', evidence: 'Reported by orchestrator', nextAction: 'Wait for lease release',
  decisionOwner: 'orchestrator A', checkpointAt: now + 60_000,
  capacity: { host: 'host-a', measuredReason: 'lease is held', limit: '1', use: '1', holder: 'tab-holder', clearingCondition: 'lease free' },
  ...overrides,
});

const watch = (overrides: Partial<IWatch> = {}): IWatch => ({
  id: 'w-shared', workspaceId: 'ws-a', tabId: 'tab-a', kind: 'lease', target: 'merge:owner/repo',
  until: 'free', baseline: null, intervalS: 15, createdAt: now, expiresAt: now + 60_000,
  lastCheckedAt: null, failures: 0, failingNotified: false, lastError: null, label: null,
  verified: true, ...overrides,
});

describe('portfolio dependency ledger', () => {
  const stores: PortfolioStore[] = [];
  const newStore = () => {
    const store = new PortfolioStore(':memory:');
    stores.push(store);
    return store;
  };
  afterEach(() => { for (const store of stores.splice(0)) store.close(); });

  it('groups two impacted releases by resource while retaining each report and first blocked time', () => {
    const store = newStore();
    const a = store.report(report()).impact;
    const b = store.report(report({ eventId: 'event-b', workspaceId: 'ws-b', runId: 'run-b', sourceKey: 'other' })).impact;
    expect(a.id).not.toBe(b.id);
    expect(new Set(store.impacts().map((impact) => impact.resourceKey))).toEqual(new Set(['lease:merge:owner/repo']));
    expect(store.report(report()).replayed).toBe(true);
    expect(store.impact(a.id)?.firstBlockedAt).toBe(a.firstBlockedAt);
    expect(store.impact(a.id)?.state).toBe('received');
  });

  it('acknowledgement never resolves; a matching watch clears only its linked dependency', () => {
    const store = newStore();
    const a = store.report(report()).impact;
    const unrelated = store.report(report({ eventId: 'event-c', sourceKey: 'ci', resourceKey: 'pr:owner/repo#1',
      kind: 'ci', watchId: 'w-ci', watchHead: 'a'.repeat(40), capacity: null })).impact;
    store.acknowledge(a.id, 0);
    expect(store.impact(a.id)?.state).toBe('acknowledged');
    expect(store.clearByWatch(watch(), { notice: 'free' }).map((impact) => impact.id)).toEqual([a.id]);
    expect(store.impact(a.id)?.proof).toContain('"source":"watch"');
    expect(store.impact(unrelated.id)?.state).toBe('received');
    expect(store.impact(unrelated.id)?.stage).toBe('implemented');
  });

  it('rejects stale reports and a reused watch on a newer blocker revision', () => {
    const store = newStore();
    const a = store.report(report()).impact;
    expect(() => store.report(report({ eventId: 'event-a', cause: 'changed' }))).toThrow('reused');
    expect(() => store.report(report({ eventId: 'event-stale', revision: 0 }))).toThrow('does not follow');
    expect(() => store.report(report({ eventId: 'event-new', revision: 1 }))).toThrow('new watch');
    store.report(report({ eventId: 'event-new', revision: 1, watchId: 'w-new' }));
    expect(store.clearByWatch(watch(), { notice: 'free' })).toEqual([]);
    expect(store.impact(a.id)?.state).toBe('received');
    expect(store.impact(a.id)?.firstBlockedAt).toBe(a.firstBlockedAt);
  });

  it('requires green checks for the exact linked head', () => {
    const store = newStore();
    const a = store.report(report({ resourceKey: 'pr:owner/repo#1', kind: 'ci', watchId: 'w-ci',
      watchHead: 'a'.repeat(40), capacity: null })).impact;
    const ci = watch({ id: 'w-ci', kind: 'pr', target: 'owner/repo#1', until: 'checks-settled', baseline: 'a'.repeat(40) });
    expect(store.clearByWatch(ci, { notice: 'checks-settled', green: 1, successful: 1, red: 1, sha: 'a'.repeat(40) })).toEqual([]);
    expect(store.clearByWatch(ci, { notice: 'checks-settled', green: 1, successful: 0, red: 0, sha: 'a'.repeat(40) })).toEqual([]);
    expect(store.clearByWatch(ci, { notice: 'checks-settled', green: 1, successful: 1, red: 0, sha: 'b'.repeat(40) })).toEqual([]);
    expect(store.clearByWatch(ci, { notice: 'checks-settled', green: 1, successful: 1, red: 0, sha: 'a'.repeat(40) })).toHaveLength(1);
    expect(store.impact(a.id)?.stage).toBe('implemented');
    expect(store.clearByWatch(ci, { notice: 'checks-settled', green: 1, successful: 1, red: 0, sha: 'a'.repeat(40) })).toEqual([]);
  });

  it('accepts ref movement only from the linked baseline', () => {
    const store = newStore();
    const a = store.report(report({ resourceKey: 'ref:owner/repo@main', kind: 'other', watchId: 'w-ref',
      watchHead: 'a'.repeat(40), capacity: null })).impact;
    const ref = watch({ id: 'w-ref', kind: 'ref', target: 'owner/repo@main', until: 'moved', baseline: 'a'.repeat(40) });
    expect(store.clearByWatch(ref, { notice: 'moved', fromSha: 'b'.repeat(40), sha: 'c'.repeat(40) })).toEqual([]);
    expect(store.clearByWatch(ref, { notice: 'moved', fromSha: 'a'.repeat(40), sha: 'c'.repeat(40) })).toHaveLength(1);
    expect(store.impact(a.id)?.state).toBe('resolved');
  });

  it('does not mistake a merged dependency PR for a release milestone', () => {
    const store = newStore();
    const sha = 'a'.repeat(40);
    const first = store.report(report({ kind: 'other', resourceKey: 'pr:owner/repo#2',
      watchId: 'w-merged', watchHead: sha, capacity: null })).impact;
    const merged = watch({ id: 'w-merged', kind: 'pr', target: 'owner/repo#2', until: 'merged', baseline: sha });
    expect(store.clearByWatch(merged, { notice: 'merged', sha })).toHaveLength(1);
    expect(store.milestones()).toEqual([]);
    store.report(report({ eventId: 'next-episode', revision: 1, kind: 'worker-limit',
      resourceKey: 'worker-limit:host-a', watchId: null, watchHead: null }));
    expect(store.impact(first.id)?.state).toBe('received');
    expect(store.milestones()).toEqual([]);
  });

  it('keeps one action record and requires explicit application separate from note acknowledgement', () => {
    const store = newStore();
    const a = store.report(report()).impact;
    expect(store.reserveAction('action-a', a.id, 0, 'Wait', 'human')).toEqual({ state: 'reserved', noteId: null });
    store.completeAction('action-a', 'n-synthetic');
    expect(store.reserveAction('action-a', a.id, 0, 'Wait', 'human')).toEqual({ state: 'sent', noteId: 'n-synthetic' });
    expect(store.impact(a.id)?.state).toBe('action-assigned');
    store.markApplied(a.id, 'n-synthetic', 'apply-a', 0);
    expect(store.impact(a.id)?.state).toBe('waiting');
    expect(store.markApplied(a.id, 'n-synthetic', 'apply-a', 0).state).toBe('waiting');
    expect(() => store.markApplied(a.id, 'n-other', 'apply-b', 0)).toThrow('note changed');
  });

  it('retains age and action history but refuses a late old action on a renamed newer report', () => {
    const store = newStore();
    const original = store.report(report()).impact;
    store.reserveAction('action-old', original.id, 0, 'Wait', 'human');
    const renamed = store.report(report({ eventId: 'event-renamed', revision: 1,
      bindingGeneration: 2, watchId: 'w-new', outcome: 'Renamed release A' })).impact;
    expect(renamed.firstBlockedAt).toBe(original.firstBlockedAt);
    expect(renamed.state).toBe('received');
    expect(() => store.completeAction('action-old', 'n-old')).toThrow('superseded');
    expect(store.impact(original.id)?.noteId).toBeNull();
    expect(store.actions()[0].noteId).toBeNull();
    expect(() => store.markApplied(original.id, 'n-old', 'applied-old', 0)).toThrow('note changed');
    expect(store.markEscalated(original.id, 0, Date.now())).toBe(false);
    expect(store.impact(original.id)?.escalatedAt).toBeNull();
  });

  it('preserves same-episode acknowledgement, assignment, application and checkpoint identity across reports', () => {
    const store = newStore();
    const original = store.report(report({ kind: 'worker-limit', watchId: null,
      resourceKey: 'worker-limit:host-a' })).impact;
    store.acknowledge(original.id, 0);
    store.reserveAction('action-a', original.id, 0, 'Wait for slot', 'human');
    store.completeAction('action-a', 'n-action');
    const firstEscalation = Date.now();
    expect(store.markEscalated(original.id, 0, firstEscalation)).toBe(true);
    const updated = store.report(report({ eventId: 'event-next', revision: 1, kind: 'worker-limit', watchId: null,
      resourceKey: 'worker-limit:host-a', outcome: 'Renamed release' })).impact;
    expect(updated).toMatchObject({ firstBlockedAt: original.firstBlockedAt, state: 'action-assigned',
      noteId: 'n-action', escalatedAt: firstEscalation });
    expect(store.dueCheckpoints(Date.now() + 120_000)).toEqual([]);
    expect(store.markApplied(original.id, 'n-action', 'applied-after-report', 0).state).toBe('waiting');
    const newCheckpoint = store.report(report({ eventId: 'event-later', revision: 2, kind: 'worker-limit', watchId: null,
      resourceKey: 'worker-limit:host-a', checkpointAt: now + 120_000 })).impact;
    expect(newCheckpoint.state).toBe('waiting');
    expect(newCheckpoint.escalatedAt).toBeNull();
    const backToFirst = store.report(report({ eventId: 'event-back', revision: 3, kind: 'worker-limit', watchId: null,
      resourceKey: 'worker-limit:host-a' })).impact;
    expect(backToFirst.escalatedAt).toBeNull();
    expect(store.dueCheckpoints(Date.now() + 120_000)).toEqual([]);
  });

  it('starts a new dependency episode without carrying the old decision into a changed resource', () => {
    const store = newStore();
    const first = store.report(report({ kind: 'worker-limit', watchId: null,
      resourceKey: 'worker-limit:host-a' })).impact;
    store.reserveAction('action-resource-a', first.id, 0, 'Use host A slot', 'human');
    store.completeAction('action-resource-a', 'n-old-resource');
    const next = store.report(report({ eventId: 'resource-changed', revision: 1, kind: 'memory',
      watchId: null, resourceKey: 'memory:host-a' })).impact;
    expect(next).toMatchObject({ state: 'received', noteId: null, proof: null });
    expect(next.firstBlockedAt).toBeGreaterThan(first.firstBlockedAt);
    expect(store.actions()[0]).toMatchObject({ id: 'action-resource-a', state: 'sent', noteId: 'n-old-resource' });
    expect(() => store.reserveAction('action-resource-a', first.id, 0, 'Use host A slot', 'human')).toThrow('no longer applies');
    expect(store.actionNoteDeliverable('action-resource-a', 'n-old-resource', 'ws-a')).toBe(false);
    expect(() => store.markApplied(first.id, 'n-old-resource', 'old-application', 0)).toThrow('note changed');
  });

  it('supersedes a failed reserved decision before a newer revision can route it', () => {
    const store = newStore();
    const initial = store.report(report({ kind: 'worker-limit', watchId: null,
      resourceKey: 'worker-limit:host-a' })).impact;
    store.reserveAction('action-stale', initial.id, 0, 'Use old slot', 'human');
    store.report(report({ eventId: 'event-newer', revision: 1, kind: 'worker-limit', watchId: null,
      resourceKey: 'worker-limit:host-a' }));
    expect(store.reserveAction('action-stale', initial.id, 0, 'Use old slot', 'human').state).toBe('superseded');
    expect(store.actions()[0]).toMatchObject({ id: 'action-stale', state: 'superseded', noteId: null });
    expect(() => store.completeAction('action-stale', 'n-late')).toThrow('superseded');
  });

  it('resolves supplied capacity only with a current revision and structured host evidence', () => {
    const store = newStore();
    const initial = store.report(report({ kind: 'memory', watchId: null, resourceKey: 'memory:host-a' })).impact;
    const resolution = { schemaVersion: 1 as const, type: 'resolved' as const, eventId: 'resolve-a',
      workspaceId: 'ws-a', runId: 'run-a', bindingGeneration: 1, impactId: initial.id,
      expectedRevision: 0, observedAt: Date.now(), evidence: { host: 'host-a',
        measuredReason: 'free memory rose above admission threshold', limit: '24 GiB', use: '8 GiB',
        holder: null, clearingCondition: 'lease free', reference: 'host-signals:sample-1' } };
    expect(() => store.resolveCapacity({ ...resolution, evidence: { ...resolution.evidence, host: 'host-b' } }))
      .toThrow('blocked host');
    expect(store.resolveCapacity(resolution).state).toBe('resolved');
    expect(store.resolveCapacity(resolution).proof).toContain('host-signals:sample-1');
    expect(() => store.resolveCapacity({ ...resolution, eventId: 'resolve-late' })).toThrow('changed');
    expect(store.impact(initial.id)?.stage).toBe('implemented');
    expect(() => parsePortfolioResolution({ ...resolution, evidence: { ...resolution.evidence, reference: '' } }))
      .toThrow('Too small');
    expect(() => parsePortfolioReport(report({ kind: 'memory', watchId: 'w-pr', resourceKey: 'pr:owner/repo#1' })))
      .toThrow('unrelated watch');
  });

  it('rejects observations before the current capacity report and retains other shared impacts', () => {
    const store = newStore();
    const first = store.report(report({ kind: 'worker-limit', watchId: null,
      resourceKey: 'worker-limit:host-a', producerAt: now - 20_000 })).impact;
    const other = store.report(report({ eventId: 'other-workspace', workspaceId: 'ws-b', runId: 'run-b',
      sourceKey: 'other-source', kind: 'worker-limit', watchId: null,
      resourceKey: 'worker-limit:host-a', producerAt: now - 20_000 })).impact;
    store.report(report({ eventId: 'new-observation', revision: 1, kind: 'worker-limit', watchId: null,
      resourceKey: 'worker-limit:host-a', producerAt: now + 1_000 }));
    const resolution = { schemaVersion: 1 as const, type: 'resolved' as const, eventId: 'capacity-proof',
      workspaceId: 'ws-a', runId: 'run-a', bindingGeneration: 1, impactId: first.id,
      expectedRevision: 1, observedAt: now, evidence: { host: 'host-a', measuredReason: 'slot available',
        limit: '4', use: '3', holder: null, clearingCondition: 'lease free', reference: 'sample-2' } };
    expect(() => store.resolveCapacity(resolution)).toThrow('predates');
    expect(store.pendingWakes()).toEqual([]);
    const resolved = store.resolveCapacity({ ...resolution, observedAt: now + 1_000 });
    expect(resolved.state).toBe('resolved');
    expect(store.impact(other.id)?.state).toBe('received');
    expect(store.pendingWakes()).toMatchObject([{ workspaceId: 'ws-b', source: 'capacity-claim' }]);
    expect(store.resolveCapacity({ ...resolution, observedAt: now + 1_000 }).state).toBe('resolved');
    expect(store.pendingWakes()).toHaveLength(1);
  });

  it('keeps authenticated human release milestone evidence separate from blocker proof', () => {
    const store = newStore();
    const initial = store.report(report()).impact;
    const milestone = { eventId: 'milestone-a', workspaceId: 'ws-a', runId: 'run-a',
      stage: 'deployed' as const, evidence: 'deployment record deploy-123', observedAt: Date.now() };
    expect(store.confirmMilestone(milestone, 'human-1')).toMatchObject({ stage: 'deployed',
      source: 'human-confirmed', actor: 'human-1' });
    expect(store.confirmMilestone(milestone, 'human-1')).toMatchObject({ stage: 'deployed' });
    expect(() => store.confirmMilestone({ ...milestone, evidence: 'different record' }, 'human-1')).toThrow('reused');
    expect(store.impact(initial.id)?.state).toBe('received');
    expect(store.impact(initial.id)?.proof).toBeNull();
  });
});
