import type { NextApiResponse } from 'next';
import { OrchestrationError } from '@/lib/orchestration-contract';

export const sendOrchestrationError = (res: NextApiResponse, error: unknown): void => {
  if (error instanceof OrchestrationError) {
    res.status(error.status).json({ code: error.code, error: error.message,
      ...(error.orchestration ? { orchestration: error.orchestration } : {}),
      ...(error.undesignatedTabId ? { undesignatedTabId: error.undesignatedTabId } : {}),
    });
  } else res.status(503).json({ code: 'orchestration-unavailable', error: 'Orchestration state is unavailable; refresh before acting' });
};
