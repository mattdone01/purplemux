import fs from 'fs/promises';
import path from 'path';
import { nanoid } from 'nanoid';
import { findTab } from '@/lib/cli-utils';
import { mutateTabAtomically } from '@/lib/layout-store';
import {
  getChildPids,
  getProcessArgv,
  getProcessStartTimeMs,
  isProcessRunning,
} from '@/lib/process-utils';
import { getSessionPanePid } from '@/lib/tmux';
import {
  CODEX_LAUNCHER_SCRIPT,
  codexProvider,
} from '@/lib/providers/codex';
import { findCodexSessionById } from '@/lib/providers/codex/session-detection';
import type {
  IAgentLaunchConfig,
  ICodexActiveLaunch,
  ICodexLaunchObservationBoundary,
  ICodexLaunchProcessIdentity,
  ICodexPendingLaunch,
  ITab,
} from '@/types/terminal';

const PROCESS_PROOF_ATTEMPTS = 5;
const PROCESS_PROOF_RETRY_MS = 40;
const MAX_PROCESS_TREE_NODES = 128;
export const CODEX_LAUNCH_PREPARED_TIMEOUT_MS = 60_000;
export const CODEX_LAUNCH_SUBMITTED_TIMEOUT_MS = 15_000;

interface ICodexLaunchLifecycleGlobal {
  targetLocks: Map<string, Promise<void>>;
}

const g = globalThis as unknown as { __ptCodexLaunchLifecycle?: ICodexLaunchLifecycleGlobal };
if (!g.__ptCodexLaunchLifecycle) g.__ptCodexLaunchLifecycle = { targetLocks: new Map() };
const state = g.__ptCodexLaunchLifecycle;

export interface ICodexLaunchIntent {
  generation: string;
  workspaceId: string;
  tabId: string;
  sessionName: string;
  resumeSessionId: string | null;
  launchedConfig: IAgentLaunchConfig;
}

export interface IBeginCodexLaunchOptions {
  resumeSessionId?: string | null;
  transitionToCodexPanel?: boolean;
}

export type TCodexLaunchTransitionResult =
  | { ok: true; state: 'prepared' | 'submitted' | 'held'; intent: ICodexLaunchIntent }
  | { ok: false; state: 'not-found' | 'stale' | 'invalid'; reason: string };

export interface ICodexLaunchReceipt {
  workspaceId: string;
  tabId: string;
  generation: string;
  launcherPid: number;
  childPid: number;
}

export type TCodexLaunchConfirmationResult =
  | { ok: true; state: 'confirmed' | 'duplicate' | 'revalidated'; active: ICodexActiveLaunch }
  | { ok: false; state: 'not-found' | 'stale' | 'held'; reason: string };

export type TCodexRuntimeVerification =
  | { ok: true; launcher: ICodexLaunchProcessIdentity; agent: ICodexLaunchProcessIdentity }
  | { ok: false; reason: string };

export type TCodexBootstrapClaimResult =
  | { ok: true; generation: string }
  | { ok: false; reason: string; modelStatus?: import('./model-observation').ICodexModelStatus };

const targetKey = (workspaceId: string, tabId: string): string => `${workspaceId}\0${tabId}`;

export const withCodexTargetLock = async <T>(
  workspaceId: string,
  tabId: string,
  work: () => Promise<T>,
): Promise<T> => {
  const key = targetKey(workspaceId, tabId);
  const previous = state.targetLocks.get(key) ?? Promise.resolve();
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const current = previous.then(() => gate);
  state.targetLocks.set(key, current);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (state.targetLocks.get(key) === current) state.targetLocks.delete(key);
  }
};

const launchConfig = (tab: ITab): IAgentLaunchConfig => ({
  ...(tab.agentLaunchConfig?.model ? { model: tab.agentLaunchConfig.model } : {}),
  ...(tab.agentLaunchConfig?.effort ? { effort: tab.agentLaunchConfig.effort } : {}),
});

const sameLaunchConfig = (left: IAgentLaunchConfig, right: IAgentLaunchConfig): boolean =>
  (left.model ?? null) === (right.model ?? null)
  && (left.effort ?? null) === (right.effort ?? null);

