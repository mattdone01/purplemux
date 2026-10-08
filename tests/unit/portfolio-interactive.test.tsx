import type { NextApiRequest, NextApiResponse } from 'next';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { signSessionToken } from '@/lib/auth';
import { MobilePortfolioButton } from '@/components/features/mobile/mobile-navigation-sheet';
import { PortfolioBoardContent } from '@/components/features/mission-control/portfolio-board';
import { NotesService, type INotesDeps } from '@/lib/notes-service';
import { PortfolioStore } from '@/lib/portfolio-store';
import type { IPortfolioSnapshot } from '@/types/portfolio';
import type { INotesState } from '@/types/note';
import type { IWatch } from '@/types/watch';

const synthetic = vi.hoisted(() => ({
  notes: { notes: [] } as INotesState,
  service: null as NotesService | null,
  watch: { id: 'w-local', workspaceId: 'ws-a', tabId: 'tab-a', kind: 'lease', target: 'merge:o/r',
    until: 'free', baseline: null, verified: true } as IWatch,
  watchAvailable: true,
}));

vi.mock('@/lib/caller', () => ({ resolveCaller: async () => ({ verified: true, identity: 'launch',
  workspaceId: 'ws-a', tabId: 'tab-a', admin: false }) }));
vi.mock('@/lib/mission-control-store', () => ({ getMissionControlStore: () => ({
  snapshot: () => ({ runs: [{ id: 'run-a', workspaceId: 'ws-a', state: 'running',
    binding: { tabId: 'tab-a', generation: 1 } }] }),
}) }));
vi.mock('@/lib/workspace-store', () => {
  const workspaces = [
    { id: 'ws-root', name: 'Root', orchestration: { enabled: true, orchestratorTabId: 'tab-root' } },
    { id: 'ws-a', name: 'A', orchestration: { enabled: true, orchestratorTabId: 'tab-a' } },
  ];
  return { getWorkspaceById: async (id: string) => workspaces.find((workspace) => workspace.id === id),
    getWorkspaces: async () => ({ workspaces }) };
});
vi.mock('@/lib/layout-store', () => ({ resolveLayoutFile: (workspaceId: string) => workspaceId,
  readLayoutFile: async (workspaceId: string) => ({ root: { id: workspaceId } }),
  collectAllTabs: (root: { id: string }) => [{ id: root.id === 'ws-root' ? 'tab-root' : 'tab-a',
    sessionName: `session-${root.id}` }] }));
vi.mock('@/lib/tab-token', () => ({ tabIdentityOf: () => 'launch',
  getTabTokenRecord: (tabId: string) => ({ workspaceId: tabId === 'tab-root' ? 'ws-root' : 'ws-a',
    sessionName: tabId === 'tab-root' ? 'session-ws-root' : 'session-ws-a' }) }));
vi.mock('@/lib/tmux', async (original) => ({ ...await original<typeof import('@/lib/tmux')>(),
  hasSession: async () => true }));
vi.mock('@/lib/watch-store', () => ({ readWatches: async () => ({ watches: synthetic.watchAvailable ? [synthetic.watch] : [] }) }));
vi.mock('@/lib/notes-store', async (original) => ({ ...await original<typeof import('@/lib/notes-store')>(),
  readNotesState: async () => synthetic.notes }));
vi.mock('@/lib/notes-service', async (original) => ({ ...await original<typeof import('@/lib/notes-service')>(),
  getNotesService: async () => synthetic.service }));

const response = () => {
  const state = { status: 0, body: null as unknown };
  const res = { status(value: number) { state.status = value; return this; },
    json(value: unknown) { state.body = value; return this; }, setHeader() { return this; } } as unknown as NextApiResponse;
  return { state, res };
};

const elements = (node: ReactNode): ReactElement[] => {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  return [node, ...elements((node.props as { children?: ReactNode }).children)];
};
const textOf = (node: ReactNode): string => Array.isArray(node) ? node.map(textOf).join('')
  : isValidElement(node) ? textOf((node.props as { children?: ReactNode }).children)
    : typeof node === 'string' ? node : '';

