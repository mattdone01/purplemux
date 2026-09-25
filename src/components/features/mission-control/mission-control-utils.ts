import type {
  IMissionAnswerRequest,
  IMissionAttentionItem,
  IMissionDelivery,
  IMissionSnapshot,
} from '@/types/mission-control';

export type TMissionDraftStatus = 'editing' | 'submitting' | 'error' | 'conflict';

export interface IMissionDraft {
  item: IMissionAttentionItem;
  expectedRevision: number;
  submissionId: string;
  optionIds: string[];
  text: string;
  actionCompleted: boolean;
  status: TMissionDraftStatus;
  error: string | null;
  currentItem: IMissionAttentionItem | null;
  hasAttempted: boolean;
}

export interface IMissionDraftPatch {
  optionIds?: string[];
  text?: string;
  actionCompleted?: boolean;
}

export const createMissionSubmissionId = (): string => {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }

  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (character) => {
    const random = Math.floor(Math.random() * 16);
    const value = character === 'x' ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
};

export const createMissionDraft = (
  item: IMissionAttentionItem,
  submissionId = createMissionSubmissionId(),
): IMissionDraft => ({
  item,
  expectedRevision: item.revision,
  submissionId,
  optionIds: [],
  text: '',
  actionCompleted: false,
  status: 'editing',
  error: null,
  currentItem: null,
  hasAttempted: false,
});

export const editMissionDraft = (
  draft: IMissionDraft,
  patch: IMissionDraftPatch,
  nextSubmissionId = createMissionSubmissionId(),
): IMissionDraft => {
  const unresolvedConflict = draft.status === 'conflict' && draft.currentItem !== null;
  return {
    ...draft,
    ...patch,
    submissionId: draft.hasAttempted ? nextSubmissionId : draft.submissionId,
    status: unresolvedConflict ? 'conflict' : 'editing',
    error: null,
    currentItem: unresolvedConflict ? draft.currentItem : draft.hasAttempted ? null : draft.currentItem,
    hasAttempted: false,
  };
};

export const adoptCurrentMissionItem = (
  draft: IMissionDraft,
  submissionId = createMissionSubmissionId(),
): IMissionDraft => {
  if (!draft.currentItem) return draft;

  const validOptionIds = new Set(draft.currentItem.options.map((option) => option.id));
  return {
    ...draft,
    item: draft.currentItem,
    expectedRevision: draft.currentItem.revision,
    submissionId,
    optionIds: draft.optionIds.filter((optionId) => validOptionIds.has(optionId)),
    status: 'editing',
    error: null,
    currentItem: null,
    hasAttempted: false,
  };
};

export const missionDraftRequest = (draft: IMissionDraft): IMissionAnswerRequest => ({
  submissionId: draft.submissionId,
  expectedRevision: draft.expectedRevision,
  optionIds: draft.optionIds,
  text: draft.text.trim(),
  actionCompleted: draft.actionCompleted,
});

export const isMissionDraftEmpty = (draft: IMissionDraft): boolean =>
  draft.optionIds.length === 0 && draft.text.trim().length === 0 && !draft.actionCompleted;

export const reconcileMissionDraftWithItem = (
  draft: IMissionDraft,
  currentItem: IMissionAttentionItem | undefined,
): IMissionDraft | null => {
  if (!currentItem || (currentItem.state === 'open' && currentItem.revision === draft.expectedRevision)) {
    return draft;
  }
  if (currentItem.state !== 'candidate' && isMissionDraftEmpty(draft) && !draft.hasAttempted) return null;
  return {
    ...draft,
    status: 'conflict',
    error: null,
    currentItem,
    hasAttempted: true,
  };
};

export const isMissionHumanInboxItem = (item: IMissionAttentionItem): boolean =>
  item.state === 'open'
  && item.humanReview !== null
  && item.humanReview.humanNeed !== 'none';

export const missionWorkspaceIssuePresentation = (
  item: IMissionAttentionItem,
): { badge: string; explanation: string } => {
  if (item.humanReview?.humanNeed === 'none') {
    return {
      badge: 'Orchestrator handling',
      explanation: item.humanReview.handling,
    };
  }
  if (item.candidateReason === 'legacy-review') {
    return {
      badge: 'Orchestrator review required',
      explanation: 'Previously shown in Needs you. Awaiting review of whether your input is required.',
    };
  }
  return {
    badge: 'Orchestrator review required',
    explanation: item.candidateReason === 'historical-context'
      ? 'Historical context is waiting for the orchestrator to decide how it should be handled.'
      : 'The orchestrator must review this workspace issue before it can require your input.',
  };
};

export const shouldApplyMissionSnapshot = (
  current: IMissionSnapshot | null,
  incoming: IMissionSnapshot,
): boolean => {
  if (!current) return true;
  if (incoming.cursor !== current.cursor) return incoming.cursor > current.cursor;
  return incoming.generatedAt >= current.generatedAt;
};

export const mergeMissionRefreshSnapshot = (
  current: IMissionSnapshot | null,
  incoming: IMissionSnapshot,
  bootstrapEpochAtRequest: number,
  currentBootstrapEpoch: number,
): IMissionSnapshot => {
  if (current && !shouldApplyMissionSnapshot(current, incoming)) return current;
  if (current && currentBootstrapEpoch > bootstrapEpochAtRequest) {
    return { ...incoming, bootstrap: current.bootstrap };
  }
  return incoming;
};

export const deliveryStatus = (
  delivery: IMissionDelivery | undefined,
): { label: string; tone: 'neutral' | 'positive' | 'warning' | 'negative' } => {
  if (!delivery) return { label: 'Saved · delivery status pending', tone: 'neutral' };

  switch (delivery.state) {
    case 'queued':
      return { label: 'Saved · queued for delivery', tone: 'neutral' };
    case 'dispatching':
      return { label: 'Saved · delivery in progress', tone: 'neutral' };
    case 'submitted':
      return { label: 'Delivered · awaiting acknowledgement', tone: 'warning' };
    case 'acknowledged':
      return { label: 'Acknowledged by orchestrator', tone: 'positive' };
    case 'held':
      return { label: 'Saved · delivery held', tone: 'warning' };
    case 'failed':
      return { label: 'Saved · delivery failed', tone: 'negative' };
  }
};

export const formatMissionAge = (timestamp: number | null, now = Date.now()): string => {
  if (timestamp === null) return 'Not reported';
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
};
