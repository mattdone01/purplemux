import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import MissionControlDashboard from '@/components/features/mission-control/mission-control-dashboard';
import {
  adoptCurrentMissionItem,
  createMissionDraft,
  deliveryStatus,
  editMissionDraft,
  mergeMissionRefreshSnapshot,
  missionDraftRequest,
  shouldApplyMissionSnapshot,
} from '@/components/features/mission-control/mission-control-utils';
import type {
  IMissionAttentionItem,
  IMissionSnapshot,
} from '@/types/mission-control';

const now = 2_000_000;

const item = (over: Partial<IMissionAttentionItem> = {}): IMissionAttentionItem => ({
  id: 'question-1',
  workspaceId: 'ws-1',
  runId: 'run-1',
  revision: 1,
  state: 'open',
  kind: 'question',
  title: 'Choose a release path',
  context: 'The deployment is ready for a decision.',
  storyIds: ['PAY-42'],
  options: [
    { id: 'staged', label: 'Staged rollout', description: 'Start with one tenant.' },
    { id: 'all', label: 'All tenants' },
  ],
  recommendation: 'Use a staged rollout.',
  blockingScope: 'story',
  canContinue: true,
  evidence: { source: 'agent', sourceId: 'event-1', observedAt: now - 10_000, confidence: 'confirmed' },
  answerId: null,
  resolution: null,
  createdAt: now - 60_000,
  updatedAt: now - 10_000,
  ...over,
});

const snapshot = (): IMissionSnapshot => ({
  schemaVersion: 1,
  cursor: 8,
  generatedAt: now,
  workspaces: [{
    workspaceId: 'ws-1',
    name: 'Payments',
    orphaned: false,
    activity: 'active',
    agents: [{
      tabId: 'tab-1',
      name: 'orchestrator',
      providerId: 'codex',
      sessionId: 'session-1',
      cliState: 'busy',
      alive: true,
      lastActivityAt: now - 2_000,
    }],
    runIds: ['run-1'],
    openItems: 1,
    awaitingAcknowledgement: 1,
    lastActivityAt: now - 2_000,
    lastProgressAt: now - 30_000,
    stale: false,
    evidence: { source: 'harness', sourceId: 'tab-1', observedAt: now, confidence: 'confirmed' },
  }],
  runs: [{
    id: 'run-1',
    workspaceId: 'ws-1',
    revision: 3,
    objective: 'Ship durable answer delivery',
    epic: { id: 'EP-9', title: 'Mission Control', url: 'https://example.test/epic/9' },
    phase: 'implementation',
    state: 'running',
    nextStep: 'Verify the responsive UI',
    binding: null,
    evidence: { source: 'agent', sourceId: 'run-event', observedAt: now, confidence: 'confirmed' },
    closeoutPending: true,
    storyCounts: { total: 5, done: 3, blocked: 1 },
    lastProgressAt: now - 30_000,
    createdAt: now - 600_000,
    updatedAt: now,
  }],
  items: [
    item(),
    item({ id: 'candidate-1', state: 'candidate', title: 'Historical blocker?', evidence: { source: 'bootstrap', sourceId: 'candidate', observedAt: now, confidence: 'provisional' } }),
    item({ id: 'answered-1', state: 'answered', title: 'Choose the database', answerId: 'answer-1', revision: 2 }),
  ],
  answers: [{
    id: 'answer-1',
    submissionId: '11111111-1111-4111-8111-111111111111',
    expectedRevision: 1,
    optionIds: ['staged'],
    text: 'Proceed carefully.',
    actionCompleted: false,
    workspaceId: 'ws-1',
    runId: 'run-1',
    itemId: 'answered-1',
    actor: 'user',
    createdAt: now,
  }],
  deliveries: [{
    id: 'delivery-1',
    answerId: 'answer-1',
    workspaceId: 'ws-1',
    runId: 'run-1',
    binding: null,
    state: 'submitted',
    attempts: 1,
    nextAttemptAt: null,
    lastError: null,
    submittedAt: now,
    acknowledgedAt: null,
    updatedAt: now,
  }],
  recentEvents: [{
    seq: 8,
    id: 'event-8',
    schemaVersion: 1,
    workspaceId: 'ws-1',
    runId: 'run-1',
    entityId: 'question-1',
    revision: 1,
    type: 'attention.opened',
    payload: {},
    producerAt: now,
    committedAt: now,
  }],
  bootstrap: null,
});

