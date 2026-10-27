import type { NextApiRequest, NextApiResponse } from 'next';
import { requireMissionHuman, sendMissionError, setMissionHeaders } from '@/lib/mission-control-http';
import { MissionControlError } from '@/lib/mission-control-errors';
import { BurndownStoreError, readBurndown } from '@/lib/burndown-store';
import { getPortfolioStore } from '@/lib/portfolio-store';
import { createLogger } from '@/lib/logger';
import { getSpendTokensByDay } from '@/lib/spend/spend-service';
import type { IBurndownRecord, IMissionBurndownResponse } from '@/types/burndown';

const log = createLogger('mission-burndown');

/** The first UTC day the burndown chart spans. */
const firstDay = (record: IBurndownRecord): string => {
  const times = [record.snapshot.generated_at, ...record.snapshot.history.map((row) => row.at)]
    .map((at) => Date.parse(at)).filter(Number.isFinite);
  return new Date(times.length ? Math.min(...times) : record.receivedAt).toISOString().slice(0, 10);
};

/** Spend is a second axis on the chart: its failure leaves the burndown as it was. */
const readTokensByDay = async (workspaceId: string, record: IBurndownRecord) => {
  try {
    return await getSpendTokensByDay(workspaceId, firstDay(record));
  } catch (error) {
    log.warn(`burndown tokensByDay omitted: ${error instanceof Error ? error.message : error}`);
    return undefined;
  }
};

/** The burndown the human-selected Scrum Master's workspace last published. */
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  setMissionHeaders(res);
  try {
    await requireMissionHuman(req);
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return res.status(405).json({ error: 'Method not allowed' });
    }
    const workspaceId = getPortfolioStore().currentSelection()?.selection.managerWorkspaceId ?? null;
    let burndown: IMissionBurndownResponse['burndown'] = null;
    if (workspaceId) {
      try {
        burndown = await readBurndown(workspaceId);
      } catch (error) {
        if (error instanceof BurndownStoreError) throw new MissionControlError(503, 'storage-unavailable', error.message);
        throw error;
      }
    }
    const tokensByDay = workspaceId && burndown ? await readTokensByDay(workspaceId, burndown) : undefined;
    const body: IMissionBurndownResponse = { workspaceId, burndown, ...(tokensByDay ? { tokensByDay } : {}) };
    return res.status(200).json(body);
  } catch (error) {
    sendMissionError(res, error);
  }
};

export default handler;
