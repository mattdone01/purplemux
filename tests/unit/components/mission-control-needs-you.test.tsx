import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { RouterContext } from 'next/dist/shared/lib/router-context.shared-runtime';
import type { NextRouter } from 'next/router';
import MissionControlNeedsYou, { needsYouGroups } from '@/components/features/mission-control/mission-control-needs-you';
import { createMissionDraft } from '@/components/features/mission-control/mission-control-utils';
import type { IMissionDraft } from '@/components/features/mission-control/mission-control-utils';
import MissionControlPage from '@/pages/mission-control';
import type {
  IMissionAttentionItem,
  IMissionSnapshot,
  IMissionWorkspaceView,
} from '@/types/mission-control';

const now = 5_000_000;

const question = (over: Partial<IMissionAttentionItem> = {}): IMissionAttentionItem => ({
  id: 'q-1',
  workspaceId: 'ws-pay',
  runId: 'run-1',
  revision: 1,
  state: 'open',
  kind: 'question',
  title: 'Choose a release path',
  context: 'The deployment is ready for a decision.',
  storyIds: [],
  options: [{ id: 'staged', label: 'Staged rollout' }, { id: 'all', label: 'All tenants' }],
  recommendation: null,
  blockingScope: 'story',
  canContinue: true,
  evidence: { source: 'agent', sourceId: 'event-1', observedAt: now, confidence: 'confirmed' },
  answerId: null,
  resolution: null,
  humanReview: {
    humanNeed: 'decision',
    humanReason: 'Only the owner can accept the product risk.',
    handling: 'The orchestrator checked the rollout plan.',
    reviewerTabId: 'tab-1',
    binding: { tabId: 'tab-1', providerId: 'codex', sessionId: 'session-1', generation: 1, runtimeGeneration: 'launch-1' },
    eventId: 'event-review-1',
    reviewedAt: now,
  },
  candidateReason: null,
  createdAt: now - 60_000,
  updatedAt: now,
  ...over,
});

const workspace = (workspaceId: string, name: string): IMissionWorkspaceView => ({
  workspaceId,
  name,
  orphaned: false,
  activity: 'active',
  agents: [],
  runIds: [],
  openItems: 0,
  awaitingAcknowledgement: 0,
  lastActivityAt: now,
  lastProgressAt: now,
  stale: false,
  evidence: { source: 'harness', sourceId: workspaceId, observedAt: now, confidence: 'confirmed' },
});

const snapshot = (items: IMissionAttentionItem[]): IMissionSnapshot => ({
  schemaVersion: 1,
  cursor: 4,
  generatedAt: now,
  workspaces: [workspace('ws-pay', 'Payments'), workspace('ws-tre', 'Treasury')],
  runs: [],
  items,
  answers: [],
  deliveries: [],
  recentEvents: [],
  bootstrap: null,
});

const draftsFor = (items: IMissionAttentionItem[]): Record<string, IMissionDraft> =>
  Object.fromEntries(items.filter((item) => item.state === 'open').map((item) => [item.id, createMissionDraft(item)]));

const render = (props: Partial<Parameters<typeof MissionControlNeedsYou>[0]>) => renderToStaticMarkup(
  <MissionControlNeedsYou
    snapshot={null}
    loading={false}
    unsupported={false}
    error={null}
    refreshing={false}
    drafts={{}}
    onRetry={() => {}}
    onDraftChange={() => {}}
    onAdoptCurrent={() => {}}
    onSubmit={() => {}}
    {...props}
  />,
);

