import fs from 'fs/promises';
import type { ICaller } from '@/lib/caller';
import { FOREIGN_MUTATION_HINT } from '@/lib/cli-error';
import { addressOf, clearAddress, socketPid, type IAddressEntry } from '@/lib/messaging-directory';
import type { TCliScope } from '@/lib/workspace-token';
import type { ITab } from '@/types/terminal';
import type { TCliState } from '@/types/timeline';

// `purplemux tab address` (ADR-0050, S1): a Claude seat's SendMessage address, answered only where `tab send` from the
// same caller passes the drive guard (its own workspace, or the selected Scrum Master), plus the lead-pair arm of the
// owner's ruling of 20 Nov 2026: one workspace's orchestrator may look up another workspace's orchestrator. Any seat
// can list socket paths itself, so the walls stay policy plus audit here, not enforcement.

export const SEND_HINT = 'use `purplemux tab send`; it queues';
export const NOTE_HINT = 'use `purplemux note send`; a note is the route between workspaces';

/** Which arm admitted the caller; null when no arm was reached. */
export type TLookupScope = 'same-workspace' | 'scrum-master' | 'lead-pair';

export interface IAddressLookupDeps {
  addressOn: () => Promise<boolean>;
  leadPairOn: () => Promise<boolean>;
  findTab: (workspaceId: string, tabId: string) => Promise<ITab | null>;
  hasSession: (sessionName: string) => Promise<boolean>;
  /** The workspace's enabled orchestrator is this tab (`leaseAuthority.isWorkspaceOrchestrator`). */
  isWorkspaceOrchestrator: (workspaceId: string, tabId: string) => Promise<boolean>;
  /** ADR-0046: the selected Scrum Master's own audited admission to a foreign workspace. */
  scrumMasterMayMutate: (scope: TCliScope, workspaceId: string) => Promise<boolean>;
  liveStatus: (tabId: string) => { agentSessionId: string | null; cliState: TCliState | null } | null;
  /** Read only: `stat`. */
  socketExists: (socketPath: string) => Promise<boolean>;
  /** Read only: `kill(pid, 0)`. */
  pidAlive: (pid: number) => boolean;
  audit: (entry: Record<string, unknown>) => Promise<unknown>;
}

export interface IAddressLookupAnswer {
  status: number;
  body: Record<string, unknown>;
}

interface ITarget { workspaceId: string; tabId: string }

const refusal = (status: number, code: string, error: string, tabId: string, hint = SEND_HINT): IAddressLookupAnswer =>
  ({ status, body: { error, code, tabId, hint } });

const FORBIDDEN: IAddressLookupAnswer = {
  status: 403,
  body: { error: `Agent mutations are confined to the caller workspace. ${FOREIGN_MUTATION_HINT}`, code: 'forbidden' },
};

/**
 * Why a stored address no longer reaches its session, or null. Local tabs only, and read only: the socket file, the
 * pid in its name, the agent session and the agent state. It never connects to the socket.
 */
const staleReason = async (deps: IAddressLookupDeps, entry: IAddressEntry): Promise<string | null> => {
  const live = deps.liveStatus(entry.tabId);
  if (live?.cliState === 'inactive') return 'agent-inactive';
  if (live?.agentSessionId && entry.agentSessionId && live.agentSessionId !== entry.agentSessionId) return 'session-changed';
  if (entry.host !== null) return null;
  if (!(await deps.socketExists(entry.socketPath))) return 'socket-missing';
  const pid = socketPid(entry.socketPath);
  if (pid !== null && !deps.pidAlive(pid)) return 'process-dead';
  return null;
};

/** The lead-pair arm: a verified caller that is its workspace's orchestrator, and a target that is its own's. */
const isLeadPair = async (deps: IAddressLookupDeps, caller: ICaller, target: ITarget): Promise<boolean> =>
  caller.verified && !!caller.workspaceId && !!caller.tabId
  && await deps.isWorkspaceOrchestrator(caller.workspaceId, caller.tabId)
  && await deps.isWorkspaceOrchestrator(target.workspaceId, target.tabId);

