import { create } from 'zustand';
import type { IOrchestrationNudge } from '@/types/status';

const MAX_NUDGES = 200;

interface IOrchestrationState {
  nudges: IOrchestrationNudge[];
  addNudge: (nudge: IOrchestrationNudge) => void;
  mergeNudges: (incoming: IOrchestrationNudge[]) => void;
}

const useOrchestrationStore = create<IOrchestrationState>((set) => ({
  nudges: [],
  addNudge: (nudge) => set((s) => {
    if (s.nudges.some((n) => n.id === nudge.id)) return s;
    return { nudges: [...s.nudges, nudge].slice(-MAX_NUDGES) };
  }),
  mergeNudges: (incoming) => set((s) => {
    const seen = new Set(s.nudges.map((n) => n.id));
    const added = incoming.filter((n) => !seen.has(n.id));
    if (added.length === 0) return s;
    return { nudges: [...s.nudges, ...added].sort((a, b) => a.at - b.at).slice(-MAX_NUDGES) };
  }),
}));

export default useOrchestrationStore;
