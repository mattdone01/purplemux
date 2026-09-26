import fs from 'fs/promises';
import { createLogger } from '@/lib/logger';
import type { ILayoutData } from '@/types/terminal';

const log = createLogger('tab-lifecycle');

export type TTabClosedReason = 'layout-removed' | 'workspace-deleted' | 'boot-sweep';

export interface ITabClosedEvent {
  workspaceId: string;
  tabId: string;
  sessionName: string;
  reason: TTabClosedReason;
}

export type TTabClosedListener = (event: ITabClosedEvent) => void;

export interface ILiveTab {
  workspaceId: string;
  tabId: string;
  sessionName: string;
}

export interface ITabRef {
  id: string;
  sessionName: string;
}

interface ITabLifecycleState {
  listeners: Set<TTabClosedListener>;
  /** Per workspace, the tabs of the last layout written. Removals are computed from this, not from the layout's own reconciler slot. */
  known: Map<string, Map<string, string>>;
}

const g = globalThis as unknown as { __ptTabLifecycle?: ITabLifecycleState };
if (!g.__ptTabLifecycle) g.__ptTabLifecycle = { listeners: new Set(), known: new Map() };
const state = g.__ptTabLifecycle;

export const onTabClosed = (listener: TTabClosedListener): (() => void) => {
  state.listeners.add(listener);
  return () => {
    state.listeners.delete(listener);
  };
};

export const emitTabClosed = (event: ITabClosedEvent): void => {
  for (const listener of [...state.listeners]) {
    try {
      listener(event);
    } catch (err) {
      log.warn(`tab-closed listener failed for ${event.tabId}: ${err instanceof Error ? err.message : err}`);
    }
  }
};

const toMap = (tabs: readonly ITabRef[]): Map<string, string> =>
  new Map(tabs.map((t) => [t.id, t.sessionName]));

export const hasKnownTabs = (workspaceId: string): boolean => state.known.has(workspaceId);

/**
 * Record the tabs of a layout that was just written and emit one tab-closed
 * event per tab that left it. `previous` seeds a workspace this process has not
 * seen written yet (the file's content before the write), so the first write
 * after a boot still sees its removals.
 */
export const observeLayoutTabs = (
  workspaceId: string,
  tabs: readonly ITabRef[],
  previous?: readonly ITabRef[] | null,
): void => {
  const before = state.known.get(workspaceId) ?? toMap(previous ?? []);
  const after = toMap(tabs);
  state.known.set(workspaceId, after);
  for (const [tabId, sessionName] of before) {
    if (!after.has(tabId)) emitTabClosed({ workspaceId, tabId, sessionName, reason: 'layout-removed' });
  }
};

export const observeWorkspaceRemoved = (workspaceId: string, previous?: readonly ITabRef[] | null): void => {
  const before = state.known.get(workspaceId) ?? toMap(previous ?? []);
  state.known.delete(workspaceId);
  for (const [tabId, sessionName] of before) {
    emitTabClosed({ workspaceId, tabId, sessionName, reason: 'workspace-deleted' });
  }
};

export interface ILiveTabsSnapshot {
  tabs: ILiveTab[];
  /**
   * Workspaces whose layout exists but could not be read or parsed. Their tabs
   * are unknown, not gone: a sweep must not release what they hold.
   */
  uncertainWorkspaceIds: Set<string>;
}

/**
 * Every tab of every workspace's layout on disk — the source of truth for
 * sweeps. A missing layout means no tabs; an unreadable one means unknown.
 * A failure to list the workspaces themselves throws.
 */
export const readLiveTabs = async (): Promise<ILiveTabsSnapshot> => {
  const [{ getWorkspaces }, { resolveLayoutFile, collectAllTabs }] = await Promise.all([
    import('@/lib/workspace-store'),
    import('@/lib/layout-store'),
  ]);
  const { workspaces } = await getWorkspaces();
  const tabs: ILiveTab[] = [];
  const uncertainWorkspaceIds = new Set<string>();
  for (const ws of workspaces) {
    let raw: string;
    try {
      raw = await fs.readFile(resolveLayoutFile(ws.id), 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        uncertainWorkspaceIds.add(ws.id);
        log.warn(`layout of ${ws.id} unreadable, its tabs count as unknown: ${err instanceof Error ? err.message : err}`);
      }
      continue;
    }
    try {
      const layout = JSON.parse(raw) as ILayoutData;
      for (const tab of collectAllTabs(layout.root)) {
        tabs.push({ workspaceId: ws.id, tabId: tab.id, sessionName: tab.sessionName });
      }
    } catch (err) {
      uncertainWorkspaceIds.add(ws.id);
      log.warn(`layout of ${ws.id} unparseable, its tabs count as unknown: ${err instanceof Error ? err.message : err}`);
    }
  }
  return { tabs, uncertainWorkspaceIds };
};

export const listLiveTabs = async (): Promise<ILiveTab[]> => (await readLiveTabs()).tabs;

export const listLiveTabIds = async (): Promise<Set<string>> =>
  new Set((await listLiveTabs()).map((t) => t.tabId));
