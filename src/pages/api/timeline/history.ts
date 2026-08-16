import type { NextApiRequest, NextApiResponse } from 'next';
import {
  DEFAULT_HISTORY_LIMIT,
  MAX_HISTORY_LIMIT,
  readHistoryPage,
} from '@/lib/timeline-history';
import { resolveSessionKey, type TSessionResolveError } from '@/lib/session-resolver';

export interface IHistoryQuery {
  sessionKey: string;
  afterSeq: number;
  limit: number;
}

export type THistoryQueryResult =
  | { ok: true; query: IHistoryQuery }
  | { ok: false; error: 'bad-request' };

const single = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? undefined : value;

const parseInteger = (value: string | undefined, fallback: number): number | null => {
  if (value === undefined || value === '') return fallback;
  if (!/^-?\d+$/.test(value)) return null;
  return Number(value);
};

export const parseHistoryQuery = (query: NextApiRequest['query']): THistoryQueryResult => {
  const sessionKey = single(query.sessionKey);
  if (!sessionKey) return { ok: false, error: 'bad-request' };

  const afterSeq = parseInteger(single(query.afterSeq), -1);
  if (afterSeq === null || afterSeq < -1) return { ok: false, error: 'bad-request' };

  const limit = parseInteger(single(query.limit), DEFAULT_HISTORY_LIMIT);
  if (limit === null || limit < 1) return { ok: false, error: 'bad-request' };

  return { ok: true, query: { sessionKey, afterSeq, limit: Math.min(limit, MAX_HISTORY_LIMIT) } };
};

export const resolveErrorStatus = (error: TSessionResolveError): number => {
  if (error === 'forbidden-path') return 403;
  if (error === 'session-not-found') return 404;
  return 400;
};

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const parsed = parseHistoryQuery(req.query);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });

  const resolution = await resolveSessionKey(parsed.query.sessionKey);
  if (!resolution.ok) {
    return res.status(resolveErrorStatus(resolution.error)).json({ error: resolution.error });
  }

  const page = await readHistoryPage({
    jsonlPath: resolution.session.jsonlPath,
    provider: resolution.session.provider,
    afterSeq: parsed.query.afterSeq,
    limit: parsed.query.limit,
  });
  if (!page) return res.status(404).json({ error: 'session-not-found' });

  return res.status(200).json(page);
};

export default handler;
