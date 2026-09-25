import type { TCliState } from '@/types/timeline';

export type TMissionRunState = 'running' | 'waiting' | 'completed' | 'cancelled';
export type TMissionActivity = 'active' | 'waiting' | 'dormant' | 'unknown';
export type TMissionItemState = 'candidate' | 'open' | 'answered' | 'resolved' | 'cancelled';
export type TMissionDeliveryState = 'queued' | 'dispatching' | 'submitted' | 'acknowledged' | 'held' | 'failed';
export type TMissionConfidence = 'confirmed' | 'provisional' | 'unknown';

export interface IMissionBinding {
  tabId: string;
  providerId: string;
  sessionId: string;
  generation: number;
  runtimeGeneration: string | null;
}

export interface IMissionEvidence {
  source: 'agent' | 'standup' | 'harness' | 'bootstrap';
  sourceId: string;
  observedAt: number;
  confidence: TMissionConfidence;
}

export interface IMissionEpic {
  id: string;
  title: string;
  url: string | null;
}

export interface IMissionRun {
  id: string;
  workspaceId: string;
  revision: number;
  objective: string;
  epic: IMissionEpic | null;
  phase: string | null;
  state: TMissionRunState;
  nextStep: string | null;
  binding: IMissionBinding | null;
  evidence: IMissionEvidence;
  closeoutPending: boolean;
  storyCounts: { total: number; done: number; blocked: number } | null;
  lastProgressAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface IMissionOption {
  id: string;
  label: string;
  description?: string;
}

export interface IMissionQuestion {
  kind: 'question' | 'action';
  title: string;
  context: string;
  storyIds: string[];
  options: IMissionOption[];
  recommendation: string | null;
  blockingScope: 'none' | 'story' | 'run';
  canContinue: boolean;
}

export interface IMissionAttentionItem extends IMissionQuestion {
  id: string;
  workspaceId: string;
  runId: string;
  revision: number;
  state: TMissionItemState;
  evidence: IMissionEvidence;
  answerId: string | null;
  resolution: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface IMissionAnswerRequest {
  submissionId: string;
  expectedRevision: number;
  optionIds: string[];
  text: string;
  actionCompleted: boolean;
}

export interface IMissionAnswer extends IMissionAnswerRequest {
  id: string;
  workspaceId: string;
  runId: string;
  itemId: string;
  actor: string;
  createdAt: number;
}

export interface IMissionDelivery {
  id: string;
  answerId: string;
  workspaceId: string;
  runId: string;
  binding: IMissionBinding | null;
  state: TMissionDeliveryState;
  attempts: number;
  nextAttemptAt: number | null;
  lastError: string | null;
  submittedAt: number | null;
  acknowledgedAt: number | null;
  updatedAt: number;
}

export interface IMissionAgentObservation {
  tabId: string;
  name: string;
  providerId: string;
  sessionId: string | null;
  cliState: TCliState | null;
  alive: boolean;
  lastActivityAt: number | null;
}

export interface IMissionWorkspaceView {
  workspaceId: string;
  name: string;
  orphaned: boolean;
  activity: TMissionActivity;
  agents: IMissionAgentObservation[];
  runIds: string[];
  openItems: number;
  awaitingAcknowledgement: number;
  lastActivityAt: number | null;
  lastProgressAt: number | null;
  stale: boolean;
  evidence: IMissionEvidence;
}

export interface IMissionEvent {
  seq: number;
  id: string;
  schemaVersion: 1;
  workspaceId: string;
  runId: string | null;
  entityId: string;
  revision: number;
  type: string;
  payload: Record<string, unknown>;
  producerAt: number;
  committedAt: number;
}

export interface IMissionEventBase {
  eventId: string;
  schemaVersion: 1;
  workspaceId: string;
  runId: string;
  expectedRevision: number;
  producerAt: number;
  bindingGeneration: number;
}

export type TMissionProducerEvent = IMissionEventBase & (
  | { type: 'run.started'; payload: { objective: string; epic?: IMissionEpic | null; tabId: string } }
  | { type: 'run.resumed'; payload: { tabId: string; transferPendingAnswers: boolean } }
  | { type: 'progress.updated'; payload: { objective?: string; epic?: IMissionEpic | null; phase?: string | null; state?: 'running' | 'waiting'; nextStep?: string | null; storyCounts?: IMissionRun['storyCounts']; closeoutPending?: boolean } }
  | { type: 'run.finished'; payload: { state: 'completed' | 'cancelled'; summary: string; closeoutPending: boolean } }
  | { type: 'attention.opened'; payload: IMissionQuestion & { itemId: string } }
  | { type: 'attention.updated'; payload: IMissionQuestion & { itemId: string } }
  | { type: 'attention.resolved'; payload: { itemId: string; resolution: string } }
  | { type: 'attention.cancelled'; payload: { itemId: string; reason: string } }
  | { type: 'answer.acknowledged'; payload: { answerId: string } }
);

export interface IMissionBootstrapEntry {
  workspaceId: string;
  runId: string;
  binding: IMissionBinding | null;
  state: 'provisional' | 'queued' | 'dispatching' | 'submitted' | 'confirmed' | 'held';
  reason: string | null;
  updatedAt: number;
}

export interface IMissionBootstrap {
  id: string;
  boundarySeq: number;
  createdAt: number;
  entries: IMissionBootstrapEntry[];
}

export interface IMissionSnapshot {
  schemaVersion: 1;
  cursor: number;
  generatedAt: number;
  workspaces: IMissionWorkspaceView[];
  runs: IMissionRun[];
  items: IMissionAttentionItem[];
  answers: IMissionAnswer[];
  deliveries: IMissionDelivery[];
  recentEvents: IMissionEvent[];
  bootstrap: IMissionBootstrap | null;
}

export interface IMissionEventsResponse {
  schemaVersion: 1;
  events: IMissionEvent[];
  cursor: number;
  hasMore: boolean;
}

export interface IMissionAnswerResponse {
  answer: IMissionAnswer;
  item: IMissionAttentionItem;
  delivery: IMissionDelivery;
  cursor: number;
  replayed: boolean;
}

export interface IMissionError {
  error: string;
  code: 'invalid-request' | 'unauthorized' | 'forbidden' | 'not-found' | 'conflict' | 'storage-unavailable';
  current?: IMissionAttentionItem | IMissionRun;
}