const intentFromPending = (pending: ICodexPendingLaunch): ICodexLaunchIntent => ({
  generation: pending.generation,
  workspaceId: pending.workspaceId,
  tabId: pending.tabId,
  sessionName: pending.sessionName,
  resumeSessionId: pending.resumeSessionId,
  launchedConfig: { ...pending.launchedConfig },
});

const observationBoundaryForResume = async (
  resumeSessionId: string | null,
): Promise<ICodexLaunchObservationBoundary | null> => {
  if (!resumeSessionId) return null;
  try {
    const session = await findCodexSessionById(resumeSessionId);
    if (!session?.jsonlPath) return null;
    const stat = await fs.stat(session.jsonlPath);
    if (!stat.isFile()) return null;
    return {
      sessionId: resumeSessionId,
      jsonlPath: session.jsonlPath,
      byteOffset: stat.size,
    };
  } catch {
    return null;
  }
};

export const beginCodexLaunchLocked = async (
  workspaceId: string,
  tabId: string,
  options: IBeginCodexLaunchOptions = {},
): Promise<TCodexLaunchTransitionResult> => {
  const resumeSessionId = options.resumeSessionId?.trim() || null;
  if (resumeSessionId && !codexProvider.isValidSessionId(resumeSessionId)) {
    return { ok: false, state: 'invalid', reason: 'invalid-resume-session' };
  }
  const boundary = await observationBoundaryForResume(resumeSessionId);
  const generation = `codex-${nanoid(24)}`;
  const result = await mutateTabAtomically(workspaceId, tabId, (tab) => {
    const mayTransition = options.transitionToCodexPanel === true
      && (tab.panelType === 'terminal' || tab.panelType === 'agent-sessions');
    if (tab.panelType !== 'codex-cli' && !mayTransition) {
      return { changed: false, value: null as ICodexLaunchIntent | null };
    }
    if (mayTransition) tab.panelType = 'codex-cli';
    const previous = tab.codexLaunchRuntime?.active;
    const pending: ICodexPendingLaunch = {
      generation,
      workspaceId,
      tabId,
      sessionName: tab.sessionName,
      resumeSessionId,
      launchedConfig: launchConfig(tab),
      observationBoundary: boundary,
      priorLauncher: previous?.launcher ?? null,
      priorAgent: previous?.agent ?? null,
      phase: 'prepared',
      preparedAt: new Date().toISOString(),
    };
    tab.codexLaunchRuntime = {
      ...(previous ? { active: previous } : {}),
      pending,
    };
    return { changed: true, value: intentFromPending(pending) };
  });
  if (!result.found) return { ok: false, state: 'not-found', reason: 'tab-not-found' };
  if (!result.value) return { ok: false, state: 'invalid', reason: 'not-codex-tab' };
  return { ok: true, state: 'prepared', intent: result.value };
};

export const beginCodexLaunch = (
  workspaceId: string,
  tabId: string,
  options: IBeginCodexLaunchOptions = {},
): Promise<TCodexLaunchTransitionResult> =>
  withCodexTargetLock(workspaceId, tabId, () => beginCodexLaunchLocked(workspaceId, tabId, options));

const transitionPending = async (
  workspaceId: string,
  tabId: string,
  generation: string,
  phase: 'submitted' | 'held',
  reason?: string,
): Promise<TCodexLaunchTransitionResult> => {
  const result = await mutateTabAtomically(workspaceId, tabId, (tab) => {
    const pending = tab.codexLaunchRuntime?.pending;
    if (!pending || pending.generation !== generation || pending.phase === 'held') {
      return { changed: false, value: null as ICodexLaunchIntent | null };
    }
    pending.phase = phase;
    if (phase === 'submitted') pending.submittedAt = new Date().toISOString();
    if (phase === 'held') pending.heldReason = reason || 'launch-failed';
    return { changed: true, value: intentFromPending(pending) };
  });
  if (!result.found) return { ok: false, state: 'not-found', reason: 'tab-not-found' };
  if (!result.value) return { ok: false, state: 'stale', reason: 'launch-generation-not-current' };
  return { ok: true, state: phase, intent: result.value };
};

export const markCodexLaunchSubmittedLocked = (
  workspaceId: string,
  tabId: string,
  generation: string,
): Promise<TCodexLaunchTransitionResult> =>
  transitionPending(workspaceId, tabId, generation, 'submitted');

