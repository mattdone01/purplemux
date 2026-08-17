import { create } from 'zustand';
import { toast } from 'sonner';
import { t } from '@/lib/i18n';
import { getVisuallyOrderedWorkspaces } from '@/lib/workspace-order';
import type { IWorkspace, IWorkspaceGroup, TPanelType } from '@/types/terminal';

const reorderToVisual = (
  workspaces: IWorkspace[],
  groups: IWorkspaceGroup[],
): IWorkspace[] => getVisuallyOrderedWorkspaces(workspaces, groups);

interface IValidateResponse {
  valid: boolean;
  error?: string;
  suggestedName?: string;
  exists?: boolean;
  isDirectory?: boolean;
  canCreate?: boolean;
}

export interface IWorkspaceInitialData {
  workspaces: IWorkspace[];
  groups?: IWorkspaceGroup[];
  activeWorkspaceId?: string;
  sidebarCollapsed: boolean;
  sidebarWidth: number;
}

interface IWorkspaceState {
  workspaces: IWorkspace[];
  groups: IWorkspaceGroup[];
  activeWorkspaceId: string | null;
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  sidebarTab: 'workspace' | 'sessions';
  isSettingsDialogOpen: boolean;
  isCheatSheetOpen: boolean;
  isLoading: boolean;
  error: string | null;
  pendingDeleteIds: Set<string>;

  hydrate: (data: IWorkspaceInitialData) => void;
  fetchWorkspaces: () => Promise<void>;
  syncWorkspaces: () => Promise<void>;
  createWorkspace: (directory: string, name?: string, resumeSessionId?: string, panelType?: TPanelType) => Promise<IWorkspace | null>;
  deleteWorkspace: (workspaceId: string) => Promise<boolean>;
  removeWorkspace: (workspaceId: string) => void;
  markPendingDelete: (workspaceId: string) => void;
  unmarkPendingDelete: (workspaceId: string) => void;
  switchWorkspace: (workspaceId: string) => void;
  renameWorkspace: (workspaceId: string, name: string) => Promise<boolean>;
  reorderWorkspaces: (fromIndex: number, toIndex: number, nextGroupId?: string | null) => void;
  moveWorkspaceToGroup: (workspaceId: string, groupId: string | null) => Promise<boolean>;
  createGroup: (name?: string) => Promise<IWorkspaceGroup | null>;
  renameGroup: (groupId: string, name: string) => Promise<boolean>;
  ungroupGroup: (groupId: string) => Promise<boolean>;
  toggleGroupCollapsed: (groupId: string) => void;
  reorderGroups: (fromIndex: number, toIndex: number) => void;
  toggleSidebar: () => void;
  setSidebarWidth: (width: number) => void;
  saveSidebarWidth: (width: number) => void;
  setSidebarTab: (tab: 'workspace' | 'sessions') => void;
  setSettingsDialogOpen: (open: boolean) => void;
  setCheatSheetOpen: (open: boolean) => void;
  validateDirectory: (directory: string) => Promise<IValidateResponse>;
}

const getInitialSidebar = (): { sidebarWidth: number; sidebarCollapsed: boolean; sidebarTab: 'workspace' | 'sessions' } => {
  if (typeof window !== 'undefined') {
    const sb = (window as unknown as Record<string, unknown>).__SB__ as { w: number; c: boolean; t?: string } | undefined;
    if (sb) return { sidebarWidth: sb.w, sidebarCollapsed: sb.c, sidebarTab: sb.t === 'sessions' ? 'sessions' : 'workspace' };
  }
  return { sidebarWidth: 240, sidebarCollapsed: false, sidebarTab: 'workspace' };
};

const initialSidebar = getInitialSidebar();

const getInitialWorkspaceData = (): { workspaces: IWorkspace[]; activeWorkspaceId: string | null; isLoading: boolean } => {
  return { workspaces: [], activeWorkspaceId: null, isLoading: true };
};

const initialWs = getInitialWorkspaceData();

const getStoredActiveWorkspaceId = (): string | null => {
  if (typeof window === 'undefined') return null;
  const sb = (window as unknown as Record<string, unknown>).__SB__ as { a?: string } | undefined;
  return sb?.a ?? null;
};

const setStoredActiveWorkspaceId = (id: string | null) => {
  if (typeof window === 'undefined') return;
  try {
    if (id) {
      sessionStorage.setItem('active-ws', id);
    } else {
      sessionStorage.removeItem('active-ws');
    }
  } catch { /* */ }
};

