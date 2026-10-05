import type {
  IOrchestratorPresenceFacts,
  IOrchestratorPresenceIssue,
  TOrchestratorPresenceState,
  TWorkspaceWorkState,
} from '@/types/coordination';

export type TOrchestratorPresenceSnapshot =
  | { state: 'pending' }
  | { state: 'ready'; checkedAt: number; issues: IOrchestratorPresenceIssue[] };

const ACTIVE_WORK_STATES = new Set(['busy', 'needs-input', 'ready-for-review']);
const USABLE_ORCHESTRATOR_STATES = new Set(['busy', 'idle', 'needs-input', 'ready-for-review']);

const workStateOf = (facts: IOrchestratorPresenceFacts): { state: TWorkspaceWorkState; evidence: string[] } => {
  const evidence: string[] = [];
  let remaining = false;
  let unknown = false;

  if (facts.epicLeases === null) {
    unknown = true;
    evidence.push('epic leases unreadable');
  } else if (facts.epicLeases.length > 0) {
    remaining = true;
    evidence.push(`active epic lease${facts.epicLeases.length === 1 ? '' : 's'}: ${facts.epicLeases.join(', ')}`);
  }

  if (facts.standupState === undefined) {
    unknown = true;
    evidence.push('latest standup unreadable');
  } else if (facts.standupState !== null && facts.standupState !== 'done') {
    remaining = true;
    evidence.push(`latest standup is ${facts.standupState}`);
  }

  if (facts.tabs === null) {
    unknown = true;
    evidence.push('workspace tabs unreadable');
  } else {
    const active = facts.tabs.filter((tab) => tab.isAgent && tab.cliState !== null && ACTIVE_WORK_STATES.has(tab.cliState));
    if (active.length > 0) {
      remaining = true;
      evidence.push(`active agent tab${active.length === 1 ? '' : 's'}: ${active.map((tab) => tab.tabId).join(', ')}`);
    }
    if (facts.tabs.some((tab) => tab.isAgent && (tab.cliState === null || tab.cliState === 'unknown'))) {
      unknown = true;
      evidence.push('agent work state unknown');
    }
    // An idle agent is not proof of completion. A final done standup is the
    // explicit completion evidence that allows an otherwise quiet tab to stay quiet.
    if (facts.standupState !== 'done' && facts.tabs.some((tab) => tab.isAgent && tab.cliState === 'idle')) {
      unknown = true;
      evidence.push('idle agent does not prove completion');
    }
  }

  if (facts.liveBackgroundTabIds === null) {
    unknown = true;
    evidence.push('registered background work unreadable');
  } else if (facts.liveBackgroundTabIds.length > 0) {
    remaining = true;
    evidence.push(`live registered background work: ${facts.liveBackgroundTabIds.join(', ')}`);
  }

  if (remaining) return { state: 'remaining', evidence };
  if (unknown) return { state: 'unknown', evidence };
  return { state: 'complete', evidence };
};

const orchestratorStateOf = (facts: IOrchestratorPresenceFacts): TOrchestratorPresenceState => {
  if (!facts.orchestration?.enabled) return 'disabled';
  const designated = facts.orchestration.orchestratorTabId;
  if (!designated) return 'missing';
  if (facts.tabs === null) return 'unknown';
  const tab = facts.tabs.find((candidate) => candidate.tabId === designated);
  if (!tab || !tab.isAgent || tab.cliState === 'inactive') return 'dead';
  if (tab.cliState === null || tab.cliState === 'unknown') return 'unknown';
  return USABLE_ORCHESTRATOR_STATES.has(tab.cliState) ? 'usable' : 'unknown';
};

const missingReason = (state: TOrchestratorPresenceState): string => {
  switch (state) {
    case 'disabled': return 'Orchestration is disabled while work remains. Select a local orchestrator in the workspace.';
    case 'missing': return 'Work remains but no orchestrator is designated. Select a local orchestrator in the workspace.';
    case 'dead': return 'The designated orchestrator is closed or its agent is not running. Select a safe local replacement in the workspace.';
    case 'unknown': return 'The designated orchestrator liveness is unknown. Verify it before changing the designation.';
    case 'usable': return '';
  }
};