export const markCodexLaunchSubmitted = (
  workspaceId: string,
  tabId: string,
  generation: string,
): Promise<TCodexLaunchTransitionResult> =>
  withCodexTargetLock(workspaceId, tabId, () =>
    markCodexLaunchSubmittedLocked(workspaceId, tabId, generation));

export const holdCodexLaunchLocked = (
  workspaceId: string,
  tabId: string,
  generation: string,
  reason: string,
): Promise<TCodexLaunchTransitionResult> =>
  transitionPending(workspaceId, tabId, generation, 'held', reason);

export const holdCodexLaunch = (
  workspaceId: string,
  tabId: string,
  generation: string,
  reason: string,
): Promise<TCodexLaunchTransitionResult> =>
  withCodexTargetLock(workspaceId, tabId, () =>
    holdCodexLaunchLocked(workspaceId, tabId, generation, reason));

export const reconcileCodexLaunchTimeout = (
  workspaceId: string,
  tabId: string,
  nowMs = Date.now(),
): Promise<TCodexLaunchTransitionResult | null> =>
  withCodexTargetLock(workspaceId, tabId, async () => {
    const found = await findTab(workspaceId, tabId);
    const pending = found?.tab.codexLaunchRuntime?.pending;
    if (!pending || pending.phase === 'held') return null;
    const since = Date.parse(pending.phase === 'submitted'
      ? pending.submittedAt ?? pending.preparedAt
      : pending.preparedAt);
    const timeout = pending.phase === 'submitted'
      ? CODEX_LAUNCH_SUBMITTED_TIMEOUT_MS
      : CODEX_LAUNCH_PREPARED_TIMEOUT_MS;
    if (!Number.isFinite(since) || nowMs - since < timeout) return null;
    return holdCodexLaunchLocked(
      workspaceId,
      tabId,
      pending.generation,
      pending.phase === 'submitted' ? 'launch-confirmation-timeout' : 'launch-submission-timeout',
    );
  });

export const resolveCodexLaunchIntent = async (
  workspaceId: string,
  tabId: string,
  generation: string,
  sessionName: string,
): Promise<ICodexLaunchIntent | null> => {
  const found = await findTab(workspaceId, tabId);
  const pending = found?.tab.codexLaunchRuntime?.pending;
  if (!pending || pending.generation !== generation || pending.sessionName !== sessionName) return null;
  if (pending.workspaceId !== workspaceId || pending.tabId !== tabId || pending.phase === 'held') return null;
  return intentFromPending(pending);
};

export const resolvePreparedCodexLaunchIntent = async (
  workspaceId: string,
  tabId: string,
  generation: string,
  sessionName: string,
): Promise<ICodexLaunchIntent | null> => {
  const found = await findTab(workspaceId, tabId);
  const pending = found?.tab.codexLaunchRuntime?.pending;
  if (!pending || pending.phase !== 'prepared') return null;
  return resolveCodexLaunchIntent(workspaceId, tabId, generation, sessionName);
};

const processIdentity = async (pid: number): Promise<ICodexLaunchProcessIdentity | null> => {
  if (!Number.isInteger(pid) || pid <= 1 || !(await isProcessRunning(pid))) return null;
  const startedAtMs = await getProcessStartTimeMs(pid, { timeoutMs: 1_000 });
  return startedAtMs === null ? null : { pid, startedAtMs };
};

const sameProcess = (left: ICodexLaunchProcessIdentity, right: ICodexLaunchProcessIdentity): boolean =>
  left.pid === right.pid && left.startedAtMs === right.startedAtMs;

const isIdentityAlive = async (identity: ICodexLaunchProcessIdentity): Promise<boolean> => {
  const current = await processIdentity(identity.pid);
  return current !== null && sameProcess(current, identity);
};

const collectDescendants = async (rootPid: number): Promise<number[] | null> => {
  const result: number[] = [];
  const queue = [rootPid];
  const seen = new Set(queue);
  while (queue.length > 0) {
    const parent = queue.shift()!;
    const children = await getChildPids(parent);
    for (const child of children) {
      if (seen.has(child)) continue;
      seen.add(child);
      result.push(child);
      if (result.length > MAX_PROCESS_TREE_NODES) return null;
      queue.push(child);
    }
  }
  return result;
};