describe('Needs you on the default Mission Control view', () => {
  it('puts the Needs you section before the portfolio board on first load', () => {
    const router = { pathname: '/mission-control', asPath: '/mission-control', query: {}, push: async () => true } as unknown as NextRouter;
    const html = renderToStaticMarkup(
      <RouterContext.Provider value={router}><MissionControlPage /></RouterContext.Provider>,
    );

    const needsYou = html.indexOf('id="needs-you-heading"');
    expect(needsYou).toBeGreaterThan(-1);
    expect(needsYou).toBeLessThan(html.indexOf('>Portfolio board</h1>'));
    expect(html).toContain('Loading the questions that need you');
    expect(html).toContain('Mission records');
    expect(html).not.toContain('>Mission Control</h1>');
  });

  it('shows every confirmed question as an answer card, grouped by workspace, oldest first, with a count', () => {
    const items = [
      question({ id: 'pay-new', title: 'Pay newer question', createdAt: now - 10_000 }),
      question({ id: 'tre-old', workspaceId: 'ws-tre', title: 'Treasury oldest question', createdAt: now - 90_000 }),
      question({ id: 'pay-old', title: 'Pay older question', createdAt: now - 50_000 }),
      question({ id: 'candidate', state: 'candidate', title: 'Candidate only', humanReview: null, candidateReason: 'historical-context' }),
      question({ id: 'handled', title: 'Orchestrator handles this',
        humanReview: { ...question().humanReview!, humanNeed: 'none' } }),
      question({ id: 'answered', state: 'answered', title: 'Already answered', answerId: 'answer-1' }),
    ];
    const html = render({ snapshot: snapshot(items), drafts: draftsFor(items) });

    expect(html).toMatch(/Needs you<\/h2><span[^>]*>3<\/span>/);
    expect(html).toContain('Only the owner can accept the product risk.');
    expect(html).toContain('Staged rollout');
    for (const hidden of ['Candidate only', 'Orchestrator handles this', 'Already answered']) {
      expect(html).not.toContain(hidden);
    }
    const order = ['Treasury oldest question', 'Pay older question', 'Pay newer question'].map((title) => html.indexOf(title));
    expect(order.every((position) => position > -1)).toBe(true);
    expect(order).toEqual([...order].sort((left, right) => left - right));
    expect(html.indexOf('>Treasury</p>')).toBeLessThan(html.indexOf('>Payments</p>'));
  });

  it('shows the empty state with a zero count when nothing needs an answer', () => {
    const html = render({ snapshot: snapshot([question({ state: 'answered', answerId: 'answer-1' })]) });

    expect(html).toContain('No confirmed questions need an answer.');
    expect(html).toMatch(/Needs you<\/h2><span[^>]*>0<\/span>/);
  });

  it('shows a loading state without a count before the first snapshot', () => {
    const html = render({ loading: true });

    expect(html).toContain('role="status"');
    expect(html).toContain('Loading the questions that need you');
    expect(html).toContain('data-slot="skeleton"');
    expect(html).not.toMatch(/Needs you<\/h2><span/);
    expect(html).not.toContain('No confirmed questions need an answer.');
  });

  it('shows the read error with Retry when no snapshot has loaded', () => {
    const html = render({ error: 'mission-control storage unavailable' });

    expect(html).toContain('role="alert"');
    expect(html).toContain('Questions could not load: mission-control storage unavailable.');
    expect(html).toContain('Retry');
    expect(html).not.toContain('No confirmed questions need an answer.');
  });

  it('says so when the server has no Mission Control API', () => {
    const html = render({ unsupported: true });

    expect(html).toContain('does not expose the Mission Control API');
    expect(html).toContain('Retry');
    expect(html).not.toContain('role="alert"');
  });

  it('keeps the last snapshot on screen when a refresh fails', () => {
    const items = [question()];
    const html = render({ snapshot: snapshot(items), drafts: draftsFor(items), error: 'connection reset' });

    expect(html).toContain('Live refresh failed: connection reset. Showing the last confirmed snapshot.');
    expect(html).toContain('Choose a release path');
  });

  it('stacks into one column at phone width', () => {
    const items = [question()];
    const loaded = render({ snapshot: snapshot(items), drafts: draftsFor(items) });
    const failed = render({ error: 'boom' });

    expect(loaded).toContain('grid min-w-0 gap-3 xl:grid-cols-2');
    expect(loaded).not.toMatch(/class="[^"]*(?<![a-z]:)grid-cols-2/);
    expect(loaded).toContain('w-full sm:w-auto');
    expect(failed).toContain('flex flex-col gap-3');
    expect(failed).toContain('w-full shrink-0 sm:w-auto');
  });
});

describe('needsYouGroups', () => {
  it('orders workspaces by their oldest question and breaks ties by id', () => {
    const groups = needsYouGroups([
      question({ id: 'b', createdAt: 20 }),
      question({ id: 'a', createdAt: 20 }),
      question({ id: 'c', workspaceId: 'ws-unknown', createdAt: 10 }),
    ], [workspace('ws-pay', 'Payments')]);

    expect(groups.map((group) => [group.workspaceId, group.workspace?.name, group.items.map((item) => item.id)])).toEqual([
      ['ws-unknown', undefined, ['c']],
      ['ws-pay', 'Payments', ['a', 'b']],
    ]);
  });
});
