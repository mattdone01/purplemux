export type TPortfolioStage = 'implemented' | 'reviewed' | 'merged' | 'deployed' | 'verified';
export type TPortfolioBlockerState = 'received' | 'acknowledged' | 'action-assigned' | 'waiting' | 'resolved';
export type TPortfolioDependencyKind = 'ci' | 'lease' | 'worker-limit' | 'build-slots' | 'memory' | 'disk-reservation' | 'other';

export interface IPortfolioCapacity {
  host: string;
  measuredReason: string;
  limit: string | null;
  use: string | null;
  holder: string | null;
  clearingCondition: string | null;
}

export interface IPortfolioReport {
  eventId: string;
  schemaVersion: 1;
  workspaceId: string;
  runId: string;
  bindingGeneration: number;
  sourceKey: string;
  revision: number;
  producerAt: number;
  resourceKey: string;
  kind: TPortfolioDependencyKind;
  watchId: string | null;
  watchHead: string | null;
  outcome: string;
  priority: number;
  stage: TPortfolioStage;
  owner: string;
  cause: string;
  evidence: string;
  nextAction: string;
  decisionOwner: string;
  checkpointAt: number | null;
  capacity: IPortfolioCapacity | null;
}

export interface IPortfolioResolution {
  schemaVersion: 1;
  type: 'resolved';
  eventId: string;
  workspaceId: string;
  runId: string;
  bindingGeneration: number;
  impactId: string;
  expectedRevision: number;
  observedAt: number;
  evidence: {
    host: string;
    measuredReason: string;
    limit: string | null;
    use: string | null;
    holder: string | null;
    clearingCondition: string;
    reference: string;
  };
}

export interface IPortfolioMilestone {
  workspaceId: string;
  runId: string;
  stage: 'merged' | 'deployed' | 'verified';
  source: 'human-confirmed';
  evidence: string;
  observedAt: number;
  actor: string | null;
}

export interface IPortfolioImpact extends Omit<IPortfolioReport, 'eventId' | 'bindingGeneration' | 'producerAt'> {
  id: string;
  state: TPortfolioBlockerState;
  firstBlockedAt: number;
  updatedAt: number;
  proof: string | null;
  noteId: string | null;
  noteState: string | null;
  noteDeliveredAt: number | null;
  escalatedAt: number | null;
}

export interface IPortfolioDependency {
  resourceKey: string;
  kind: TPortfolioDependencyKind;
  firstBlockedAt: number;
  impacts: IPortfolioImpact[];
}

export interface IPortfolioSelection {
  managerWorkspaceId: string;
  managerTabId: string;
  workspaceIds: string[];
}

export interface IPortfolioCoverage {
  workspaceId: string;
  name: string;
  access: 'available' | 'coordinator-missing' | 'workspace-missing';
}

export interface IPortfolioSnapshot {
  selection: IPortfolioSelection | null;
  coverage: IPortfolioCoverage[];
  dependencies: IPortfolioDependency[];
  actions: IPortfolioAction[];
  milestones: IPortfolioMilestone[];
  /** Cursor for the next page of resolved blockers; null when no older page exists. */
  resolvedNextCursor?: string | null;
  generatedAt: number;
}

export interface IPortfolioAction {
  id: string;
  impactId: string;
  actor: string;
  decision: string;
  noteId: string | null;
  state: string;
  createdAt: number;
}