const flagValue = (argv: string[], flag: string): string | null => {
  const indexes = argv.flatMap((value, index) => value === flag ? [index] : []);
  if (indexes.length !== 1) return null;
  return argv[indexes[0] + 1] ?? null;
};

const isExpectedLauncher = (
  argv: string[],
  pending: Pick<ICodexPendingLaunch, 'generation' | 'workspaceId' | 'tabId' | 'sessionName'>,
): boolean => argv.length >= 2
  && ['node', 'nodejs'].includes(path.basename(argv[0]))
  && path.resolve(argv[1]) === path.resolve(CODEX_LAUNCHER_SCRIPT)
  && flagValue(argv, '--generation') === pending.generation
  && flagValue(argv, '--workspace-id') === pending.workspaceId
  && flagValue(argv, '--tab-id') === pending.tabId
  && flagValue(argv, '--session-name') === pending.sessionName;

const isCodexCli = (argv: string[]): boolean => {
  const executable = path.basename(argv[0] ?? '');
  return executable === 'codex' || path.basename(argv[1] ?? '') === 'codex.js';
};

const includesPair = (argv: string[], first: string, second: string): boolean =>
  argv.some((value, index) => value === first && argv[index + 1] === second);

const matchesIssuedPolicy = (argv: string[], pending: ICodexPendingLaunch): boolean => {
  const modelValues = argv.flatMap((value, index) => value === '--model' ? [argv[index + 1]] : []);
  if (pending.launchedConfig.model) {
    if (modelValues.length !== 1 || modelValues[0] !== pending.launchedConfig.model) return false;
  } else if (modelValues.length > 0) return false;

  const effortValues = argv.flatMap((value, index) =>
    value === '-c' && argv[index + 1]?.startsWith('model_reasoning_effort=')
      ? [argv[index + 1].slice('model_reasoning_effort='.length)]
      : []);
  if (pending.launchedConfig.effort) {
    if (effortValues.length !== 1 || effortValues[0] !== pending.launchedConfig.effort) return false;
  } else if (effortValues.length > 0) return false;

  if (pending.resumeSessionId) return includesPair(argv, 'resume', pending.resumeSessionId);
  return !argv.includes('resume');
};

const verifyProcessProofOnce = async (
  tab: ITab,
  pending: ICodexPendingLaunch,
  launcherPid: number,
  childPid: number,
): Promise<TCodexRuntimeVerification> => {
  if (launcherPid === childPid) return { ok: false, reason: 'invalid-process-identity' };
  const panePid = await getSessionPanePid(tab.sessionName);
  if (panePid === null) return { ok: false, reason: 'pane-process-unavailable' };
  const descendants = await collectDescendants(panePid);
  if (!descendants) return { ok: false, reason: 'ambiguous-process-tree' };
  if (!descendants.includes(launcherPid) || !descendants.includes(childPid)) {
    return { ok: false, reason: 'process-lineage-mismatch' };
  }
  const directChildren = await getChildPids(launcherPid);
  if (!directChildren.includes(childPid)) return { ok: false, reason: 'agent-not-launcher-child' };

  const [launcher, agent, launcherArgv, agentArgv] = await Promise.all([
    processIdentity(launcherPid),
    processIdentity(childPid),
    getProcessArgv(launcherPid),
    getProcessArgv(childPid),
  ]);
  if (!launcher || !agent || !launcherArgv || !agentArgv) {
    return { ok: false, reason: 'process-identity-unavailable' };
  }
  if (!isExpectedLauncher(launcherArgv, pending)) return { ok: false, reason: 'launcher-identity-mismatch' };
  if (!isCodexCli(agentArgv) || !matchesIssuedPolicy(agentArgv, pending)) {
    return { ok: false, reason: 'agent-command-mismatch' };
  }
  if (pending.priorLauncher && await isIdentityAlive(pending.priorLauncher)) {
    return { ok: false, reason: 'prior-runtime-still-active' };
  }
  if (pending.priorAgent && await isIdentityAlive(pending.priorAgent)) {
    return { ok: false, reason: 'prior-runtime-still-active' };
  }

  const launcherCandidates: number[] = [];
  for (const pid of descendants) {
    const argv = await getProcessArgv(pid);
    if (argv && argv.length >= 2 && path.resolve(argv[1]) === path.resolve(CODEX_LAUNCHER_SCRIPT)) {
      launcherCandidates.push(pid);
    }
  }
  if (launcherCandidates.length !== 1 || launcherCandidates[0] !== launcherPid) {
    return { ok: false, reason: 'competing-launcher-process' };
  }
  const agentDescendants = await collectDescendants(childPid);
  if (!agentDescendants) return { ok: false, reason: 'ambiguous-process-tree' };
  const agentLineage = new Set([childPid, ...agentDescendants]);
  for (const pid of descendants) {
    if (agentLineage.has(pid)) continue;
    const argv = await getProcessArgv(pid);
    if (argv && isCodexCli(argv)) return { ok: false, reason: 'competing-agent-process' };
  }
  return { ok: true, launcher, agent };
};

