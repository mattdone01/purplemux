import { useEffect } from 'react';
import Router from 'next/router';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { toast } from 'sonner';
import { t } from '@/lib/i18n';
import type { IDiffSettings, ILayoutData, ITab, IPaneNode, TPanelType } from '@/types/terminal';
import { clearInputDraft } from '@/hooks/use-web-input';
import useTabStore from '@/hooks/use-tab-store';
import useWorkspaceStore from '@/hooks/use-workspace-store';
import useTabMetadataStore from '@/hooks/use-tab-metadata-store';
import { resolveTabNameForPanelTypeChange } from '@/lib/tab-name';
import { isAgentPanelType, panelTypeForProviderId } from '@/lib/agent-panel-types';
import type { TSessionHistoryProvider } from '@/types/session-history';
import {
  collectPanes,
  collectAllTabs,
  findPane,
  getFirstPaneId,
  removePaneWithFocus,
  updateRatioAtPath,
  updatePaneInTree,
} from '@/lib/layout-tree';

export { collectPanes, equalizeNode, getFirstPaneId, findAdjacentPaneInDirection } from '@/lib/layout-tree';
export type { TDirection } from '@/lib/layout-tree';

const cloneLayout = (data: ILayoutData): ILayoutData =>
  JSON.parse(JSON.stringify(data));

const SESSION_PANE_PREFIX = 'pt-active-pane-';
const SESSION_TAB_PREFIX = 'pt-active-tab-';
const SESSION_TERMINAL_RATIO_PREFIX = 'pt-terminal-ratio-';
const SESSION_TERMINAL_COLLAPSED_PREFIX = 'pt-terminal-collapsed-';

const getSessionActivePaneId = (wsId: string): string | null => {
  try { return sessionStorage.getItem(`${SESSION_PANE_PREFIX}${wsId}`); }
  catch { return null; }
};

const getSessionActiveTabId = (paneId: string): string | null => {
  try { return sessionStorage.getItem(`${SESSION_TAB_PREFIX}${paneId}`); }
  catch { return null; }
};

