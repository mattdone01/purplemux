import { describe, expect, it } from 'vitest';
import { MissionControlError } from '@/lib/mission-control-errors';
import { parseMissionEvents } from '@/lib/mission-control-validation';

const event = (humanReview: unknown) => ({
  eventId: 'event-review',
  schemaVersion: 1,
  workspaceId: 'ws-a',
  runId: 'run-a',
  expectedRevision: 0,
  producerAt: 1_700_000_000_000,
  bindingGeneration: 1,
  type: 'attention.opened',
  payload: {
    itemId: 'item-a',
    kind: 'question',
    title: 'Choose',
    context: 'Choose a safe rollout.',
    storyIds: [],
    options: [],
    recommendation: null,
    blockingScope: 'story',
    canContinue: true,
    humanReview,
  },
});

describe('Mission Control human review validation', () => {
  it.each(['decision', 'approval', 'information', 'external-action'] as const)(
    'accepts and trims a complete %s review',
    (humanNeed) => {
      const [parsed] = parseMissionEvents([event({
        humanNeed,
        humanReason: '  Only the human can supply this.  ',
        handling: '  Existing authority and delegated handling were checked.  ',
        reviewerTabId: ' tab-orchestrator ',
      })]);
      expect(parsed).toMatchObject({
        payload: {
          humanReview: {
            humanNeed,
            humanReason: 'Only the human can supply this.',
            handling: 'Existing authority and delegated handling were checked.',
            reviewerTabId: 'tab-orchestrator',
          },
        },
      });
    },
  );

  it('accepts a strict workspace disposition without a human reason', () => {
    const [parsed] = parseMissionEvents([event({
      humanNeed: 'none',
      handling: 'The orchestrator can handle this.',
      reviewerTabId: 'tab-orchestrator',
    })]);
    expect(parsed.payload).toMatchObject({ humanReview: { humanNeed: 'none' } });
  });

  it.each([
    ['null review', null],
    ['unknown need', { humanNeed: 'routine', humanReason: 'Reason', handling: 'Checked', reviewerTabId: 'tab-a' }],
    ['missing reason', { humanNeed: 'approval', handling: 'Checked', reviewerTabId: 'tab-a' }],
    ['blank reason', { humanNeed: 'approval', humanReason: ' ', handling: 'Checked', reviewerTabId: 'tab-a' }],
    ['oversized reason', { humanNeed: 'approval', humanReason: 'x'.repeat(1001), handling: 'Checked', reviewerTabId: 'tab-a' }],
    ['blank handling', { humanNeed: 'none', handling: ' ', reviewerTabId: 'tab-a' }],
    ['server stamp', { humanNeed: 'none', handling: 'Checked', reviewerTabId: 'tab-a', reviewedAt: 1 }],
  ])('rejects %s', (_case, review) => {
    expect(() => parseMissionEvents([event(review)])).toThrowError(MissionControlError);
  });

  it('rejects client routing and the reserved migration event namespace', () => {
    const withRouting = event(undefined);
    withRouting.payload = { ...withRouting.payload, routing: { state: 'open' } } as typeof withRouting.payload;
    expect(() => parseMissionEvents([withRouting])).toThrowError(MissionControlError);
    expect(() => parseMissionEvents([{ ...event(undefined), eventId: 'system:migration:forged' }]))
      .toThrowError(/reserved namespace/);
  });
});