const verifyProcessProof = async (
  tab: ITab,
  pending: ICodexPendingLaunch,
  launcherPid: number,
  childPid: number,
): Promise<TCodexRuntimeVerification> => {
  let result: TCodexRuntimeVerification = { ok: false, reason: 'process-identity-unavailable' };
  for (let attempt = 0; attempt < PROCESS_PROOF_ATTEMPTS; attempt += 1) {
    result = await verifyProcessProofOnce(tab, pending, launcherPid, childPid);
    if (result.ok) return result;
    if (result.reason !== 'process-identity-unavailable') return result;
    if (attempt + 1 < PROCESS_PROOF_ATTEMPTS) {
      await new Promise<void>((resolve) => setTimeout(resolve, PROCESS_PROOF_RETRY_MS));
    }
  }
  return result;
};

const pendingFromActive = (active: ICodexActiveLaunch): ICodexPendingLaunch => ({
  generation: active.generation,
  workspaceId: active.workspaceId,
  tabId: active.tabId,
  sessionName: active.sessionName,
  resumeSessionId: active.resumeSessionId,
  launchedConfig: active.launchedConfig,
  observationBoundary: active.observationBoundary,
  priorLauncher: null,
  priorAgent: null,
  phase: 'submitted',
  preparedAt: active.confirmedAt,
  submittedAt: active.confirmedAt,
});

export const verifyCodexActiveRuntime = async (tab: ITab): Promise<TCodexRuntimeVerification> => {
  const active = tab.codexLaunchRuntime?.active;
  if (!active || active.phase !== 'active' || tab.codexLaunchRuntime?.pending) {
    return { ok: false, reason: 'launch-runtime-unavailable' };
  }
  return verifyRecordedCodexRuntime(tab, active);
};

const verifyRecordedCodexRuntime = async (
  tab: ITab,
  active: ICodexActiveLaunch,
): Promise<TCodexRuntimeVerification> => {
  const proof = await verifyProcessProof(tab, pendingFromActive(active), active.launcher.pid, active.agent.pid);
  if (!proof.ok) return proof;
  if (!sameProcess(proof.launcher, active.launcher) || !sameProcess(proof.agent, active.agent)) {
    return { ok: false, reason: 'process-identity-replaced' };
  }
  return proof;
};

interface ICodexRevalidationSnapshot {
  active: ICodexActiveLaunch;
  sessionId: string | null;
  jsonlPath: string | null;
  desiredConfig: IAgentLaunchConfig;
}

const cloneActiveLaunch = (active: ICodexActiveLaunch): ICodexActiveLaunch => ({
  ...active,
  launchedConfig: { ...active.launchedConfig },
  observationBoundary: active.observationBoundary ? { ...active.observationBoundary } : null,
  launcher: { ...active.launcher },
  agent: { ...active.agent },
});

const sameObservationBoundary = (
  left: ICodexLaunchObservationBoundary | null,
  right: ICodexLaunchObservationBoundary | null,
): boolean => left === right || (!!left && !!right
  && left.sessionId === right.sessionId
  && left.jsonlPath === right.jsonlPath
  && left.byteOffset === right.byteOffset);

