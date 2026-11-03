import type { NextApiRequest, NextApiResponse } from 'next';
import { CuratorRefusal } from '@/lib/curator-service';
import { CURATOR_TASK_IDS, isCuratorTask } from '@/lib/curator-tasks';
import type { TCuratorTask } from '@/types/curator';

/** The `task` a curator route names, or a 400 that lists the tasks. */
export const taskOf = (req: NextApiRequest, res: NextApiResponse): TCuratorTask | null => {
  const raw = req.method === 'GET' ? req.query.task : (req.body as { task?: unknown } | null)?.task;
  if (isCuratorTask(raw)) return raw;
  res.status(400).json({ error: `task must be one of ${CURATOR_TASK_IDS.join(', ')}, got ${JSON.stringify(raw ?? null)}`, code: 'curator-task-invalid' });
  return null;
};

/** A refusal by state (a standing spot check, an import id not in the queue) is 409; anything else 503. */
export const sendCuratorError = (res: NextApiResponse, err: unknown): void => {
  if (err instanceof CuratorRefusal) {
    res.status(409).json({ error: err.message, code: 'curator-refused' });
    return;
  }
  res.status(503).json({ error: err instanceof Error ? err.message : String(err), code: 'curator-unavailable' });
};
