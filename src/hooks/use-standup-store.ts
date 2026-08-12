import { create } from 'zustand';
import type { IWorkspaceStandup } from '@/types/status';

interface IStandupState {
  standups: Record<string, IWorkspaceStandup>;
  setStandup: (standup: IWorkspaceStandup) => void;
  syncFromServer: (standups: Record<string, IWorkspaceStandup>) => void;
}

const useStandupStore = create<IStandupState>((set) => ({
  standups: {},
  setStandup: (standup) => set((s) => {
    const current = s.standups[standup.workspaceId];
    if (current && current.at > standup.at) return s;
    return { standups: { ...s.standups, [standup.workspaceId]: standup } };
  }),
  syncFromServer: (incoming) => set((s) => {
    const merged = { ...s.standups };
    let changed = false;
    for (const [wsId, standup] of Object.entries(incoming)) {
      const current = merged[wsId];
      if (current && current.at >= standup.at) continue;
      merged[wsId] = standup;
      changed = true;
    }
    return changed ? { standups: merged } : s;
  }),
}));

export default useStandupStore;