const saveActiveWorkspaceIdToServer = (id: string) => {
  fetch('/api/workspace/active', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ activeWorkspaceId: id }),
  }).catch(() => { /* */ });
};

const resolveActiveWorkspaceId = (workspaces: IWorkspace[], serverActiveId?: string): string | null => {
  const stored = getStoredActiveWorkspaceId();
  if (stored && workspaces.some((w) => w.id === stored)) return stored;
  if (serverActiveId && workspaces.some((w) => w.id === serverActiveId)) return serverActiveId;
  return workspaces[0]?.id ?? null;
};

const saveActive = (updates: {
  sidebarCollapsed?: boolean;
  sidebarWidth?: number;
}) => {
  fetch('/api/workspace/active', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  }).catch((err) => {
    console.log(`[workspace-store] active update failed: ${err instanceof Error ? err.message : err}`);
  });
};

let syncTicketCounter = 0;
let lastAppliedSyncTicket = 0;
let mutationFenceTicket = 0;

const bumpMutationFence = () => {
  mutationFenceTicket = syncTicketCounter;
};

const useWorkspaceStore = create<IWorkspaceState>((set, get) => ({
  workspaces: initialWs.workspaces,
  groups: [],
  activeWorkspaceId: initialWs.workspaces.length > 0 ? resolveActiveWorkspaceId(initialWs.workspaces) : null,
  sidebarCollapsed: initialSidebar.sidebarCollapsed,
  sidebarWidth: initialSidebar.sidebarWidth,
  sidebarTab: initialSidebar.sidebarTab,
  isSettingsDialogOpen: false,
  isCheatSheetOpen: false,
  isLoading: initialWs.isLoading,
  error: null,
  pendingDeleteIds: new Set<string>(),

  hydrate: (data) => {
    const activeWorkspaceId = resolveActiveWorkspaceId(data.workspaces, data.activeWorkspaceId);
    setStoredActiveWorkspaceId(activeWorkspaceId);
    if (activeWorkspaceId) saveActiveWorkspaceIdToServer(activeWorkspaceId);
    set({
      workspaces: data.workspaces,
      groups: data.groups ?? [],
      activeWorkspaceId,
      sidebarCollapsed: data.sidebarCollapsed,
      sidebarWidth: data.sidebarWidth,
      isLoading: false,
      error: null,
    });
  },

  fetchWorkspaces: async () => {
    set({ isLoading: true, error: null });
    try {
      const res = await fetch('/api/workspace');
      if (!res.ok) throw new Error();
      const data = await res.json();
      const activeWorkspaceId = resolveActiveWorkspaceId(data.workspaces, data.activeWorkspaceId);
      setStoredActiveWorkspaceId(activeWorkspaceId);
      set({
        workspaces: data.workspaces,
        groups: data.groups ?? [],
        activeWorkspaceId,
        sidebarCollapsed: data.sidebarCollapsed ?? false,
        sidebarWidth: data.sidebarWidth ?? 240,
        isLoading: false,
      });
    } catch {
      set({ error: t('workspace', 'fetchError'), isLoading: false });
    }
  },

  syncWorkspaces: async () => {
    const myTicket = ++syncTicketCounter;
    try {
      const res = await fetch('/api/workspace');
      if (!res.ok) return;
      const data = await res.json();
      if (myTicket < lastAppliedSyncTicket || myTicket <= mutationFenceTicket) return;
      lastAppliedSyncTicket = myTicket;

      const current = get().workspaces;
      const pending = get().pendingDeleteIds;
      const serverList: IWorkspace[] = data.workspaces;
      const serverMap = new Map<string, IWorkspace>(serverList.map((w) => [w.id, w]));

      const merged: IWorkspace[] = [];
      const seen = new Set<string>();
      for (const w of current) {
        const updated = serverMap.get(w.id);
        if (updated) {
          merged.push(updated);
          seen.add(w.id);
        } else if (pending.has(w.id)) {
          merged.push(w);
          seen.add(w.id);
        }
      }
      for (const w of serverList) {
        if (seen.has(w.id)) continue;
        if (pending.has(w.id)) continue;
        merged.push(w);
      }

      const serverGroups: IWorkspaceGroup[] = data.groups ?? [];
      const currentGroups = get().groups;
      const groupsChanged = JSON.stringify(currentGroups) !== JSON.stringify(serverGroups);
      const nextGroups = groupsChanged ? serverGroups : currentGroups;
      const nextWorkspaces = reorderToVisual(merged, nextGroups);
      const workspacesChanged = JSON.stringify(current) !== JSON.stringify(nextWorkspaces);

      if (!workspacesChanged && !groupsChanged) return;
      set({
        workspaces: workspacesChanged ? nextWorkspaces : current,
        groups: nextGroups,
      });
    } catch (err) {
      console.log(`[workspace-store] sync error: ${err instanceof Error ? err.message : err}`);
    }
  },

  createWorkspace: async (directory, name?, resumeSessionId?, panelType?) => {
    try {
      const res = await fetch('/api/workspace', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ directory, name, resumeSessionId, panelType }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || t('workspace', 'createFailed'));
      }
      const ws: IWorkspace = await res.json();
      bumpMutationFence();
      set((state) => ({
        workspaces: state.workspaces.some((w) => w.id === ws.id)
          ? state.workspaces
          : [...state.workspaces, ws],
      }));
      return ws;
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('workspace', 'createFailed');
      toast.error(msg);
      return null;
    }
  },

  deleteWorkspace: async (workspaceId) => {
    try {
      const res = await fetch(`/api/workspace/${workspaceId}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 404) throw new Error();
      bumpMutationFence();
      return true;
    } catch {
      toast.error(t('workspace', 'deleteFailed'));
      return false;
    }
  },

  removeWorkspace: (workspaceId) => {
    set((state) => {
      const remaining = state.workspaces.filter((w) => w.id !== workspaceId);
      const needSwitch = state.activeWorkspaceId === workspaceId;
      const activeWorkspaceId = needSwitch ? (remaining[0]?.id ?? null) : state.activeWorkspaceId;
      if (needSwitch) {
        setStoredActiveWorkspaceId(activeWorkspaceId);
        if (activeWorkspaceId) saveActiveWorkspaceIdToServer(activeWorkspaceId);
      }
      return { workspaces: remaining, activeWorkspaceId };
    });
  },

  markPendingDelete: (workspaceId) => {
    set((state) => {
      if (state.pendingDeleteIds.has(workspaceId)) return state;
      const next = new Set(state.pendingDeleteIds);
      next.add(workspaceId);
      return { pendingDeleteIds: next };
    });
  },

  unmarkPendingDelete: (workspaceId) => {
    set((state) => {
      if (!state.pendingDeleteIds.has(workspaceId)) return state;
      const next = new Set(state.pendingDeleteIds);
      next.delete(workspaceId);
      return { pendingDeleteIds: next };
    });
  },

  switchWorkspace: (workspaceId) => {
    set({ activeWorkspaceId: workspaceId });
    setStoredActiveWorkspaceId(workspaceId);
    saveActiveWorkspaceIdToServer(workspaceId);
  },

  renameWorkspace: async (workspaceId, name) => {
    const prev = get().workspaces.find((w) => w.id === workspaceId);
    const previousName = prev?.name ?? '';
    set((state) => ({
      workspaces: state.workspaces.map((w) =>
        w.id === workspaceId ? { ...w, name } : w,
      ),
    }));
    try {
      const res = await fetch(`/api/workspace/${workspaceId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error();
      return true;
    } catch {
      set((state) => ({
        workspaces: state.workspaces.map((w) =>
          w.id === workspaceId ? { ...w, name: previousName } : w,
        ),
      }));
      toast.error(t('workspace', 'renameFailed'));
      return false;
    }
  },

  reorderWorkspaces: (fromIndex, toIndex, nextGroupId) => {
    const list = [...get().workspaces];
    const [moved] = list.splice(fromIndex, 1);
    if (nextGroupId !== undefined) {
      moved.groupId = nextGroupId;
    }
    list.splice(toIndex, 0, moved);
    bumpMutationFence();
    set({ workspaces: list });

    fetch('/api/workspace/reorder', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: list.map((w) => ({ id: w.id, groupId: w.groupId ?? null })),
      }),
    }).catch(() => {
      toast.error(t('workspace', 'reorderFailed'));
      get().fetchWorkspaces();
    });
  },

  moveWorkspaceToGroup: async (workspaceId, groupId) => {
    const prev = get().workspaces.find((w) => w.id === workspaceId);
    if (!prev) return false;
    const prevGroupId = prev.groupId ?? null;
    if (prevGroupId === groupId) return true;
    bumpMutationFence();
    set((state) => {
      const updated = state.workspaces.map((w) =>
        w.id === workspaceId ? { ...w, groupId } : w,
      );
      return { workspaces: reorderToVisual(updated, state.groups) };
    });
    try {
      const res = await fetch(`/api/workspace/${workspaceId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groupId }),
      });
      if (!res.ok) throw new Error();
      return true;
    } catch {
      set((state) => {
        const reverted = state.workspaces.map((w) =>
          w.id === workspaceId ? { ...w, groupId: prevGroupId } : w,
        );
        return { workspaces: reorderToVisual(reverted, state.groups) };
      });
      toast.error(t('workspace', 'reorderFailed'));
      return false;
    }
  },

  createGroup: async (name) => {
    try {
      const res = await fetch('/api/workspace/group', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name ?? '' }),
      });
      if (!res.ok) throw new Error();
      const group: IWorkspaceGroup = await res.json();
      bumpMutationFence();
      set((state) => ({
        groups: state.groups.some((g) => g.id === group.id) ? state.groups : [...state.groups, group],
      }));
      return group;
    } catch {
      toast.error(t('workspace', 'createFailed'));
      return null;
    }
  },

  renameGroup: async (groupId, name) => {
    const prev = get().groups.find((g) => g.id === groupId);
    const previousName = prev?.name ?? '';
    set((state) => ({
      groups: state.groups.map((g) => (g.id === groupId ? { ...g, name } : g)),
    }));
    try {
      const res = await fetch(`/api/workspace/group/${groupId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error();
      return true;
    } catch {
      set((state) => ({
        groups: state.groups.map((g) => (g.id === groupId ? { ...g, name: previousName } : g)),
      }));
      toast.error(t('workspace', 'renameFailed'));
      return false;
    }
  },

  ungroupGroup: async (groupId) => {
    const prevGroups = get().groups;
    const prevWorkspaces = get().workspaces;
    bumpMutationFence();
    set((state) => {
      const nextGroups = state.groups.filter((g) => g.id !== groupId);
      const updated = state.workspaces.map((w) =>
        w.groupId === groupId ? { ...w, groupId: null } : w,
      );
      return {
        groups: nextGroups,
        workspaces: reorderToVisual(updated, nextGroups),
      };
    });
    try {
      const res = await fetch(`/api/workspace/group/${groupId}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 404) throw new Error();
      return true;
    } catch {
      set({ groups: prevGroups, workspaces: prevWorkspaces });
      toast.error(t('workspace', 'deleteFailed'));
      return false;
    }
  },

  toggleGroupCollapsed: (groupId) => {
    const group = get().groups.find((g) => g.id === groupId);
    if (!group) return;
    const next = !group.collapsed;
    set((state) => ({
      groups: state.groups.map((g) => (g.id === groupId ? { ...g, collapsed: next } : g)),
    }));
    fetch(`/api/workspace/group/${groupId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ collapsed: next }),
    }).catch(() => { /* tolerate */ });
  },

  reorderGroups: (fromIndex, toIndex) => {
    const list = [...get().groups];
    const [moved] = list.splice(fromIndex, 1);
    list.splice(toIndex, 0, moved);
    bumpMutationFence();
    set((state) => ({
      groups: list,
      workspaces: reorderToVisual(state.workspaces, list),
    }));

    fetch('/api/workspace/group/reorder', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupIds: list.map((g) => g.id) }),
    }).catch(() => {
      toast.error(t('workspace', 'reorderFailed'));
      get().fetchWorkspaces();
    });
  },

  toggleSidebar: () => {
    set((state) => {
      const next = !state.sidebarCollapsed;
      saveActive({ sidebarCollapsed: next });
      return { sidebarCollapsed: next };
    });
  },

  setSidebarWidth: (width) => {
    set({ sidebarWidth: width });
  },

  saveSidebarWidth: (width) => {
    saveActive({ sidebarWidth: width });
  },

  setSidebarTab: (tab) => {
    set({ sidebarTab: tab });
    try { localStorage.setItem('sidebar-tab', tab); } catch { /* */ }
  },

  setSettingsDialogOpen: (open) => {
    set({ isSettingsDialogOpen: open });
  },

  setCheatSheetOpen: (open) => {
    set({ isCheatSheetOpen: open });
  },

  validateDirectory: async (directory) => {
    try {
      const res = await fetch(
        `/api/workspace/validate?directory=${encodeURIComponent(directory)}`,
      );
      if (!res.ok) throw new Error();
      return await res.json();
    } catch {
      return { valid: false, error: t('workspace', 'validateFailed') };
    }
  },
}));

export default useWorkspaceStore;