describe('interactive synthetic portfolio API and UI journey', () => {
  let store: PortfolioStore | null = null;
  afterEach(() => { store?.close(); store = null;
    delete (globalThis as { __ptPortfolioStore?: PortfolioStore }).__ptPortfolioStore;
    synthetic.notes = { notes: [] }; synthetic.service = null; synthetic.watchAvailable = true; });

  it('reports by coordinator API, assigns from human board, applies by owner API, clears on proof, and updates the board', async () => {
    process.env.NEXTAUTH_SECRET = 'portfolio-interactive-test-secret-at-least-32-bytes';
    store = new PortfolioStore(':memory:');
    (globalThis as { __ptPortfolioStore?: PortfolioStore }).__ptPortfolioStore = store;
    const inbox = { id: 'i-local', state: 'queued', deliveredAt: null as number | null,
      lastRefusal: null, heldReason: null };
    let failNextNote = false;
    synthetic.service = new NotesService({
      now: () => Date.now(), newId: () => 'n-local',
      mutate: async <T,>(fn: (current: INotesState) => Promise<{ state: INotesState; value: T }> | { state: INotesState; value: T }): Promise<T> => {
        const result = await fn(synthetic.notes); synthetic.notes = result.state; return result.value;
      },
      read: async () => synthetic.notes, epicHolder: async () => null, holdsEpic: async () => false,
      orchestratorOf: async (workspaceId: string) => workspaceId === 'ws-a' ? 'tab-a' : 'tab-root',
      withMappingRead: async <T,>(_workspaceId: string, work: () => Promise<T>): Promise<T> => work(),
      workspaceExists: async () => true,
      liveTabs: async () => ({ tabs: [{ workspaceId: 'ws-a', tabId: 'tab-a' },
        { workspaceId: 'ws-root', tabId: 'tab-root' }], uncertainWorkspaceIds: new Set<string>() }),
      enqueue: async () => {
        if (failNextNote) { failNextNote = false; throw new Error('synthetic inbox failure'); }
        return { item: inbox };
      }, withdraw: async () => true,
      inboxItems: async () => [inbox],
      portfolioActionDeliverable: async (actionId: string, noteId: string, workspaceId: string) =>
        store!.actionNoteDeliverable(actionId, noteId, workspaceId),
    } as unknown as INotesDeps);
    const { default: humanHandler } = await import('@/pages/api/mission-control/portfolio');
    const { default: producerHandler } = await import('@/pages/api/cli/portfolio/events');
    const token = await signSessionToken();
    const human = async (method: 'GET' | 'PUT' | 'POST', body?: unknown, origin = 'http://purplemux.test') => {
      const out = response();
      await humanHandler({ method, body, headers: { cookie: `session-token=${token}`, host: 'purplemux.test',
        ...(method === 'GET' ? {} : { origin }) } } as unknown as NextApiRequest, out.res);
      return out.state;
    };
    const producer = async (body: unknown) => {
      const out = response();
      await producerHandler({ method: 'POST', body, headers: {} } as unknown as NextApiRequest, out.res);
      return out.state;
    };
    expect((await human('PUT', { managerWorkspaceId: 'ws-root', managerTabId: 'tab-root', workspaceIds: ['ws-a'] })).status).toBe(200);
    const { getPortfolioSnapshotForSelection } = await import('@/lib/portfolio-service');
    await expect(getPortfolioSnapshotForSelection({ managerWorkspaceId: 'ws-root', managerTabId: 'tab-root',
      workspaceIds: ['ws-root'] })).rejects.toMatchObject({ status: 403 });
    const report = { schemaVersion: 1, eventId: 'report-local', workspaceId: 'ws-a', runId: 'run-a',
      bindingGeneration: 1, sourceKey: 'lease-local', revision: 0, producerAt: Date.now(),
      resourceKey: 'lease:merge:o/r', kind: 'lease', watchId: 'w-local', watchHead: null,
      outcome: 'Ship synthetic release', priority: 100, stage: 'implemented', owner: 'tab-a',
      cause: 'Merge lease held', evidence: 'local fixture lease', nextAction: 'Wait for holder',
      decisionOwner: 'tab-a', checkpointAt: Date.now() + 60_000,
      capacity: { host: 'local', measuredReason: 'held lease', limit: '1', use: '1', holder: 'tab-holder',
        clearingCondition: 'lease free' } };
    expect((await producer(report)).status).toBe(200);
    let snapshot = (await human('GET')).body as IPortfolioSnapshot;
    const impact = snapshot.dependencies[0].impacts[0];
    let decision = '';
    let pending: Promise<unknown> = Promise.resolve();
    const view = () => PortfolioBoardContent({ snapshot, priorityFilter: 'all', onPriorityFilter: () => {},
      decisions: { [impact.id]: decision }, onDecision: (_id, value) => { decision = value; }, pendingId: null,
      onAcknowledge: () => {}, onAssign: (item) => { pending = human('POST', { type: 'assign',
        workspaceId: item.workspaceId, impactId: item.id, expectedRevision: item.revision,
        actionId: 'action-local', decision }); } });
    const input = elements(view()).find((element) => (element.props as { 'aria-label'?: string })['aria-label'] ===
      'Decision for Ship synthetic release')!;
    (input.props as { onChange: (event: { target: { value: string } }) => void }).onChange({ target: { value: 'Ask holder to release' } });
    const action = elements(view()).find((element) => textOf((element.props as { children?: ReactNode }).children).includes('Route action to orchestrator')
      && typeof (element.props as { onClick?: unknown }).onClick === 'function')!;
    (action.props as { onClick: () => void }).onClick();
    expect((await pending as { status: number }).status).toBe(200);
    expect(synthetic.notes.notes[0]).toMatchObject({ from: { humanActor: 'user', verified: false },
      admission: { mode: 'human', targetWorkspaceId: 'ws-a' }, deliveredTo: { workspaceId: 'ws-a', tabId: 'tab-a' } });
    snapshot = (await human('GET')).body as IPortfolioSnapshot;
    expect(snapshot.dependencies[0].impacts[0].state).toBe('action-assigned');
    inbox.state = 'delivered'; inbox.deliveredAt = Date.now();
    await synthetic.service!.ack({ verified: true, workspaceId: 'ws-a', tabId: 'tab-a' } as never,
      synthetic.notes.notes[0].id, 'Applying');
    expect((await producer({ type: 'applied', schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-a',
      bindingGeneration: 1, impactId: impact.id, noteId: synthetic.notes.notes[0].id,
      eventId: 'applied-local', expectedRevision: 0 })).status).toBe(200);
    expect(store!.impact(impact.id)?.state).toBe('waiting');
    expect(store!.clearByWatch(synthetic.watch, { notice: 'free' })).toHaveLength(1);
    synthetic.watchAvailable = false;
    expect((await producer(report)).status).toBe(200);
    expect((await producer({ ...report, evidence: 'changed replay' })).status).toBe(409);
    snapshot = (await human('GET')).body as IPortfolioSnapshot;
    expect(snapshot.dependencies[0].impacts[0]).toMatchObject({ state: 'resolved', stage: 'implemented' });
    const html = renderToStaticMarkup(<PortfolioBoardContent snapshot={snapshot} priorityFilter="all"
      onPriorityFilter={() => {}} showResolved onShowResolved={() => {}} decisions={{}} onDecision={() => {}}
      pendingId={null} onAcknowledge={() => {}} onAssign={() => {}} />);
    expect(html).toContain('Dependency proof: free');
    expect(html).toContain('Last human-confirmed milestone: none');
    let milestoneEvidence = '';
    const milestoneView = () => PortfolioBoardContent({ snapshot, priorityFilter: 'all',
      onPriorityFilter: () => {}, showResolved: true, decisions: {}, onDecision: () => {}, pendingId: null,
      onAcknowledge: () => {}, onAssign: () => {}, milestoneEvidence: { [impact.id]: milestoneEvidence },
      onMilestoneEvidence: (_id, value) => { milestoneEvidence = value; },
      onConfirmMilestone: (item) => { pending = human('POST', { type: 'milestone', eventId: 'milestone-local',
        workspaceId: item.workspaceId, runId: item.runId, stage: 'deployed',
        evidence: milestoneEvidence, observedAt: Date.now() }); } });
    const milestoneInput = elements(milestoneView()).find((element) =>
      (element.props as { 'aria-label'?: string })['aria-label'] === 'Milestone evidence for Ship synthetic release')!;
    (milestoneInput.props as { onChange: (event: { target: { value: string } }) => void })
      .onChange({ target: { value: 'deployment record synthetic-1' } });
    const confirm = elements(milestoneView()).find((element) =>
      textOf((element.props as { children?: ReactNode }).children) === 'Confirm milestone'
      && typeof (element.props as { onClick?: unknown }).onClick === 'function')!;
    (confirm.props as { onClick: () => void }).onClick();
    expect((await pending as { status: number }).status).toBe(200);
    snapshot = (await human('GET')).body as IPortfolioSnapshot;
    const evidenced = renderToStaticMarkup(<PortfolioBoardContent snapshot={snapshot} priorityFilter="all"
      onPriorityFilter={() => {}} showResolved onShowResolved={() => {}} decisions={{}} onDecision={() => {}}
      pendingId={null} onAcknowledge={() => {}} onAssign={() => {}} />);
    expect(evidenced).toContain('Last human-confirmed milestone: deployed');
    expect(evidenced).toContain('Confirmed by user');
    expect(store!.impact(impact.id)?.stage).toBe('implemented');

    const capacityReport = { ...report, eventId: 'report-capacity', sourceKey: 'worker-capacity',
      resourceKey: 'worker-limit:local', kind: 'worker-limit', watchId: null,
      capacity: { ...report.capacity, clearingCondition: 'one free slot' } };
    expect((await producer(capacityReport)).status).toBe(200);
    const capacityImpact = store!.impacts().find((entry) => entry.sourceKey === 'worker-capacity')!;
    const resolution = { type: 'resolved', schemaVersion: 1, eventId: 'resolve-local',
      workspaceId: 'ws-a', runId: 'run-a', bindingGeneration: 1,
      impactId: capacityImpact.id, expectedRevision: 0, observedAt: Date.now(),
      evidence: { host: 'local', measuredReason: 'worker count below limit', limit: '4', use: '3',
        holder: null, clearingCondition: 'one free slot', reference: 'worker-slots:sample-1' } };
    expect((await producer({ ...resolution, bindingGeneration: 0 })).status).toBe(409);
    expect((await producer(resolution)).status).toBe(200);
    expect(store!.impact(capacityImpact.id)).toMatchObject({ state: 'resolved', stage: 'implemented' });
    snapshot = (await human('GET')).body as IPortfolioSnapshot;
    const capacityHtml = renderToStaticMarkup(<PortfolioBoardContent snapshot={snapshot} priorityFilter="all"
      onPriorityFilter={() => {}} showResolved onShowResolved={() => {}} decisions={{}} onDecision={() => {}}
      pendingId={null} onAcknowledge={() => {}} onAssign={() => {}} />);
    expect(capacityHtml).toContain('Coordinator capacity evidence on local');
    expect(capacityHtml).toContain('worker count below limit');
    expect(capacityHtml).toContain('worker-slots:sample-1');
    const staleReport = { ...capacityReport, eventId: 'report-stale', sourceKey: 'stale-capacity' };
    expect((await producer(staleReport)).status).toBe(200);
    const staleImpact = store!.impacts().find((entry) => entry.sourceKey === 'stale-capacity')!;
    failNextNote = true;
    const staleAction = { type: 'assign', workspaceId: 'ws-a', impactId: staleImpact.id,
      expectedRevision: 0, actionId: 'action-stale-local', decision: 'Wait for new slot' };
    expect((await human('POST', staleAction)).status).toBe(503);
    expect(store!.actions().find((entry) => entry.id === 'action-stale-local')?.state).toBe('reserved');
    expect((await producer({ ...staleReport, eventId: 'report-stale-next', revision: 1 })).status).toBe(200);
    const noteCount = synthetic.notes.notes.length;
    expect((await human('POST', staleAction)).status).toBe(409);
    expect(synthetic.notes.notes).toHaveLength(noteCount);
    expect(store!.actions().find((entry) => entry.id === 'action-stale-local')?.state).toBe('superseded');
    expect((await human('POST', { type: 'assign', workspaceId: 'ws-a', impactId: impact.id, expectedRevision: 0,
      actionId: 'bad-origin', decision: 'No' }, 'https://foreign.test')).status).toBe(403);
    store!.select('another-human', { managerWorkspaceId: 'ws-root', managerTabId: 'tab-root', workspaceIds: [] });
    snapshot = (await human('GET')).body as IPortfolioSnapshot;
    expect(snapshot.selection?.workspaceIds).toEqual([]);
    expect(snapshot.dependencies).toEqual([]);
    expect((await human('POST', { type: 'acknowledge', workspaceId: 'ws-a', impactId: impact.id,
      expectedRevision: 0 })).status).toBe(403);
    const leaseWatch = synthetic.watch;
    try {
      synthetic.watch = { ...leaseWatch, id: 'w-ci-local', kind: 'pr', target: 'owner/repo#1',
        until: 'checks-settled', baseline: 'a'.repeat(40) };
      synthetic.watchAvailable = true;
      const ciReport = { ...report, eventId: 'ci-report-local', sourceKey: 'ci-source',
        resourceKey: 'pr:owner/repo#1', kind: 'ci', watchId: 'w-ci-local',
        watchHead: 'a'.repeat(40), capacity: null };
      expect((await producer(ciReport)).status).toBe(200);
      synthetic.watchAvailable = false;
      expect((await producer(ciReport)).status).toBe(200);
    } finally { synthetic.watch = leaseWatch; synthetic.watchAvailable = true; }
  });

  it('closes the mobile sheet and opens the portfolio route on a tap', () => {
    const calls: string[] = [];
    const button = MobilePortfolioButton({ active: false, close: () => calls.push('close'),
      navigate: (path) => calls.push(path) });
    expect(button.props['aria-label']).toBe('Portfolio board');
    button.props.onClick();
    expect(calls).toEqual(['close', '/mission-control']);
  });
});