const sameActiveLaunch = (left: ICodexActiveLaunch, right: ICodexActiveLaunch): boolean =>
  left.generation === right.generation
  && left.workspaceId === right.workspaceId
  && left.tabId === right.tabId
  && left.sessionName === right.sessionName
  && left.resumeSessionId === right.resumeSessionId
  && sameLaunchConfig(left.launchedConfig, right.launchedConfig)
  && sameObservationBoundary(left.observationBoundary, right.observationBoundary)
  && sameProcess(left.launcher, right.launcher)
  && sameProcess(left.agent, right.agent)
  && left.phase === right.phase
  && left.bootstrap === right.bootstrap
  && left.confirmedAt === right.confirmedAt
  && left.heldReason === right.heldReason;

const revalidateHeldCodexRuntime = async (
  receipt: ICodexLaunchReceipt,
  tab: ITab,
  active: ICodexActiveLaunch,
): Promise<TCodexLaunchConfirmationResult> => {
  if (active.heldReason !== 'process-identity-unavailable') {
    return { ok: false, state: 'held', reason: active.heldReason ?? 'launch-runtime-held' };
  }
  const snapshot: ICodexRevalidationSnapshot = {
    active: cloneActiveLaunch(active),
    sessionId: codexProvider.readSessionId(tab),
    jsonlPath: codexProvider.readJsonlPath(tab),
    desiredConfig: launchConfig(tab),
  };
  if (!sameLaunchConfig(snapshot.active.launchedConfig, snapshot.desiredConfig)) {
    return { ok: false, state: 'held', reason: 'launch-policy-changed' };
  }
  const proof = await verifyRecordedCodexRuntime(tab, snapshot.active);
  if (!proof.ok) return { ok: false, state: 'held', reason: proof.reason };

  const committed = await mutateTabAtomically(receipt.workspaceId, receipt.tabId, (current) => {
    const currentActive = current.codexLaunchRuntime?.active;
    const unchanged = !!currentActive
      && !current.codexLaunchRuntime?.pending
      && sameActiveLaunch(currentActive, snapshot.active)
      && codexProvider.readSessionId(current) === snapshot.sessionId
      && codexProvider.readJsonlPath(current) === snapshot.jsonlPath
      && sameLaunchConfig(launchConfig(current), snapshot.desiredConfig);
    if (!unchanged) return { changed: false, value: null as ICodexActiveLaunch | null };
    currentActive.phase = 'active';
    delete currentActive.heldReason;
    return { changed: true, value: currentActive };
  });
  if (!committed.found) return { ok: false, state: 'not-found', reason: 'tab-not-found' };
  if (!committed.value) return { ok: false, state: 'stale', reason: 'launch-runtime-changed' };
  return { ok: true, state: 'revalidated', active: committed.value };
};

export const holdCodexActiveGeneration = async (
  workspaceId: string,
  tabId: string,
  generation: string,
  reason: string,
): Promise<void> => {
  await mutateTabAtomically(workspaceId, tabId, (tab) => {
    const active = tab.codexLaunchRuntime?.active;
    if (!active || active.generation !== generation || active.phase === 'held') {
      return { changed: false, value: undefined };
    }
    active.phase = 'held';
    active.heldReason = reason;
    return { changed: true, value: undefined };
  });
};

