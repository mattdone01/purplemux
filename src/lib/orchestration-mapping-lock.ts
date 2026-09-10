type TLeaseMode = 'read' | 'write';

interface IMappingWaiter {
  mode: TLeaseMode;
  grant: () => void;
}

interface IMappingGate {
  readers: number;
  writer: boolean;
  queue: IMappingWaiter[];
}

const g = globalThis as unknown as { __ptOrchestrationMappingGates?: Map<string, IMappingGate> };
if (!g.__ptOrchestrationMappingGates) g.__ptOrchestrationMappingGates = new Map();
const gates = g.__ptOrchestrationMappingGates;

const drain = (gate: IMappingGate): void => {
  if (gate.writer) return;
  while (gate.queue.length > 0) {
    const next = gate.queue[0];
    if (next.mode === 'write') {
      if (gate.readers > 0) return;
      gate.queue.shift();
      gate.writer = true;
      next.grant();
      return;
    }
    gate.queue.shift();
    gate.readers += 1;
    next.grant();
  }
};

const withMappingLease = async <T>(
  workspaceId: string,
  mode: TLeaseMode,
  work: () => Promise<T>,
): Promise<T> => {
  let gate = gates.get(workspaceId);
  if (!gate) {
    gate = { readers: 0, writer: false, queue: [] };
    gates.set(workspaceId, gate);
  }
  const current = gate;
  await new Promise<void>((grant) => {
    current.queue.push({ mode, grant });
    drain(current);
  });
  try {
    return await work();
  } finally {
    if (mode === 'read') current.readers -= 1;
    else current.writer = false;
    drain(current);
    if (!current.writer && current.readers === 0 && current.queue.length === 0) {
      gates.delete(workspaceId);
    }
  }
};

/** Acquire before lifecycle locks, and retain through terminal submission. */
export const withOrchestrationMappingRead = <T>(
  workspaceId: string,
  work: () => Promise<T>,
): Promise<T> => withMappingLease(workspaceId, 'read', work);

/** Acquire before the workspace-store lock. Queued writers block later readers. */
export const withOrchestrationMappingWrite = <T>(
  workspaceId: string,
  work: () => Promise<T>,
): Promise<T> => withMappingLease(workspaceId, 'write', work);