const uncertainReason = (
  workState: TWorkspaceWorkState,
  orchestratorState: TOrchestratorPresenceState,
): string => {
  if (orchestratorState === 'unknown') return missingReason(orchestratorState);
  if (workState === 'unknown') {
    if (orchestratorState === 'usable') return 'Work completion evidence is incomplete. Coverage remains uncertain.';
    return `Work completion evidence is incomplete and ${orchestratorState === 'disabled'
      ? 'orchestration is disabled'
      : orchestratorState === 'missing'
        ? 'no orchestrator is designated'
        : 'the designated orchestrator is not live'}. Verify the evidence before changing the designation.`;
  }
  return missingReason(orchestratorState);
};

export const evaluateOrchestratorPresence = (
  facts: IOrchestratorPresenceFacts,
  observedAt: number,
): IOrchestratorPresenceIssue | null => {
  const work = workStateOf(facts);
  const orchestratorState = orchestratorStateOf(facts);
  if (work.state === 'complete' || (work.state === 'remaining' && orchestratorState === 'usable')) return null;

  const confirmedMissing = work.state === 'remaining'
    && (orchestratorState === 'missing' || orchestratorState === 'disabled' || orchestratorState === 'dead');
  const reason = confirmedMissing
    ? missingReason(orchestratorState)
    : uncertainReason(work.state, orchestratorState);

  return {
    workspaceId: facts.workspaceId,
    workspaceName: facts.workspaceName,
    state: confirmedMissing ? 'missing' : 'uncertain',
    workState: work.state,
    orchestratorState,
    designatedTabId: facts.orchestration?.orchestratorTabId ?? null,
    evidence: work.evidence,
    reason,
    observedAt,
  };
};

export class OrchestratorPresenceMonitor {
  private snapshotValue: TOrchestratorPresenceSnapshot = { state: 'pending' };
  private missingEpisodes = new Set<string>();

  reconcile(facts: IOrchestratorPresenceFacts[], observedAt = Date.now()): IOrchestratorPresenceIssue[] {
    const issues = facts
      .map((workspace) => evaluateOrchestratorPresence(workspace, observedAt))
      .filter((issue): issue is IOrchestratorPresenceIssue => issue !== null);
    const issueByWorkspace = new Map(issues.map((issue) => [issue.workspaceId, issue]));
    const observedWorkspaces = new Set(facts.map((workspace) => workspace.workspaceId));
    const notify: IOrchestratorPresenceIssue[] = [];

    for (const issue of issues) {
      if (issue.state !== 'missing' || this.missingEpisodes.has(issue.workspaceId)) continue;
      this.missingEpisodes.add(issue.workspaceId);
      notify.push(issue);
    }
    for (const workspace of facts) {
      const issue = issueByWorkspace.get(workspace.workspaceId);
      // Only confirmed recovery or completion rearms the episode. An uncertain
      // read cannot turn the dashboard green or cause a second alert on return.
      if (!issue) this.missingEpisodes.delete(workspace.workspaceId);
    }
    for (const workspaceId of [...this.missingEpisodes]) {
      if (!observedWorkspaces.has(workspaceId)) this.missingEpisodes.delete(workspaceId);
    }

    this.snapshotValue = { state: 'ready', checkedAt: observedAt, issues };
    return notify;
  }

  snapshot(): TOrchestratorPresenceSnapshot {
    if (this.snapshotValue.state === 'pending') return this.snapshotValue;
    return {
      state: 'ready',
      checkedAt: this.snapshotValue.checkedAt,
      issues: this.snapshotValue.issues.map((issue) => ({ ...issue, evidence: [...issue.evidence] })),
    };
  }
}

const g = globalThis as unknown as { __ptOrchestratorPresenceMonitor?: OrchestratorPresenceMonitor };

export const getOrchestratorPresenceMonitor = (): OrchestratorPresenceMonitor => {
  if (!g.__ptOrchestratorPresenceMonitor) g.__ptOrchestratorPresenceMonitor = new OrchestratorPresenceMonitor();
  return g.__ptOrchestratorPresenceMonitor;
};
