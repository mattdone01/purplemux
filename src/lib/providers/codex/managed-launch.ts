import { buildManagedCodexLaunchCommand } from '@/lib/providers/codex';
import {
  beginCodexLaunch,
  holdCodexLaunch,
  holdCodexLaunchLocked,
  markCodexLaunchSubmittedLocked,
  resolvePreparedCodexLaunchIntent,
  withCodexTargetLock,
  type ICodexLaunchIntent,
} from '@/lib/providers/codex/launch-lifecycle';
import { findTab } from '@/lib/cli-utils';
import { checkTerminalProcess, sendKeys } from '@/lib/tmux';
import { getStatusManager } from '@/lib/status-manager';

export interface IPreparedCodexLaunch extends ICodexLaunchIntent {
  command: string;
}

export type TPrepareCodexLaunchResult =
  | { ok: true; launch: IPreparedCodexLaunch }
  | { ok: false; reason: string };

export type TSubmitCodexLaunchResult =
  | { ok: true; generation: string; phase: 'submitted' }
  | { ok: false; generation: string; phase: 'prepared' | 'held'; reason: string };

export type TCodexLaunchActivationResult =
  | { ok: true; generation: string; phase: 'active' }
  | { ok: false; generation: string; phase: 'submitted' | 'held'; reason: string };

const ACTIVATION_WAIT_ATTEMPTS = 75;
const ACTIVATION_WAIT_INTERVAL_MS = 40;

export const prepareCodexManagedLaunch = async (
  workspaceId: string,
  tabId: string,
  resumeSessionId?: string | null,
): Promise<TPrepareCodexLaunchResult> => {
  const prepared = await beginCodexLaunch(workspaceId, tabId, {
    resumeSessionId,
    transitionToCodexPanel: true,
  });
  if (!prepared.ok) return { ok: false, reason: prepared.reason };
  getStatusManager().markCodexLaunchPending(tabId, prepared.intent.generation);
  try {
    const command = await buildManagedCodexLaunchCommand(prepared.intent);
    return { ok: true, launch: { ...prepared.intent, command } };
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'managed-command-build-failed';
    await holdCodexLaunch(workspaceId, tabId, prepared.intent.generation, reason);
    return { ok: false, reason };
  }
};

export const submitCodexManagedLaunch = async (
  workspaceId: string,
  tabId: string,
  generation: string,
): Promise<TSubmitCodexLaunchResult> =>
  withCodexTargetLock(workspaceId, tabId, async () => {
    const found = await findTab(workspaceId, tabId);
    const sessionName = found?.tab.sessionName;
    if (!sessionName) {
      return { ok: false, generation, phase: 'held', reason: 'tab-not-found' };
    }
    const intent = await resolvePreparedCodexLaunchIntent(workspaceId, tabId, generation, sessionName);
    if (!intent) {
      return { ok: false, generation, phase: 'held', reason: 'launch-generation-not-current' };
    }
    const terminal = await checkTerminalProcess(sessionName);
    if (!terminal.isSafe) {
      await holdCodexLaunchLocked(workspaceId, tabId, generation, `terminal-not-ready:${terminal.processName}`);
      return {
        ok: false,
        generation,
        phase: 'held',
        reason: `terminal-not-ready:${terminal.processName}`,
      };
    }
    const command = await buildManagedCodexLaunchCommand(intent);
    try {
      await sendKeys(sessionName, command);
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'unknown';
      const reason = `terminal-submit-failed:${detail}`;
      await holdCodexLaunchLocked(workspaceId, tabId, generation, reason);
      return { ok: false, generation, phase: 'held', reason };
    }
    const submitted = await markCodexLaunchSubmittedLocked(workspaceId, tabId, generation);
    if (!submitted.ok) {
      return { ok: false, generation, phase: 'held', reason: submitted.reason };
    }
    return { ok: true, generation, phase: 'submitted' };
  });

export const waitForCodexManagedLaunch = async (
  workspaceId: string,
  tabId: string,
  generation: string,
): Promise<TCodexLaunchActivationResult> => {
  for (let attempt = 0; attempt < ACTIVATION_WAIT_ATTEMPTS; attempt += 1) {
    const found = await findTab(workspaceId, tabId);
    const runtime = found?.tab.codexLaunchRuntime;
    if (runtime?.active?.generation === generation && runtime.active.phase === 'active' && !runtime.pending) {
      return { ok: true, generation, phase: 'active' };
    }
    if (!found || runtime?.pending?.generation !== generation || runtime.pending.phase === 'held') {
      return {
        ok: false,
        generation,
        phase: 'held',
        reason: runtime?.pending?.heldReason ?? 'launch-generation-not-current',
      };
    }
    if (attempt + 1 < ACTIVATION_WAIT_ATTEMPTS) {
      await new Promise<void>((resolve) => setTimeout(resolve, ACTIVATION_WAIT_INTERVAL_MS));
    }
  }
  return { ok: false, generation, phase: 'submitted', reason: 'launch-confirmation-pending' };
};