export const confirmCodexLaunchReceiptLocked = async (
  receipt: ICodexLaunchReceipt,
): Promise<TCodexLaunchConfirmationResult> => {
  const found = await findTab(receipt.workspaceId, receipt.tabId);
  if (!found) return { ok: false, state: 'not-found', reason: 'tab-not-found' };
  const { tab } = found;
  const active = tab.codexLaunchRuntime?.active;
  const pending = tab.codexLaunchRuntime?.pending;
  if (!pending && active?.generation === receipt.generation) {
    if (active.launcher.pid !== receipt.launcherPid || active.agent.pid !== receipt.childPid) {
      return { ok: false, state: 'stale', reason: 'receipt-process-identity-mismatch' };
    }
    if (active.phase === 'held') return revalidateHeldCodexRuntime(receipt, tab, active);
    const proof = await verifyCodexActiveRuntime(tab);
    if (proof.ok) return { ok: true, state: 'duplicate', active };
    await holdCodexActiveGeneration(receipt.workspaceId, receipt.tabId, receipt.generation, proof.reason);
    return { ok: false, state: 'held', reason: proof.reason };
  }
  if (!pending || pending.generation !== receipt.generation || pending.phase === 'held') {
    return { ok: false, state: 'stale', reason: 'launch-generation-not-current' };
  }
  if (pending.workspaceId !== receipt.workspaceId || pending.tabId !== receipt.tabId
    || pending.sessionName !== tab.sessionName) {
    await holdCodexLaunchLocked(receipt.workspaceId, receipt.tabId, receipt.generation, 'launch-identity-mismatch');
    return { ok: false, state: 'held', reason: 'launch-identity-mismatch' };
  }

  const proof = await verifyProcessProof(tab, pending, receipt.launcherPid, receipt.childPid);
  if (!proof.ok) {
    await holdCodexLaunchLocked(receipt.workspaceId, receipt.tabId, receipt.generation, proof.reason);
    return { ok: false, state: 'held', reason: proof.reason };
  }
  const committed = await mutateTabAtomically(receipt.workspaceId, receipt.tabId, (current) => {
    const currentPending = current.codexLaunchRuntime?.pending;
    if (!currentPending || currentPending.generation !== receipt.generation || currentPending.phase === 'held') {
      return { changed: false, value: null as ICodexActiveLaunch | null };
    }
    const next: ICodexActiveLaunch = {
      generation: currentPending.generation,
      workspaceId: currentPending.workspaceId,
      tabId: currentPending.tabId,
      sessionName: currentPending.sessionName,
      resumeSessionId: currentPending.resumeSessionId,
      launchedConfig: { ...currentPending.launchedConfig },
      observationBoundary: currentPending.observationBoundary,
      launcher: proof.launcher,
      agent: proof.agent,
      phase: 'active',
      bootstrap: 'unused',
      confirmedAt: new Date().toISOString(),
    };
    current.codexLaunchRuntime = { active: next };
    codexProvider.writeSessionId(current, currentPending.resumeSessionId);
    codexProvider.writeJsonlPath(current, null);
    codexProvider.writeSummary(current, null);
    current.lastUserMessage = null;
    return { changed: true, value: next };
  });
  if (!committed.found) return { ok: false, state: 'not-found', reason: 'tab-not-found' };
  if (!committed.value) return { ok: false, state: 'stale', reason: 'launch-generation-not-current' };
  return { ok: true, state: 'confirmed', active: committed.value };
};

export const confirmCodexLaunchReceipt = (receipt: ICodexLaunchReceipt): Promise<TCodexLaunchConfirmationResult> =>
  withCodexTargetLock(receipt.workspaceId, receipt.tabId, () => confirmCodexLaunchReceiptLocked(receipt));

export const claimCodexBootstrapLocked = async (
  workspaceId: string,
  tabId: string,
): Promise<TCodexBootstrapClaimResult> => {
  const found = await findTab(workspaceId, tabId);
  if (!found) return { ok: false, reason: 'tab-not-found' };
  const tab = found.tab;
  const active = tab.codexLaunchRuntime?.active;
  if (!active || active.phase !== 'active' || tab.codexLaunchRuntime?.pending) {
    return { ok: false, reason: 'launch-runtime-unavailable' };
  }
  if (active.bootstrap !== 'unused') return { ok: false, reason: 'bootstrap-consumed' };
  if (!sameLaunchConfig(active.launchedConfig, launchConfig(tab))) {
    return { ok: false, reason: 'launch-policy-changed' };
  }
  const { getCodexModelStatus } = await import('./model-observation');
  const modelStatus = await getCodexModelStatus(tab);
  if (modelStatus.status !== 'unknown' || modelStatus.reason !== 'awaiting-first-turn') {
    return { ok: false, reason: 'not-pre-first-turn', modelStatus };
  }

  const claimed = await mutateTabAtomically(workspaceId, tabId, (current) => {
    const currentActive = current.codexLaunchRuntime?.active;
    const eligible = currentActive?.generation === active.generation
      && currentActive.phase === 'active'
      && currentActive.bootstrap === 'unused'
      && !current.codexLaunchRuntime?.pending
      && sameProcess(currentActive.launcher, active.launcher)
      && sameProcess(currentActive.agent, active.agent)
      && sameLaunchConfig(currentActive.launchedConfig, launchConfig(current));
    if (!eligible) return { changed: false, value: false };
    currentActive.bootstrap = 'consumed';
    return { changed: true, value: true };
  });
  return claimed.found && claimed.value
    ? { ok: true, generation: active.generation }
    : { ok: false, reason: 'claim-conflict', modelStatus };
};

