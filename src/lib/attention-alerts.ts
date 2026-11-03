import { alertFor, isOrchestratorTab } from '@/lib/alert-policy';
import type { TAlertDraft } from '@/lib/alert-policy';
import { createLogger } from '@/lib/logger';
import type { IAlertContext } from '@/lib/notification-dispatcher';
import type { IMissionEvent } from '@/types/mission-control';
import type { TAlertProviderId } from '@/types/status';
import type { ITab, IWorkspace } from '@/types/terminal';

// `attention-opened` alerts: when a Mission Control item opens for the human (an `attention.opened`
// event commits with routing state `open`, so its humanReview.humanNeed is not `none`), the server
// sends one alert that names the item. A replayed event, a candidate item, an update, an answer, a
// resolve or a cancel sends nothing, and one item alerts at most once per server process.

const log = createLogger('attention-alerts');

/** How many alerted item keys the process remembers against a concurrent duplicate request. */
export const ATTENTION_ALERT_MEMORY = 2_000;

export interface IOpenedAttention {
  workspaceId: string;
  itemId: string;
  title: string | null;
  at: number;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

/**
 * The item an event opened for the human, or null. Only revision 1 of an `attention.opened` whose
 * committed routing state is `open` and whose humanReview does not say `humanNeed: none` counts.
 */
export const openedForHuman = (event: IMissionEvent): IOpenedAttention | null => {
  if (event.type !== 'attention.opened' || event.revision !== 1) return null;
  const payload = asRecord(event.payload);
  if (!payload) return null;
  if (asRecord(payload.routing)?.state !== 'open') return null;
  const review = asRecord(payload.humanReview);
  if (!review || typeof review.humanNeed !== 'string' || review.humanNeed === 'none') return null;
  const itemId = typeof payload.itemId === 'string' && payload.itemId ? payload.itemId : event.entityId;
  if (!itemId) return null;
  return {
    workspaceId: event.workspaceId,
    itemId,
    title: typeof payload.title === 'string' ? payload.title : null,
    at: event.committedAt,
  };
};

export interface IAttentionAlertState {
  /** `<workspaceId>/<itemId>` of each item alerted, oldest first. */
  alerted: Set<string>;
}

export const createAttentionAlertState = (): IAttentionAlertState => ({ alerted: new Set() });

const keyOf = (opened: Pick<IOpenedAttention, 'workspaceId' | 'itemId'>): string => `${opened.workspaceId}/${opened.itemId}`;

const remember = (state: IAttentionAlertState, key: string): void => {
  state.alerted.add(key);
  while (state.alerted.size > ATTENTION_ALERT_MEMORY) {
    const oldest = state.alerted.values().next().value;
    if (oldest === undefined) break;
    state.alerted.delete(oldest);
  }
};

export interface IAttentionAlertDeps {
  workspace: (workspaceId: string) => Promise<IWorkspace | null>;
  findTab: (workspaceId: string, tabId: string) => Promise<ITab | null>;
  providerOf: (tab: ITab) => Promise<TAlertProviderId>;
  dispatch: (draft: TAlertDraft, ctx: IAlertContext) => Promise<unknown>;
}

export const attentionAlertDraft = (
  opened: IOpenedAttention,
  workspace: IWorkspace | null,
  tabId: string,
  tab: ITab | null,
  providerId: TAlertProviderId,
): TAlertDraft => alertFor({
  kind: 'attention-opened',
  tabId,
  workspaceId: opened.workspaceId,
  workspaceName: workspace?.name ?? '',
  tabName: tab?.name ?? '',
  providerId,
  isOrchestrator: tabId ? isOrchestratorTab({ id: tabId }, workspace) : false,
  at: opened.at,
  itemId: opened.itemId,
  itemTitle: opened.title,
});

export interface IAttentionAlertInput {
  /** The events `applyEvents` committed or replayed for one request. */
  events: IMissionEvent[];
  /** The event ids that were not in the store before this request: only these can alert. */
  fresh: ReadonlySet<string>;
  /** The server-resolved tab that sent the request, when there is one (ADR-0023). */
  openerTabId: string | null;
}

/**
 * The tab the alert names: the tab that opened the item when the server resolved one, else the
 * workspace's orchestrator. A tab the layout does not show keeps its id with an empty name.
 */
const alertTab = async (
  deps: IAttentionAlertDeps,
  workspace: IWorkspace | null,
  workspaceId: string,
  openerTabId: string | null,
): Promise<{ tabId: string; tab: ITab | null }> => {
  const tabId = openerTabId ?? workspace?.orchestration?.orchestratorTabId ?? '';
  if (!tabId) return { tabId, tab: null };
  return { tabId, tab: await deps.findTab(workspaceId, tabId).catch(() => null) };
};

/** Send one `attention-opened` alert per item this request opened for the human. Answers the drafts sent. */
export const dispatchAttentionOpenedAlerts = async (
  input: IAttentionAlertInput,
  deps: IAttentionAlertDeps,
  state: IAttentionAlertState,
): Promise<TAlertDraft[]> => {
  const sent: TAlertDraft[] = [];
  for (const event of input.events) {
    if (!input.fresh.has(event.id)) continue;
    const opened = openedForHuman(event);
    if (!opened) continue;
    const key = keyOf(opened);
    if (state.alerted.has(key)) continue;
    remember(state, key);
    try {
      const workspace = await deps.workspace(opened.workspaceId).catch(() => null);
      const { tabId, tab } = await alertTab(deps, workspace, opened.workspaceId, input.openerTabId);
      const providerId = tab ? await deps.providerOf(tab).catch((): TAlertProviderId => 'claude') : 'claude';
      const draft = attentionAlertDraft(opened, workspace, tabId, tab, providerId);
      await deps.dispatch(draft, { workspaceDir: workspace?.directories[0] ?? null });
      sent.push(draft);
    } catch (err) {
      log.warn(`attention-opened alert failed for ${key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return sent;
};

const toAlertProvider = (id: string | undefined): TAlertProviderId =>
  id === 'codex' || id === 'grok' ? id : 'claude';

const realDeps = (): IAttentionAlertDeps => ({
  workspace: async (workspaceId) => (await (await import('@/lib/workspace-store')).getWorkspaceById(workspaceId)) ?? null,
  findTab: async (workspaceId, tabId) => (await (await import('@/lib/cli-utils')).findTab(workspaceId, tabId))?.tab ?? null,
  providerOf: async (tab) => toAlertProvider((await import('@/lib/providers/registry')).getProviderByPanelType(tab.panelType)?.id),
  dispatch: async (draft, ctx) => (await import('@/lib/notification-dispatcher')).getNotificationDispatcher().dispatch(draft, ctx),
});

const g = globalThis as unknown as { __ptAttentionAlertState?: IAttentionAlertState };

export const attentionAlertState = (): IAttentionAlertState => {
  if (!g.__ptAttentionAlertState) g.__ptAttentionAlertState = createAttentionAlertState();
  return g.__ptAttentionAlertState;
};

/** Called without await from the events route: the response never waits on a notification channel. */
export const alertOpenedAttention = (input: IAttentionAlertInput, deps: IAttentionAlertDeps = realDeps()): Promise<TAlertDraft[]> =>
  dispatchAttentionOpenedAlerts(input, deps, attentionAlertState()).catch((err) => {
    log.warn(`attention-opened alerts failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  });