const decide = async (
  deps: IAddressLookupDeps,
  caller: ICaller | null,
  target: ITarget,
  admitted: { scope: TLookupScope | null },
): Promise<IAddressLookupAnswer> => {
  const { tabId } = target;
  if (!target.workspaceId) return { status: 400, body: { error: 'workspaceId is required', code: 'invalid-request' } };
  if (!caller || caller.admin || caller.scope.type !== 'workspace' || !caller.workspaceId) return FORBIDDEN;
  if (!(await deps.addressOn())) return refusal(409, 'address-disabled', 'address lookups are off (fleet key tab-address)', tabId);
  if (!caller.tabId) return refusal(409, 'caller-unresolved', 'the caller names no tab: look up from a purplemux tab', tabId);
  const callerTab = await deps.findTab(caller.workspaceId, caller.tabId);
  if (callerTab?.panelType !== 'claude-code') {
    return refusal(409, 'caller-unresolved', 'the caller is not a resolved Claude tab', tabId);
  }

  if (caller.workspaceId === target.workspaceId) admitted.scope = 'same-workspace';
  else if (await deps.scrumMasterMayMutate(caller.scope, target.workspaceId)) admitted.scope = 'scrum-master';
  else if (!(await deps.leadPairOn())) {
    return refusal(409, 'address-disabled', 'lookups between workspaces are off (fleet key tab-address.lead-pair)', tabId, NOTE_HINT);
  } else if (await isLeadPair(deps, caller, target)) admitted.scope = 'lead-pair';
  else {
    return refusal(403, 'address-not-lead-pair',
      'between workspaces, only one workspace\'s orchestrator may look up another workspace\'s orchestrator', tabId, NOTE_HINT);
  }

  const tab = await deps.findTab(target.workspaceId, target.tabId);
  if (!tab) return refusal(404, 'tab-not-found', 'Tab not found', tabId);
  if (tab.panelType !== 'claude-code') return refusal(409, 'address-not-claude', `tab ${tabId} is not a Claude tab; it has no SendMessage address`, tabId);
  if ((callerTab.host ?? null) !== (tab.host ?? null)) {
    return refusal(409, 'address-other-host', 'the caller and the target run on different hosts; a socket reaches its own host only', tabId);
  }
  if (!(await deps.hasSession(tab.sessionName))) {
    clearAddress(target.workspaceId, tabId);
    return refusal(409, 'session-not-running', 'session-not-running', tabId);
  }
  const entry = addressOf(target.workspaceId, tabId);
  if (!entry) {
    return refusal(409, 'address-unknown', `tab ${tabId} has not registered an address yet (it does at its next turn start)`, tabId);
  }
  const stale = await staleReason(deps, entry);
  if (stale) {
    clearAddress(target.workspaceId, tabId);
    return refusal(409, 'address-stale', `the registered address no longer reaches its session (${stale}); the entry is cleared`, tabId);
  }
  const callerMode = addressOf(caller.workspaceId, caller.tabId)?.permissionMode ?? 'unknown';
  if (entry.permissionMode === 'bypassPermissions' && callerMode !== 'unknown' && callerMode !== 'bypassPermissions') {
    return refusal(409, 'address-class-mismatch',
      'the target skips permission prompts and the caller does not: it would hold the message for approval', tabId);
  }
  return {
    status: 200,
    body: {
      tabId, workspaceId: target.workspaceId, address: entry.address, permissionMode: entry.permissionMode,
      registeredAt: entry.registeredAt, lastSeenAt: entry.lastSeenAt,
    },
  };
};

/**
 * One lookup, and one `address-lookup` audit line for it, admitted, refused or failed. No address or body is audited.
 * The line is written in a `finally`. The walls for S1 are policy plus audit, so an admitted lookup whose line did not
 * write is refused `address-audit-failed` (review N2): no address leaves the server unrecorded.
 */
export const lookupAddress = async (deps: IAddressLookupDeps, caller: ICaller | null, target: ITarget): Promise<IAddressLookupAnswer> => {
  const admitted: { scope: TLookupScope | null } = { scope: null };
  let answer: IAddressLookupAnswer | null = null;
  let written = false;
  try {
    answer = await decide(deps, caller, target, admitted);
  } finally {
    written = (await deps.audit({
      event: 'address-lookup',
      caller: { workspaceId: caller?.workspaceId ?? null, tabId: caller?.tabId ?? null, admin: caller?.admin ?? false },
      target: { workspaceId: target.workspaceId, tabId: target.tabId },
      scope: admitted.scope,
      outcome: answer === null ? 'error' : answer.status === 200 ? 'admitted' : String(answer.body.code),
    }).catch(() => false)) !== false;
  }
  if (answer.status === 200 && !written) {
    return refusal(409, 'address-audit-failed', 'the lookup could not be audited, so no address is answered', target.tabId);
  }
  return answer;
};

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

export const defaultAddressLookupDeps = async (): Promise<IAddressLookupDeps> => {
  const [{ findTab, selectedScrumMasterMayMutate }, { hasSessionOrUnreachable }, { leaseAuthority }, { getStatusManager }, { appendCoordinationAudit }, switches]
    = await Promise.all([
      import('@/lib/cli-utils'),
      import('@/lib/tmux'),
      import('@/lib/lease-http'),
      import('@/lib/status-manager'),
      import('@/lib/coordination-audit'),
      import('@/lib/delivery-switches'),
    ]);
  return {
    addressOn: switches.addressLookupOn,
    leadPairOn: switches.leadPairLookupOn,
    findTab: async (workspaceId, tabId) => (await findTab(workspaceId, tabId))?.tab ?? null,
    hasSession: hasSessionOrUnreachable,
    isWorkspaceOrchestrator: leaseAuthority.isWorkspaceOrchestrator,
    scrumMasterMayMutate: (scope, workspaceId) => selectedScrumMasterMayMutate(scope, workspaceId, `/api/cli/tabs/address`),
    liveStatus: (tabId) => {
      const entry = getStatusManager().getAllForClient()[tabId];
      return entry ? { agentSessionId: entry.agentSessionId ?? null, cliState: entry.cliState ?? null } : null;
    },
    socketExists: async (socketPath) => fs.stat(socketPath).then(() => true, () => false),
    pidAlive,
    audit: appendCoordinationAudit,
  };
};