export const claimCodexBootstrap = (
  workspaceId: string,
  tabId: string,
): Promise<TCodexBootstrapClaimResult> =>
  withCodexTargetLock(workspaceId, tabId, () => claimCodexBootstrapLocked(workspaceId, tabId));

export interface IValidatedCodexHookGeneration {
  workspaceId: string;
  tabId: string;
  generation: string;
}

export const withValidatedCodexHookGeneration = async <T>(
  sessionName: string,
  generation: string | null | undefined,
  work: (identity: IValidatedCodexHookGeneration) => Promise<T> | T,
): Promise<{ ok: true; value: T } | { ok: false; reason: string }> => {
  if (!generation) return { ok: false, reason: 'generation-required' };
  const parsed = (await import('@/lib/layout-store')).parseSessionName(sessionName);
  if (!parsed) return { ok: false, reason: 'invalid-session-name' };
  return withCodexTargetLock(parsed.wsId, parsed.tabId, async () => {
    const found = await findTab(parsed.wsId, parsed.tabId);
    const active = found?.tab.codexLaunchRuntime?.active;
    if (!found || !active || active.generation !== generation || active.phase !== 'active'
      || found.tab.codexLaunchRuntime?.pending || active.sessionName !== sessionName) {
      return { ok: false, reason: 'generation-not-active' };
    }
    const proof = await verifyCodexActiveRuntime(found.tab);
    if (!proof.ok) {
      await holdCodexActiveGeneration(parsed.wsId, parsed.tabId, generation, proof.reason);
      return { ok: false, reason: proof.reason };
    }
    const value = await work({ workspaceId: parsed.wsId, tabId: parsed.tabId, generation });
    return { ok: true, value };
  });
};

export const validateCodexHookGeneration = async (
  sessionName: string,
  generation: string | null | undefined,
): Promise<{ ok: true } & IValidatedCodexHookGeneration | { ok: false; reason: string }> => {
  const result = await withValidatedCodexHookGeneration(sessionName, generation, (identity) => identity);
  return result.ok ? { ok: true, ...result.value } : result;
};

/**
 * Compatibility gate for a Codex process that predates launch generations.
 * It never creates runtime state or a bootstrap allowance, and stops applying
 * as soon as any managed lifecycle state exists for the tab.
 */
export const withValidatedLegacyCodexHook = async <T>(
  sessionName: string,
  hook: { sessionId?: string | null; jsonlPath?: string | null },
  work: (identity: Omit<IValidatedCodexHookGeneration, 'generation'>) => Promise<T> | T,
): Promise<{ ok: true; value: T } | { ok: false; reason: string }> => {
  const parsed = (await import('@/lib/layout-store')).parseSessionName(sessionName);
  if (!parsed) return { ok: false, reason: 'invalid-session-name' };
  return withCodexTargetLock(parsed.wsId, parsed.tabId, async () => {
    const found = await findTab(parsed.wsId, parsed.tabId);
    if (!found || found.tab.panelType !== 'codex-cli') {
      return { ok: false, reason: 'tab-not-found' };
    }
    if (found.tab.codexLaunchRuntime?.active || found.tab.codexLaunchRuntime?.pending) {
      return { ok: false, reason: 'managed-generation-present' };
    }
    const boundSessionId = codexProvider.readSessionId(found.tab);
    const boundJsonlPath = codexProvider.readJsonlPath(found.tab);
    if (!boundSessionId || !boundJsonlPath || !hook.sessionId || hook.sessionId !== boundSessionId) {
      return { ok: false, reason: 'legacy-session-binding-mismatch' };
    }
    if (hook.jsonlPath && hook.jsonlPath !== boundJsonlPath) {
      return { ok: false, reason: 'legacy-session-binding-mismatch' };
    }
    const { getCodexModelStatus } = await import('./model-observation');
    const modelStatus = await getCodexModelStatus(found.tab);
    if (modelStatus.status !== 'match') {
      return { ok: false, reason: 'legacy-model-unverified' };
    }
    const value = await work({ workspaceId: parsed.wsId, tabId: parsed.tabId });
    return { ok: true, value };
  });
};

export const clearCodexLaunchLifecycleState = (): void => {
  state.targetLocks.clear();
};
