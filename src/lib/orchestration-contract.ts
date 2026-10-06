import type { IWorkspaceOrchestration } from '@/types/terminal';

export type TOrchestrationMode = 'update' | 'recover' | 'handoff' | 'replace';
export type TOrchestrationActor = { kind: 'human' } | { kind: 'workspace'; workspaceId: string; tabId: string | null; verified: boolean };
export interface IOrchestrationPrecondition {
  expectedRevision: number;
  mode: TOrchestrationMode;
}
export type TOrchestrationPatch = Pick<Partial<IWorkspaceOrchestration>, 'enabled' | 'orchestratorTabId' | 'kickoffTemplate'>;

export class OrchestrationError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string,
    public readonly orchestration?: IWorkspaceOrchestration, public readonly undesignatedTabId?: string) { super(message); }
}

export const normalizeOrchestration = (value?: IWorkspaceOrchestration): IWorkspaceOrchestration & { revision: number } => {
  if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.enabled !== 'boolean' || !(value.orchestratorTabId === null || typeof value.orchestratorTabId === 'string' && value.orchestratorTabId.length > 0)
    || value.kickoffTemplate != null && typeof value.kickoffTemplate !== 'string')) {
    throw new OrchestrationError(503, 'orchestration-unavailable', 'Stored orchestration mapping is invalid');
  }
  const revision = value?.revision ?? 0;
  if (!Number.isSafeInteger(revision) || revision < 0 || (value && 'revision' in value && value.revision == null)) {
    throw new OrchestrationError(503, 'orchestration-unavailable', 'Stored orchestration revision is invalid');
  }
  return { enabled: false, orchestratorTabId: null, ...value, revision };
};

export const parseOrchestrationPrecondition = (raw: unknown): IOrchestrationPrecondition => {
  const body = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  if (body.expectedRevision === undefined) throw new OrchestrationError(428, 'orchestration-precondition-required', 'Read the current orchestration revision before changing it');
  if (!Number.isSafeInteger(body.expectedRevision) || (body.expectedRevision as number) < 0) {
    throw new OrchestrationError(400, 'orchestration-invalid', 'expectedRevision must be a non-negative safe integer');
  }
  const mode = body.mode ?? 'update';
  if (!['update', 'recover', 'handoff', 'replace'].includes(String(mode))) throw new OrchestrationError(400, 'orchestration-invalid', 'Invalid orchestration mode');
  return { expectedRevision: body.expectedRevision as number, mode: mode as TOrchestrationMode };
};

export const requireOrchestrationRevision = (current: IWorkspaceOrchestration, expected: number): void => {
  if (normalizeOrchestration(current).revision !== expected) throw new OrchestrationError(409, 'orchestration-conflict', 'The coordinator changed. Refresh and review the current mapping; do not replay this action.', current);
};