const getSessionTerminalRatio = (tabId: string): number | null => {
  try {
    const raw = sessionStorage.getItem(`${SESSION_TERMINAL_RATIO_PREFIX}${tabId}`);
    if (raw == null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
};

const getSessionTerminalCollapsed = (tabId: string): boolean | null => {
  try {
    const raw = sessionStorage.getItem(`${SESSION_TERMINAL_COLLAPSED_PREFIX}${tabId}`);
    if (raw == null) return null;
    return raw === '1';
  } catch { return null; }
};

const saveSessionActiveState = (wsId: string, layout: ILayoutData) => {
  try {
    if (layout.activePaneId) {
      sessionStorage.setItem(`${SESSION_PANE_PREFIX}${wsId}`, layout.activePaneId);
    }
    for (const pane of collectPanes(layout.root)) {
      if (pane.activeTabId) {
        sessionStorage.setItem(`${SESSION_TAB_PREFIX}${pane.id}`, pane.activeTabId);
      }
      for (const tab of pane.tabs) {
        if (tab.terminalRatio !== undefined) {
          sessionStorage.setItem(`${SESSION_TERMINAL_RATIO_PREFIX}${tab.id}`, String(tab.terminalRatio));
        }
        if (tab.terminalCollapsed !== undefined) {
          sessionStorage.setItem(`${SESSION_TERMINAL_COLLAPSED_PREFIX}${tab.id}`, tab.terminalCollapsed ? '1' : '0');
        }
      }
    }
  } catch { /* */ }
};

interface ILayoutState {
  layout: ILayoutData | null;
  isLoading: boolean;
  error: string | null;
  isSplitting: boolean;
  workspaceId: string | null;
  retryCount: number;
  paneCount: number;
  canSplit: boolean;
  pendingFocusTabId: string | null;

  setWorkspaceId: (id: string | null) => void;
  setLayout: (data: ILayoutData) => void;
  fetchLayout: (wsId?: string | null, preserveActive?: boolean) => Promise<void>;
  splitPane: (paneId: string, orientation: 'horizontal' | 'vertical') => Promise<void>;
  closePane: (paneId: string) => Promise<void>;
  focusPane: (paneId: string) => void;
  updateRatio: (path: number[], ratio: number) => void;
  moveTab: (tabId: string, fromPaneId: string, toPaneId: string, toIndex: number) => void;
  createTabInPane: (paneId: string, panelType?: TPanelType, command?: string, resumeSessionId?: string) => Promise<ITab | null>;
  deleteTabInPane: (paneId: string, tabId: string) => Promise<void>;
  restartTabInPane: (paneId: string, tabId: string, command?: string) => Promise<boolean>;
  switchTabInPane: (paneId: string, tabId: string) => void;
  renameTabInPane: (paneId: string, tabId: string, name: string) => Promise<void>;
  reorderTabsInPane: (paneId: string, tabIds: string[]) => void;
  removeTabLocally: (paneId: string, tabId: string) => void;
  equalizeRatios: () => void;
  updateDiffSettings: (patch: Partial<IDiffSettings>) => void;
  updateTabPanelType: (paneId: string, tabId: string, panelType: TPanelType) => void;
  updateTabTerminalLayout: (paneId: string, tabId: string, patch: { terminalRatio?: number; terminalCollapsed?: boolean }) => void;
  clearLayout: () => void;
  focusTab: (tabId: string) => boolean;
  focusPrevTab: () => void;
  focusNextTab: () => void;
  focusTabByIndex: (index: number) => void;
}

let _abortController: AbortController | null = null;
let _onFetchError: (() => void) | null = null;
let _ratioTimer: ReturnType<typeof setTimeout> | null = null;
let _suppressFetch = false;
const _terminalTimers = new Map<string, ReturnType<typeof setTimeout>>();

const wsQuery = (base: string, wsId: string | null): string => {
  if (!wsId) return base;
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}workspace=${wsId}`;
};

const updateDerived = (layout: ILayoutData | null, isSplitting: boolean) => {
  const paneCount = layout ? collectPanes(layout.root).length : 0;
  return { paneCount, canSplit: paneCount < 10 && !isSplitting };
};

const applyLayout = (set: (s: Partial<ILayoutState>) => void, get: () => ILayoutState, data: ILayoutData) => {
  set({ layout: data, ...updateDerived(data, get().isSplitting) });
};

const applyLayoutPreserveFocus = (
  set: (s: Partial<ILayoutState>) => void,
  get: () => ILayoutState,
  data: ILayoutData,
) => {
  const current = get().layout;
  if (current) {
    const panes = collectPanes(data.root);
    if (current.activePaneId && panes.some((p) => p.id === current.activePaneId)) {
      data.activePaneId = current.activePaneId;
    }
    for (const pane of panes) {
      const localPane = findPane(current.root, pane.id);
      if (localPane?.activeTabId && pane.tabs.some((t) => t.id === localPane.activeTabId)) {
        pane.activeTabId = localPane.activeTabId;
      }
    }
  }
  set({ layout: data, ...updateDerived(data, get().isSplitting) });
};

const applyPaneUpdate = (
  set: (s: Partial<ILayoutState>) => void,
  get: () => ILayoutState,
  paneId: string,
  updater: (pane: IPaneNode) => IPaneNode,
) => {
  const { layout } = get();
  if (!layout) return;
  const newRoot = updatePaneInTree(layout.root, paneId, updater);
  if (newRoot !== layout.root) {
    applyLayout(set, get, { ...layout, root: newRoot });
  }
};

const patchApi = async (url: string, body: Record<string, unknown>): Promise<ILayoutData | null> => {
  try {
    const res = await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
};

const useLayoutStore = create<ILayoutState>((set, get) => ({
  layout: null,
  isLoading: true,
  error: null,
  isSplitting: false,
  workspaceId: null,
  retryCount: 0,
  paneCount: 0,
  canSplit: false,
  pendingFocusTabId: null,

  setWorkspaceId: (id) => {
    _suppressFetch = false;
    set({ workspaceId: id });
  },

  setLayout: (data) => {
    applyLayout(set, get, data);
  },

  fetchLayout: async (wsId?, preserveActive?) => {
    if (_suppressFetch) return;
    const targetWsId = wsId ?? get().workspaceId;
    if (!targetWsId) return;
    const shouldPreserve = preserveActive !== false;

    _abortController?.abort();
    const controller = new AbortController();
    _abortController = controller;

    if (!get().layout) {
      set({ isLoading: true, error: null });
    }
    try {
      const res = await fetch(wsQuery('/api/layout', targetWsId), { signal: controller.signal });
      if (!res.ok) throw new Error();
      const data: ILayoutData = await res.json();
      if (controller.signal.aborted) return;

      const current = get().layout;

      if (shouldPreserve) {
        const fetchedPanes = collectPanes(data.root);
        if (current) {
          if (current.activePaneId && fetchedPanes.some((p) => p.id === current.activePaneId)) {
            data.activePaneId = current.activePaneId;
          }
          for (const pane of fetchedPanes) {
            const localPane = findPane(current.root, pane.id);
            if (localPane?.activeTabId && pane.tabs.some((t) => t.id === localPane.activeTabId)) {
              pane.activeTabId = localPane.activeTabId;
            }
          }
        } else {
          const storedPaneId = getSessionActivePaneId(targetWsId);
          if (storedPaneId && fetchedPanes.some((p) => p.id === storedPaneId)) {
            data.activePaneId = storedPaneId;
          }
          for (const pane of fetchedPanes) {
            const storedTabId = getSessionActiveTabId(pane.id);
            if (storedTabId && pane.tabs.some((t) => t.id === storedTabId)) {
              pane.activeTabId = storedTabId;
            }
            for (const tab of pane.tabs) {
              const storedRatio = getSessionTerminalRatio(tab.id);
              if (storedRatio !== null) tab.terminalRatio = storedRatio;
              const storedCollapsed = getSessionTerminalCollapsed(tab.id);
              if (storedCollapsed !== null) tab.terminalCollapsed = storedCollapsed;
            }
          }
        }
      }

      if (current) {
        const currentContent = { root: current.root, activePaneId: current.activePaneId };
        const fetchedContent = { root: data.root, activePaneId: data.activePaneId };
        if (JSON.stringify(currentContent) === JSON.stringify(fetchedContent)) {
          const pendingTabId = get().pendingFocusTabId;
          if (pendingTabId) {
            set({ pendingFocusTabId: null });
            get().focusTab(pendingTabId);
          }
          return;
        }
      }
      const pendingTabId = get().pendingFocusTabId;
      let pendingPaneId: string | null = null;
      if (pendingTabId) {
        set({ pendingFocusTabId: null });
        for (const pane of collectPanes(data.root)) {
          if (pane.tabs.some((t) => t.id === pendingTabId)) {
            data.activePaneId = pane.id;
            pane.activeTabId = pendingTabId;
            pendingPaneId = pane.id;
            break;
          }
        }
      }
      set({ layout: data, retryCount: 0, ...updateDerived(data, get().isSplitting) });
      if (pendingPaneId) {
        patchApi(wsQuery('/api/layout', targetWsId), { activePaneId: pendingPaneId });
        patchApi(wsQuery(`/api/layout/pane/${pendingPaneId}`, targetWsId), { activeTabId: pendingTabId });
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      const retryCount = get().retryCount + 1;
      set({ retryCount });
      if (retryCount >= 3) {
        try {
          const res = await fetch(wsQuery('/api/layout/pane', targetWsId), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          });
          if (res.ok) {
            const { paneId, tab } = await res.json();
            const fallback: ILayoutData = {
              root: { type: 'pane', id: paneId, tabs: [tab], activeTabId: tab.id },
              activePaneId: paneId,
              updatedAt: new Date().toISOString(),
            };
            set({ layout: fallback, ...updateDerived(fallback, get().isSplitting) });
            toast.info(t('terminal', 'fallbackLayout'));
            set({ retryCount: 0 });
            return;
          }
        } catch { /* fallthrough */ }
      }
      set({ error: t('terminal', 'layoutFetchError') });
      _onFetchError?.();
    } finally {
      if (!controller.signal.aborted) {
        set({ isLoading: false });
      }
    }
  },

  splitPane: async (paneId, orientation) => {
    const { layout, isSplitting, workspaceId } = get();
    if (!layout || isSplitting) return;
    if (collectPanes(layout.root).length >= 10) return;

    set({ isSplitting: true, canSplit: false });
    try {
      let cwd: string | undefined;
      let panelType: string | undefined;
      const pane = findPane(layout.root, paneId);
      const activeTab = pane?.tabs.find((t) => t.id === pane.activeTabId);
      if (activeTab) {
        panelType = activeTab.panelType;
        try {
          const res = await fetch(wsQuery(`/api/layout/cwd?session=${activeTab.sessionName}`, workspaceId));
          if (res.ok) cwd = (await res.json()).cwd;
        } catch { /* fallback */ }
      }

      const res = await fetch(wsQuery('/api/layout/pane', workspaceId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourcePaneId: paneId, orientation, cwd, panelType }),
      });
      if (!res.ok) throw new Error();
      const data: ILayoutData = await res.json();
      applyLayout(set, get, data);
    } catch {
      toast.error(t('terminal', 'splitFailed'));
    } finally {
      set((s) => ({ isSplitting: false, canSplit: (s.paneCount) < 10 }));
    }
  },

  closePane: async (paneId) => {
    const { layout, workspaceId } = get();
    if (!layout) return;
    if (collectPanes(layout.root).length <= 1) return;

    try {
      const res = await fetch(wsQuery(`/api/layout/pane/${paneId}`, workspaceId), {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error();
      const data: ILayoutData = await res.json();
      applyLayoutPreserveFocus(set, get, data);
    } catch {
      toast.error('Pane을 닫을 수 없습니다');
    }
  },

  focusPane: (paneId) => {
    const { layout, workspaceId } = get();
    if (!layout || layout.activePaneId === paneId) return;


    set({ layout: { ...layout, activePaneId: paneId } });

    patchApi(wsQuery('/api/layout', workspaceId), { activePaneId: paneId }).then((data) => {
      if (data) applyLayoutPreserveFocus(set, get, data);
    });
  },

  updateRatio: (path, ratio) => {
    const { layout, workspaceId } = get();
    if (!layout) return;


    const updated = { ...layout, root: updateRatioAtPath(layout.root, path, ratio) };
    set({ layout: updated });

    if (_ratioTimer) clearTimeout(_ratioTimer);
    _ratioTimer = setTimeout(() => {
      _ratioTimer = null;
      patchApi(wsQuery('/api/layout', workspaceId), { ratioUpdate: { path, ratio } }).then((data) => {
        if (data) applyLayoutPreserveFocus(set, get, data);
      });
    }, 300);
  },

  moveTab: (tabId, fromPaneId, toPaneId, toIndex) => {
    if (fromPaneId === toPaneId) return;
    const { layout, workspaceId } = get();
    if (!layout) return;


    const clone: ILayoutData = cloneLayout(layout);
    const fromPane = findPane(clone.root, fromPaneId);
    const toPane = findPane(clone.root, toPaneId);
    if (fromPane && toPane) {
      const tabIdx = fromPane.tabs.findIndex((t) => t.id === tabId);
      if (tabIdx !== -1) {
        const [tab] = fromPane.tabs.splice(tabIdx, 1);
        if (fromPane.activeTabId === tabId) fromPane.activeTabId = fromPane.tabs[0]?.id ?? null;
        fromPane.tabs.forEach((t, i) => { t.order = i; });
        toPane.tabs.splice(toIndex, 0, tab);
        toPane.tabs.forEach((t, i) => { t.order = i; });
        toPane.activeTabId = tabId;
        if (fromPane.tabs.length === 0 && collectPanes(clone.root).length > 1) {
          removePaneWithFocus(clone, fromPaneId);
        }
        clone.activePaneId = toPaneId;
        applyLayout(set, get, clone);
      }
    }

    fetch(wsQuery(`/api/layout/pane/${fromPaneId}/tabs/${tabId}/move`, workspaceId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toPaneId, toIndex }),
    }).then(async (res) => {
      if (res.ok) {
        const data: ILayoutData = await res.json();
        applyLayoutPreserveFocus(set, get, data);
      } else {
        await get().fetchLayout(undefined, false);
      }
    }).catch(() => get().fetchLayout(undefined, false));
  },

  createTabInPane: async (paneId, explicitPanelType?, command?, resumeSessionId?) => {
    const { layout, workspaceId } = get();
    try {
      let panelType: TPanelType | undefined = explicitPanelType;
      const pane = layout ? findPane(layout.root, paneId) : undefined;
      const activeTab = pane?.tabs.find((t) => t.id === pane.activeTabId);
      if (!panelType && activeTab) {
        panelType = activeTab.panelType;
      }

      let cwd: string | undefined;
      if (panelType !== 'web-browser' && activeTab) {
        cwd = useTabMetadataStore.getState().metadata[activeTab.id]?.cwd;
      }

      const res = await fetch(wsQuery(`/api/layout/pane/${paneId}/tabs`, workspaceId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd, panelType, command, resumeSessionId }),
      });
      if (!res.ok) throw new Error();
      const newTab: ITab = await res.json();

      if (command || resumeSessionId) {
        useTabStore.getState().initTab(newTab.id, { panelType, sessionView: 'check' });
      }

      applyPaneUpdate(set, get, paneId, (pane) => ({
        ...pane,
        tabs: [...pane.tabs, newTab],
        activeTabId: newTab.id,
      }));

      get().fetchLayout();
      return newTab;
    } catch {
      toast.error(t('terminal', 'tabCreateFailed'));
      return null;
    }
  },

  deleteTabInPane: async (paneId, tabId) => {
    clearInputDraft(tabId);
    useTabStore.getState().cancelTab(tabId);

    applyPaneUpdate(set, get, paneId, (pane) => {
      const sorted = [...pane.tabs].sort((a, b) => a.order - b.order);
      const idx = sorted.findIndex((t) => t.id === tabId);
      const remaining = sorted.filter((t) => t.id !== tabId);
      remaining.forEach((t, i) => { t.order = i; });
      let newActiveTabId = pane.activeTabId;
      if (pane.activeTabId === tabId) {
        const adjacent = sorted[idx + 1] || sorted[idx - 1];
        newActiveTabId = adjacent?.id ?? null;
      }
      return { ...pane, tabs: remaining, activeTabId: newActiveTabId };
    });

    const { workspaceId } = get();
    try {
      const res = await fetch(wsQuery(`/api/layout/pane/${paneId}/tabs/${tabId}`, workspaceId), { method: 'DELETE' });
      if (!res.ok && res.status !== 404) {
        toast.error(t('terminal', 'tabDeleteError'));
        await get().fetchLayout();
      }
    } catch {
      toast.error(t('terminal', 'tabDeleteError'));
      await get().fetchLayout();
    }
  },

  restartTabInPane: async (paneId, tabId, command?) => {
    const { workspaceId } = get();
    try {
      const res = await fetch(wsQuery(`/api/layout/pane/${paneId}/tabs/${tabId}`, workspaceId), {
        method: 'POST',
        headers: command ? { 'Content-Type': 'application/json' } : undefined,
        body: command ? JSON.stringify({ command }) : undefined,
      });
      return res.ok;
    } catch {
      toast.error(t('terminal', 'sessionRestartFailed'));
      return false;
    }
  },

  switchTabInPane: (paneId, tabId) => {
    applyPaneUpdate(set, get, paneId, (pane) => ({ ...pane, activeTabId: tabId }));

    const { workspaceId } = get();
    patchApi(wsQuery(`/api/layout/pane/${paneId}`, workspaceId), { activeTabId: tabId }).then((data) => {
      if (data) applyLayoutPreserveFocus(set, get, data);
    });
  },

  renameTabInPane: async (paneId, tabId, name) => {
    applyPaneUpdate(set, get, paneId, (pane) => ({
      ...pane,
      tabs: pane.tabs.map((t) => (t.id === tabId ? { ...t, name } : t)),
    }));

    const { workspaceId } = get();
    const data = await patchApi(wsQuery(`/api/layout/pane/${paneId}/tabs/${tabId}`, workspaceId), { name });
    if (data) {
      applyLayoutPreserveFocus(set, get, data);
    } else {
      toast.error(t('terminal', 'tabRenameFailed'));
    }
  },

  reorderTabsInPane: (paneId, tabIds) => {
    applyPaneUpdate(set, get, paneId, (pane) => {
      const tabMap = new Map(pane.tabs.map((t) => [t.id, t]));
      const newTabs = tabIds
        .map((id, i) => {
          const tab = tabMap.get(id);
          return tab ? { ...tab, order: i } : null;
        })
        .filter((t): t is ITab => t !== null);
      return { ...pane, tabs: newTabs };
    });

    const { workspaceId } = get();
    patchApi(wsQuery(`/api/layout/pane/${paneId}/tabs/order`, workspaceId), { tabIds }).then((data) => {
      if (data) applyLayoutPreserveFocus(set, get, data);
    });
  },

  removeTabLocally: (paneId, tabId) => {
    clearInputDraft(tabId);
    const { workspaceId } = get();

    fetch(wsQuery(`/api/layout/pane/${paneId}/tabs/${tabId}`, workspaceId), { method: 'DELETE' })
      .then(() => get().fetchLayout())
      .catch(() => {
        console.log('[layout] removeTabLocally failed');
      });
  },

  equalizeRatios: () => {
    const { workspaceId } = get();

    patchApi(wsQuery('/api/layout', workspaceId), { equalize: true }).then((data) => {
      if (data) applyLayoutPreserveFocus(set, get, data);
    });
  },

  updateDiffSettings: (patch) => {
    const { layout, workspaceId } = get();
    if (!layout) return;
    applyLayout(set, get, {
      ...layout,
      diffSettings: {
        ...(layout.diffSettings ?? {}),
        ...patch,
      },
    });
    patchApi(wsQuery('/api/layout', workspaceId), { diffSettings: patch }).then((data) => {
      if (data) applyLayoutPreserveFocus(set, get, data);
    });
  },

  updateTabPanelType: (paneId, tabId, panelType) => {
    let resolvedName: string | undefined;
    applyPaneUpdate(set, get, paneId, (pane) => ({
      ...pane,
      tabs: pane.tabs.map((t) => {
        if (t.id !== tabId) return t;
        const nextName = resolveTabNameForPanelTypeChange(t.name, t.panelType, panelType);
        const updated: ITab = { ...t, panelType, name: nextName };
        if (nextName !== t.name) resolvedName = nextName;
        if (isAgentPanelType(panelType) && isAgentPanelType(t.panelType) && panelType !== t.panelType) {
          updated.claudeSessionId = null;
          updated.agentState = undefined;
        }
        return updated;
      }),
    }));

    useTabStore.getState().setPanelType(tabId, panelType);

    const { workspaceId } = get();
    patchApi(wsQuery(`/api/layout/pane/${paneId}/tabs/${tabId}`, workspaceId), {
      panelType,
      ...(resolvedName !== undefined ? { name: resolvedName } : {}),
    }).then((data) => {
      if (data) applyLayoutPreserveFocus(set, get, data);
    });
  },

  updateTabTerminalLayout: (paneId, tabId, patch) => {
    applyPaneUpdate(set, get, paneId, (pane) => ({
      ...pane,
      tabs: pane.tabs.map((t) => (t.id === tabId ? { ...t, ...patch } : t)),
    }));

    try {
      if (patch.terminalRatio !== undefined) {
        sessionStorage.setItem(`${SESSION_TERMINAL_RATIO_PREFIX}${tabId}`, String(patch.terminalRatio));
      }
      if (patch.terminalCollapsed !== undefined) {
        sessionStorage.setItem(`${SESSION_TERMINAL_COLLAPSED_PREFIX}${tabId}`, patch.terminalCollapsed ? '1' : '0');
      }
    } catch { /* */ }

    const { workspaceId } = get();
    const existing = _terminalTimers.get(tabId);
    if (existing) clearTimeout(existing);
    _terminalTimers.set(tabId, setTimeout(() => {
      _terminalTimers.delete(tabId);
      patchApi(wsQuery(`/api/layout/pane/${paneId}/tabs/${tabId}`, workspaceId), patch);
    }, 300));
  },

  clearLayout: () => {
    _suppressFetch = true;
    _abortController?.abort();
    set({ layout: null, paneCount: 0, canSplit: false });
  },

  focusTab: (tabId) => {
    const { layout } = get();
    if (!layout) return false;
    for (const pane of collectPanes(layout.root)) {
      if (pane.tabs.some((t) => t.id === tabId)) {
        get().focusPane(pane.id);
        get().switchTabInPane(pane.id, tabId);
        return true;
      }
    }
    return false;
  },

  focusPrevTab: () => {
    const { layout } = get();
    if (!layout) return;
    const panes = collectPanes(layout.root);
    const paneIdx = panes.findIndex((p) => p.id === layout.activePaneId);
    if (paneIdx === -1) return;
    const pane = panes[paneIdx];
    const sorted = [...pane.tabs].sort((a, b) => a.order - b.order);
    const idx = sorted.findIndex((t) => t.id === pane.activeTabId);
    if (idx > 0) {
      get().switchTabInPane(pane.id, sorted[idx - 1].id);
      return;
    }
    const prevPane = panes[(paneIdx - 1 + panes.length) % panes.length];
    const prevSorted = [...prevPane.tabs].sort((a, b) => a.order - b.order);
    if (prevSorted.length === 0) return;
    if (prevPane.id !== pane.id) get().focusPane(prevPane.id);
    get().switchTabInPane(prevPane.id, prevSorted[prevSorted.length - 1].id);
  },

  focusNextTab: () => {
    const { layout } = get();
    if (!layout) return;
    const panes = collectPanes(layout.root);
    const paneIdx = panes.findIndex((p) => p.id === layout.activePaneId);
    if (paneIdx === -1) return;
    const pane = panes[paneIdx];
    const sorted = [...pane.tabs].sort((a, b) => a.order - b.order);
    const idx = sorted.findIndex((t) => t.id === pane.activeTabId);
    if (idx !== -1 && idx < sorted.length - 1) {
      get().switchTabInPane(pane.id, sorted[idx + 1].id);
      return;
    }
    const nextPane = panes[(paneIdx + 1) % panes.length];
    const nextSorted = [...nextPane.tabs].sort((a, b) => a.order - b.order);
    if (nextSorted.length === 0) return;
    if (nextPane.id !== pane.id) get().focusPane(nextPane.id);
    get().switchTabInPane(nextPane.id, nextSorted[0].id);
  },

  focusTabByIndex: (index) => {
    const { layout } = get();
    if (!layout?.activePaneId) return;
    const pane = collectPanes(layout.root).find((p) => p.id === layout.activePaneId);
    if (!pane) return;
    const sorted = [...pane.tabs].sort((a, b) => a.order - b.order);
    const tab = index >= sorted.length ? sorted[sorted.length - 1] : sorted[index];
    if (!tab || tab.id === pane.activeTabId) return;
    get().switchTabInPane(pane.id, tab.id);
  },
}));

useLayoutStore.subscribe((state, prevState) => {
  if (!state.layout || !state.workspaceId) return;
  if (state.layout === prevState.layout) return;
  saveSessionActiveState(state.workspaceId, state.layout);
});

export const setOnFetchError = (fn: (() => void) | null): void => {
  _onFetchError = fn;
};

export const navigateToTab = (workspaceId: string, tabId: string) => {
  const store = useLayoutStore.getState();

  if (Router.pathname !== '/') {
    useLayoutStore.setState({ pendingFocusTabId: tabId });
    useWorkspaceStore.getState().switchWorkspace(workspaceId);
    Router.push('/');
    return;
  }

  if (workspaceId === store.workspaceId) {
    store.focusTab(tabId);
  } else {
    store.clearLayout();
    useLayoutStore.setState({ pendingFocusTabId: tabId });
    useWorkspaceStore.getState().switchWorkspace(workspaceId);
  }
};

export const navigateToTabOrCreate = async (
  workspaceId: string,
  tabId: string,
  agentSessionId: string | null,
  workspaceName: string,
  workspaceDir: string | null,
  providerId: TSessionHistoryProvider = 'claude',
): Promise<void> => {
  const wsStore = useWorkspaceStore.getState();

  const panelType: TPanelType = panelTypeForProviderId(providerId) ?? 'claude-code';
  const matchSessionId = (tab: ITab): boolean => {
    if (providerId !== 'claude') {
      return tab.agentState?.providerId === providerId && tab.agentState.sessionId === agentSessionId;
    }
    return tab.agentState?.providerId === 'claude'
      ? tab.agentState.sessionId === agentSessionId
      : tab.claudeSessionId === agentSessionId;
  };

  let targetWsId = workspaceId;
  const ws = wsStore.workspaces.find((w) => w.id === workspaceId);

  if (!ws) {
    if (!workspaceDir) return;
    const created = await wsStore.createWorkspace(workspaceDir, workspaceName, agentSessionId ?? undefined, panelType);
    if (!created) return;
    targetWsId = created.id;

    const layoutRes = await fetch(wsQuery('/api/layout', targetWsId));
    if (!layoutRes.ok) return;
    const layout: ILayoutData = await layoutRes.json();
    const firstTab = collectAllTabs(layout.root)[0];
    if (!firstTab) return;

    if (agentSessionId) {
      useTabStore.getState().initTab(firstTab.id, { panelType, sessionView: 'check' });
    }

    navigateToTab(targetWsId, firstTab.id);
    return;
  }

  const layoutRes = await fetch(wsQuery('/api/layout', targetWsId));
  if (!layoutRes.ok) return;
  const layout: ILayoutData = await layoutRes.json();

  if (agentSessionId) {
    const matchingTab = collectAllTabs(layout.root).find(matchSessionId);
    if (matchingTab) {
      useTabStore.getState().setSessionView(matchingTab.id, 'timeline');
      navigateToTab(targetWsId, matchingTab.id);
      return;
    }
  } else {
    const existingTab = collectAllTabs(layout.root).find((t) => t.id === tabId);
    if (existingTab) {
      navigateToTab(targetWsId, tabId);
      return;
    }
  }

  const paneId = layout.activePaneId ?? getFirstPaneId(layout.root);
  const cwd = ws.directories[0];
  const body: Record<string, string | undefined> = { panelType, cwd };
  if (agentSessionId) body.resumeSessionId = agentSessionId;

  const tabRes = await fetch(wsQuery(`/api/layout/pane/${paneId}/tabs`, targetWsId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!tabRes.ok) return;
  const newTab: ITab = await tabRes.json();

  if (agentSessionId) {
    useTabStore.getState().initTab(newTab.id, { panelType, sessionView: 'check' });
  }

  if (targetWsId === useLayoutStore.getState().workspaceId) {
    useLayoutStore.setState({ pendingFocusTabId: newTab.id });
    useLayoutStore.getState().fetchLayout();
  } else {
    navigateToTab(targetWsId, newTab.id);
  }
};

const useLayout = ({ workspaceId, onFetchError }: { workspaceId: string | null; onFetchError?: () => void }) => {
  useEffect(() => {
    setOnFetchError(onFetchError ?? null);
  }, [onFetchError]);

  useEffect(() => {
    if (workspaceId) {
      const store = useLayoutStore.getState();
      store.setWorkspaceId(workspaceId);
      store.fetchLayout(workspaceId);
    }
  }, [workspaceId]);

  useEffect(() => {
    return useLayoutStore.subscribe((state) => {
      const wsId = state.workspaceId;
      if (!wsId || !state.layout?.root) return;
      const tabIds = collectPanes(state.layout.root).flatMap((p) => p.tabs.map((t) => t.id));
      useTabStore.getState().setTabOrder(wsId, tabIds);
    });
  }, []);

  return useLayoutStore(useShallow((s) => ({
    layout: s.layout,
    isLoading: s.isLoading,
    error: s.error,
    isSplitting: s.isSplitting,
    paneCount: s.paneCount,
    canSplit: s.canSplit,
    splitPane: s.splitPane,
    closePane: s.closePane,
    focusPane: s.focusPane,
    updateRatio: s.updateRatio,
    moveTab: s.moveTab,
    createTabInPane: s.createTabInPane,
    deleteTabInPane: s.deleteTabInPane,
    restartTabInPane: s.restartTabInPane,
    switchTabInPane: s.switchTabInPane,
    renameTabInPane: s.renameTabInPane,
    reorderTabsInPane: s.reorderTabsInPane,
    removeTabLocally: s.removeTabLocally,
    equalizeRatios: s.equalizeRatios,
    updateDiffSettings: s.updateDiffSettings,
    updateTabPanelType: s.updateTabPanelType,
    clearLayout: s.clearLayout,
    fetchLayout: s.fetchLayout,
    focusTab: s.focusTab,
    focusPrevTab: s.focusPrevTab,
    focusNextTab: s.focusNextTab,
    focusTabByIndex: s.focusTabByIndex,
  })));
};

export { useLayoutStore };
export default useLayout;
