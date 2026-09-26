import { isAgentPanelType } from '@/lib/agent-panel-types';
import { checkComposerReady } from '@/lib/composer-readiness';
import {
  deliverInState,
  dropForTabInState,
  dueItems,
  holdInState,
  mutateInbox,
  refuseInState,
  sweepInState,
} from '@/lib/inbox-store';
import { createLogger } from '@/lib/logger';
import type { TAgentDispatchPolicyCheck } from '@/lib/agent-dispatch-policy';
import type { IInboxItem, IInboxState } from '@/types/inbox';
import type { IClientTabStatusEntry } from '@/types/status';
import type { ITab } from '@/types/terminal';

const log = createLogger('inbox');

export const INBOX_TICK_MS = 2_000;

export interface IInboxDispatcherDeps {
  now: () => number;
  mutate: <T>(fn: (state: IInboxState) => { state: IInboxState; value: T }) => Promise<T>;
  findTab: (workspaceId: string, tabId: string) => Promise<ITab | null>;
  hasSession: (sessionName: string) => Promise<boolean>;
  status: (tabId: string) => IClientTabStatusEntry | undefined;
  /** ADR-0018 ruling A′: busy only because its ended turn waits on background work. */
  waitingAtPrompt: (tabId: string) => boolean;
  capture: (sessionName: string) => Promise<string | null>;
  withDispatchLock: <T>(workspaceId: string, tab: ITab, work: (checkPolicy: TAgentDispatchPolicyCheck) => Promise<T>) => Promise<T>;
  deliver: (sessionName: string, line: string) => Promise<void>;
  /** The pasted line still sits in the composer (the Enter was swallowed). */
  isPending: (sessionName: string, line: string) => Promise<boolean>;
}

type TAttempt =
  | { outcome: 'delivered' }
  | { outcome: 'refused'; reason: string }
  | { outcome: 'held'; reason: string }
  | { outcome: 'dropped'; reason: string };

const STATE_REFUSAL = 'composer-not-ready:';

/**
 * Delivers queued notices (ADR-0012): per target tab, one at a time, oldest
 * first, only into an agent whose composer is ready and empty. A refusal backs
 * off; a tab whose state refused and that has since become ready is retried on
 * the next tick instead of after its full backoff. A paste that throws is held
 * as `transport-uncertain` and never retried blind.
 */
export class InboxDispatcher {
  private running = false;

  constructor(private deps: IInboxDispatcherDeps) {}

  private isReadyState(tabId: string): boolean {
    const status = this.deps.status(tabId);
    if (!status) return false;
    return status.cliState === 'idle' || status.cliState === 'ready-for-review'
      || (status.cliState === 'busy' && this.deps.waitingAtPrompt(tabId));
  }

  /** Early wake: the last refusal was the tab's state, and the state is ready now. */
  private wake = (item: IInboxItem): boolean =>
    (item.lastRefusal ?? '').startsWith(STATE_REFUSAL) && this.isReadyState(item.targetTabId);

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = this.deps.now();
      const due = await this.deps.mutate((state) => {
        const swept = sweepInState(state, now);
        return { state: swept, value: dueItems(swept, now, this.wake) };
      });
      for (const item of due) await this.attemptAndRecord(item);
    } finally {
      this.running = false;
    }
  }

  private async attemptAndRecord(item: IInboxItem): Promise<void> {
    let attempt: TAttempt;
    try {
      attempt = await this.attempt(item);
    } catch (err) {
      attempt = { outcome: 'refused', reason: `dispatch-error:${err instanceof Error ? err.message : String(err)}` };
    }
    const now = this.deps.now();
    await this.deps.mutate((state) => {
      switch (attempt.outcome) {
        case 'delivered': return { state: deliverInState(state, item.id, now), value: null };
        case 'held': return { state: holdInState(state, item.id, attempt.reason, now), value: null };
        case 'dropped': return { state: dropForTabInState(state, item.targetWorkspaceId, item.targetTabId, attempt.reason, now).state, value: null };
        case 'refused': return { state: refuseInState(state, item.id, attempt.reason, now), value: null };
      }
    });
    if (attempt.outcome === 'delivered') log.info({ id: item.id, kind: item.kind, tabId: item.targetTabId }, 'inbox delivered');
    else if (attempt.outcome !== 'refused') log.info({ id: item.id, tabId: item.targetTabId, ...attempt }, `inbox ${attempt.outcome}`);
  }

  private async attempt(item: IInboxItem): Promise<TAttempt> {
    const found = await this.deps.findTab(item.targetWorkspaceId, item.targetTabId);
    if (!found) return { outcome: 'dropped', reason: 'target-tab-closed' };
    if (!isAgentPanelType(found.panelType)) return { outcome: 'held', reason: 'target-not-agent' };
    if (!(await this.deps.hasSession(found.sessionName))) return { outcome: 'refused', reason: 'session-not-running' };

    return this.deps.withDispatchLock(item.targetWorkspaceId, found, async (checkPolicy) => {
      const current = await this.deps.findTab(item.targetWorkspaceId, item.targetTabId);
      if (!current) return { outcome: 'dropped', reason: 'target-tab-closed' };
      if (current.sessionName !== found.sessionName) return { outcome: 'refused', reason: 'target-changed' };
      const policy = await checkPolicy();
      if (!policy.ok) return { outcome: 'refused', reason: `policy:${policy.error ?? 'refused'}` };
      const readiness = await checkComposerReady({
        panelType: current.panelType,
        status: this.deps.status(item.targetTabId),
        waitingAtPrompt: this.deps.waitingAtPrompt(item.targetTabId),
        capture: () => this.deps.capture(current.sessionName),
      });
      if (!readiness.ok) return { outcome: 'refused', reason: readiness.reason };
      try {
        await this.deps.deliver(current.sessionName, item.line);
      } catch (err) {
        return { outcome: 'held', reason: `transport-uncertain:${err instanceof Error ? err.message : String(err)}` };
      }
      // No caller reads `submitted` here, so a stranded paste is held, never retried blind.
      const pending = await this.deps.isPending(current.sessionName, item.line).catch(() => false);
      return pending ? { outcome: 'held', reason: 'stranded-in-composer' } : { outcome: 'delivered' };
    });
  }

  /** `tab-closed`: the tab's queued and held notices are dropped; their owners re-route them. */
  async dropForTab(workspaceId: string, tabId: string): Promise<IInboxItem[]> {
    const now = this.deps.now();
    return this.deps.mutate((state) => {
      const result = dropForTabInState(state, workspaceId, tabId, 'target-tab-closed', now);
      return { state: result.dropped.length ? result.state : state, value: result.dropped };
    });
  }
}

