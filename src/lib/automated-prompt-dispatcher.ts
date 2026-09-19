import { withAgentDispatchLock, type IAgentDispatchPolicyOptions } from '@/lib/agent-dispatch-policy';
import { findTab } from '@/lib/cli-utils';
import { hasSession } from '@/lib/tmux';
import { deliverPrompt } from '@/lib/agent-prompt-delivery';
import type { ITab } from '@/types/terminal';

interface IPolicyResult {
  ok: boolean;
  error?: string;
}

export interface IAutomatedPromptRequest {
  workspaceId: string;
  targetTabId: string;
  message: string;
}

export type TAutomatedPromptResult =
  | { delivered: true }
  | { delivered: false; reason: 'target-not-found' | 'session-not-found' | 'model-policy' | 'policy-error' | 'delivery-error'; error?: unknown; policy?: IPolicyResult };

export interface IAutomatedPromptDispatcherDeps {
  findTarget: (workspaceId: string, tabId: string) => Promise<ITab | null>;
  withPolicyLock: (
    workspaceId: string,
    target: ITab,
    deliver: (checkPolicy: (options?: IAgentDispatchPolicyOptions) => Promise<IPolicyResult>) => Promise<TAutomatedPromptResult>,
  ) => Promise<TAutomatedPromptResult>;
  hasSession: (sessionName: string) => Promise<boolean>;
  paste: (sessionName: string, message: string) => Promise<void>;
}

const defaultDeps: IAutomatedPromptDispatcherDeps = {
  findTarget: async (workspaceId, tabId) => (await findTab(workspaceId, tabId))?.tab ?? null,
  withPolicyLock: withAgentDispatchLock,
  hasSession,
  paste: deliverPrompt,
};

export class AutomatedPromptDispatcher {
  private tails = new Map<string, Promise<void>>();

  constructor(private deps: IAutomatedPromptDispatcherDeps = defaultDeps) {}

  async dispatch(request: IAutomatedPromptRequest): Promise<TAutomatedPromptResult> {
    const key = `${request.workspaceId}/${request.targetTabId}`;
    const previous = this.tails.get(key) ?? Promise.resolve();
    const delivery = previous.then(() => this.deliver(request));
    const tail = delivery.then(() => undefined, () => undefined);
    this.tails.set(key, tail);
    try {
      return await delivery;
    } finally {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }

  private async deliver(request: IAutomatedPromptRequest): Promise<TAutomatedPromptResult> {
    let target: ITab | null;
    try {
      target = await this.deps.findTarget(request.workspaceId, request.targetTabId);
    } catch (error) {
      return { delivered: false, reason: 'delivery-error', error };
    }
    if (!target) return { delivered: false, reason: 'target-not-found' };

    try {
      return await this.deps.withPolicyLock(request.workspaceId, target, async (checkPolicy) => {
        let current: ITab | null;
        try {
          current = await this.deps.findTarget(request.workspaceId, request.targetTabId);
        } catch (error) {
          return { delivered: false, reason: 'delivery-error', error };
        }
        if (!current) return { delivered: false, reason: 'target-not-found' };
        return this.submit(current, request.message, checkPolicy);
      });
    } catch (error) {
      return { delivered: false, reason: 'policy-error', error };
    }
  }

  private async submit(
    target: ITab,
    message: string,
    checkPolicy: (options?: IAgentDispatchPolicyOptions) => Promise<IPolicyResult>,
  ): Promise<TAutomatedPromptResult> {
    try {
      if (!await this.deps.hasSession(target.sessionName)) {
        return { delivered: false, reason: 'session-not-found' };
      }
    } catch (error) {
      return { delivered: false, reason: 'delivery-error', error };
    }

    let policy: IPolicyResult;
    try {
      policy = await checkPolicy({ consumeBootstrapForTarget: true });
    } catch (error) {
      return { delivered: false, reason: 'policy-error', error };
    }
    if (!policy.ok) return { delivered: false, reason: 'model-policy', policy };

    try {
      await this.deps.paste(target.sessionName, message);
      return { delivered: true };
    } catch (error) {
      return { delivered: false, reason: 'delivery-error', error };
    }
  }
}
