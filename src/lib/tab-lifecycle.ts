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

/**
 * A deliberate close (`closeTab`: the CLI, the API, the web UI) announces itself
 * BEFORE the tab's processes are reaped, so a watcher can retire what would read
 * the reap as a death (L38: four "INACTIVE (agent process gone)" alarms on
 * 27 Sep, each on a tab its orchestrator had just closed). `aborted` follows
 * when the close fails before the layout write; `tab-closed` follows otherwise.
 */
export interface ITabClosingEvent {
  workspaceId: string;
  tabId: string;
  sessionName: string;
  phase: 'closing' | 'aborted';
}

export type TTabClosingListener = (event: ITabClosingEvent) => void;

/**
 * A restart (ADR-0028) kills and relaunches a tab's processes under the same
 * tab id. `restarting` comes before the reap, so a watcher retires what would
 * read the reap as a death, as for `closing`; `restarted` or `failed` follows.
 * A restart never emits `tab-closing` or `tab-closed`: nothing keyed on the tab
 * id is dropped.
 */
export interface ITabRestartEvent {
  workspaceId: string;
  tabId: string;
  sessionName: string;
  /** Pairs a `restarting` with its one `restarted` or `failed`. */
  restartId: string;
  phase: 'restarting' | 'restarted' | 'failed';
}

/** An open restart stops counting after this long: a backstop for an end event that never came. */
export const RESTART_WINDOW_MS = 120_000;

interface IOpenRestart {
  tabId: string;
  sessionName: string;
  startedAt: number;
}

export type TTabRestartListener = (event: ITabRestartEvent) => void;

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
  closingListeners?: Set<TTabClosingListener>;
  restartListeners?: Set<TTabRestartListener>;
  /** The restarts whose end event has not come yet, by restart id. */
  openRestarts?: Map<string, IOpenRestart>;
  /** Per workspace, the tabs of the last layout written. Removals are computed from this, not from the layout's own reconciler slot. */
  known: Map<string, Map<string, string>>;
}

const g = globalThis as unknown as { __ptTabLifecycle?: ITabLifecycleState };
if (!g.__ptTabLifecycle) g.__ptTabLifecycle = { listeners: new Set(), known: new Map() };
const state = g.__ptTabLifecycle;
// A state object made by an older module instance (a hot reload) has no closing set yet.
if (!state.closingListeners) state.closingListeners = new Set();
const closingListeners = state.closingListeners;
if (!state.restartListeners) state.restartListeners = new Set();
const restartListeners = state.restartListeners;
if (!state.openRestarts) state.openRestarts = new Map();
const openRestarts = state.openRestarts;

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

export const onTabClosing = (listener: TTabClosingListener): (() => void) => {
  closingListeners.add(listener);
  return () => {
    closingListeners.delete(listener);
  };
};

export const emitTabClosing = (event: ITabClosingEvent): void => {
  for (const listener of [...closingListeners]) {
    try {
      listener(event);
    } catch (err) {
      log.warn(`tab-closing listener failed for ${event.tabId}: ${err instanceof Error ? err.message : err}`);
    }
  }
};

export const onTabRestart = (listener: TTabRestartListener): (() => void) => {
  restartListeners.add(listener);
  return () => {
    restartListeners.delete(listener);
  };
};

export const emitTabRestart = (event: ITabRestartEvent): void => {
  if (event.phase === 'restarting') {
    openRestarts.set(event.restartId, { tabId: event.tabId, sessionName: event.sessionName, startedAt: Date.now() });
  } else {
    openRestarts.delete(event.restartId);
  }
  for (const listener of [...restartListeners]) {
    try {
      listener(event);
    } catch (err) {
      log.warn(`tab-restart listener failed for ${event.tabId}: ${err instanceof Error ? err.message : err}`);
    }
  }
};

const isOpen = (match: (restart: IOpenRestart) => boolean): boolean => {
  const now = Date.now();
  let open = false;
  for (const [restartId, restart] of openRestarts) {
    if (now - restart.startedAt >= RESTART_WINDOW_MS) openRestarts.delete(restartId);
    else if (match(restart)) open = true;
  }
  return open;
};

/** A restart of the tab that owns this session is open (ADR-0028 §12): its attach end is not a session end. */
export const isSessionRestarting = (sessionName: string): boolean => isOpen((restart) => restart.sessionName === sessionName);

export const isTabRestarting = (tabId: string): boolean => isOpen((restart) => restart.tabId === tabId);

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
  const [{ readWorkspaceIdsStrict }, { resolveLayoutFile, collectAllTabs }] = await Promise.all([
    import('@/lib/workspace-store'),
    import('@/lib/layout-store'),
  ]);
  const workspaceIds = await readWorkspaceIdsStrict();
  const tabs: ILiveTab[] = [];
  const uncertainWorkspaceIds = new Set<string>();
  for (const ws of workspaceIds.map((id) => ({ id }))) {
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

/**
 * The live tab ids only. It cannot say which workspaces were unreadable, so a
 * caller that RELEASES what an absent tab held uses `readLiveTabs` instead.
 */
export const listLiveTabIds = async (): Promise<Set<string>> =>
  new Set((await readLiveTabs()).tabs.map((t) => t.tabId));