describe('Mission Control draft lifecycle', () => {
  it('retains the submission UUID for a retry and replaces it after a deliberate edit', () => {
    const initial = createMissionDraft(item(), '11111111-1111-4111-8111-111111111111');
    const edited = editMissionDraft(initial, { text: 'Use staged rollout' }, 'unused');
    const failed = { ...edited, status: 'error' as const, hasAttempted: true };

    expect(missionDraftRequest(failed).submissionId).toBe('11111111-1111-4111-8111-111111111111');

    const changed = editMissionDraft(failed, { text: 'Use staged rollout for tenant A' }, '22222222-2222-4222-8222-222222222222');
    expect(changed.submissionId).toBe('22222222-2222-4222-8222-222222222222');
    expect(changed.hasAttempted).toBe(false);
  });

  it('keeps stale draft text while adopting the current question revision', () => {
    const stale = {
      ...createMissionDraft(item(), '11111111-1111-4111-8111-111111111111'),
      optionIds: ['staged'],
      text: 'Keep this draft',
      hasAttempted: true,
      status: 'conflict' as const,
      currentItem: item({ revision: 2, title: 'Choose the revised release path', options: [{ id: 'all', label: 'All tenants' }] }),
    };

    const adopted = adoptCurrentMissionItem(stale, '22222222-2222-4222-8222-222222222222');
    expect(adopted.text).toBe('Keep this draft');
    expect(adopted.optionIds).toEqual([]);
    expect(adopted.expectedRevision).toBe(2);
    expect(adopted.submissionId).toBe('22222222-2222-4222-8222-222222222222');
  });

  it('preserves the authoritative server question while a conflicted draft is edited', () => {
    const currentItem = item({ revision: 2, title: 'Current server question' });
    const conflicted = {
      ...createMissionDraft(item(), '11111111-1111-4111-8111-111111111111'),
      text: 'Stale answer',
      hasAttempted: true,
      status: 'conflict' as const,
      currentItem,
    };

    const edited = editMissionDraft(
      conflicted,
      { text: 'Edited stale answer' },
      '22222222-2222-4222-8222-222222222222',
    );

    expect(edited.status).toBe('conflict');
    expect(edited.currentItem).toBe(currentItem);
    expect(edited.expectedRevision).toBe(1);
    expect(edited.submissionId).toBe('22222222-2222-4222-8222-222222222222');
  });

  it('does not apply a snapshot older than the one already displayed', () => {
    const current = snapshot();
    expect(shouldApplyMissionSnapshot(current, { ...current, cursor: 7, generatedAt: now + 1_000 })).toBe(false);
    expect(shouldApplyMissionSnapshot(current, { ...current, cursor: 8, generatedAt: now + 1_000 })).toBe(true);
  });

  it.each([
    ['an older bootstrap', {
      id: 'bootstrap-old', boundarySeq: 8, createdAt: now - 1_000, entries: [],
    }],
    ['no bootstrap', null],
  ])('preserves a bootstrap mutation that interleaved with a GET containing %s', (_label, incomingBootstrap) => {
    const authoritativeBootstrap = {
      id: 'bootstrap-new', boundarySeq: 8, createdAt: now + 1_000, entries: [],
    };
    const current = { ...snapshot(), bootstrap: authoritativeBootstrap };
    const incoming = {
      ...snapshot(),
      generatedAt: now + 2_000,
      bootstrap: incomingBootstrap,
    };

    const merged = mergeMissionRefreshSnapshot(current, incoming, 4, 5);

    expect(merged.bootstrap).toBe(authoritativeBootstrap);
    expect(merged.generatedAt).toBe(now + 2_000);
  });

  it('distinguishes saved, delivered, and acknowledged states', () => {
    expect(deliveryStatus({ ...snapshot().deliveries[0], state: 'queued' }).label).toContain('Saved');
    expect(deliveryStatus(snapshot().deliveries[0]).label).toContain('Delivered');
    expect(deliveryStatus({ ...snapshot().deliveries[0], state: 'acknowledged' }).label).toContain('Acknowledged');
  });
});

describe('Mission Control dashboard', () => {
  it('renders the inbox first, keeps candidates separate, and exposes honest delivery state', () => {
    const data = snapshot();
    data.bootstrap = {
      id: 'bootstrap-1',
      boundarySeq: 8,
      createdAt: now,
      entries: [{
        workspaceId: 'ws-1',
        runId: 'run-1',
        binding: null,
        state: 'confirmed',
        reason: null,
        updatedAt: now,
      }],
    };
    const open = data.items[0];
    const html = renderToStaticMarkup(
      <MissionControlDashboard
        snapshot={data}
        drafts={{ [open.id]: createMissionDraft(open, '11111111-1111-4111-8111-111111111111') }}
        refreshing={false}
        bootstrapPending={false}
        bootstrapError={null}
        onRefresh={() => {}}
        onDraftChange={() => {}}
        onAdoptCurrent={() => {}}
        onSubmit={() => {}}
        onOpenWorkspace={() => {}}
        onBootstrap={() => {}}
      />,
    );

    expect(html.indexOf('Needs you')).toBeLessThan(html.indexOf('Workspaces'));
    expect(html.indexOf('Workspaces')).toBeLessThan(html.indexOf('Provisional candidates'));
    expect(html).toContain('Choose a release path');
    expect(html).toContain('Delivered · awaiting acknowledgement');
    expect(html).toContain('Provisional candidates');
    expect(html).toContain('Awaiting orchestrator confirmation');
    expect(html).toContain('Epic closeout pending');
    expect(html).toContain('Your decisions and active work across all workspaces.');
    expect(html).toContain('1 confirmed');
    expect(html).toContain('Discover again');
    expect(html).toContain('<details');
    expect(html).not.toContain('<details open');
  });

  it('uses a single-column, overflow-safe base layout suitable for 320px screens', () => {
    const data = snapshot();
    const open = data.items[0];
    const html = renderToStaticMarkup(
      <MissionControlDashboard
        snapshot={data}
        drafts={{ [open.id]: createMissionDraft(open) }}
        refreshing={false}
        bootstrapPending={false}
        bootstrapError={null}
        onRefresh={() => {}}
        onDraftChange={() => {}}
        onAdoptCurrent={() => {}}
        onSubmit={() => {}}
        onOpenWorkspace={() => {}}
        onBootstrap={() => {}}
      />,
    );

    expect(html).toContain('px-3');
    expect(html).toContain('min-w-0');
    expect(html).toContain('w-full sm:w-auto');
    expect(html).toContain('lg:grid-cols-2');
  });
});