// ─── the server's instance ───────────────────────────────────────────────

interface IInboxRuntime {
  dispatcher: InboxDispatcher;
  timer: ReturnType<typeof setInterval> | null;
  unsubscribe: (() => void) | null;
}

const g = globalThis as unknown as { __ptInboxRuntime?: IInboxRuntime };

const defaultDeps = async (): Promise<IInboxDispatcherDeps> => {
  const [{ findTab }, { hasSession, isContentPendingInComposer }, { getStatusManager }, { capturePaneAtWidth }, { withAgentDispatchLock }, { deliverPrompt }] = await Promise.all([
    import('@/lib/cli-utils'),
    import('@/lib/tmux'),
    import('@/lib/status-manager'),
    import('@/lib/capture-at-width'),
    import('@/lib/agent-dispatch-policy'),
    import('@/lib/agent-prompt-delivery'),
  ]);
  return {
    now: () => Date.now(),
    mutate: mutateInbox,
    findTab: async (workspaceId, tabId) => (await findTab(workspaceId, tabId))?.tab ?? null,
    hasSession,
    status: (tabId) => getStatusManager().getAllForClient()[tabId],
    waitingAtPrompt: (tabId) => getStatusManager().isWaitingAtPrompt(tabId),
    capture: (sessionName) => capturePaneAtWidth(sessionName, 120, 50),
    withDispatchLock: (workspaceId, tab, work) => withAgentDispatchLock(workspaceId, tab, work),
    deliver: deliverPrompt,
    isPending: isContentPendingInComposer,
  };
};

export const startInbox = async (): Promise<void> => {
  if (g.__ptInboxRuntime?.timer) return;
  const dispatcher = new InboxDispatcher(await defaultDeps());
  const { onTabClosed } = await import('@/lib/tab-lifecycle');
  const unsubscribe = onTabClosed(({ workspaceId, tabId }) => {
    dispatcher.dropForTab(workspaceId, tabId).then((dropped) => {
      if (dropped.length) log.info({ tabId, dropped: dropped.map((i) => i.id) }, 'inbox dropped: target tab closed');
    }).catch((err) => log.warn(`inbox drop failed for ${tabId}: ${err instanceof Error ? err.message : err}`));
  });
  const timer = setInterval(() => {
    dispatcher.tick().catch((err) => log.warn(`inbox tick failed: ${err instanceof Error ? err.message : err}`));
  }, INBOX_TICK_MS);
  timer.unref?.();
  g.__ptInboxRuntime = { dispatcher, timer, unsubscribe };
};

export const stopInbox = (): void => {
  const runtime = g.__ptInboxRuntime;
  if (!runtime) return;
  if (runtime.timer) clearInterval(runtime.timer);
  runtime.unsubscribe?.();
  g.__ptInboxRuntime = undefined;
};
