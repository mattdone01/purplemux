import type { NextApiRequest, NextApiResponse } from 'next';
import { GLOBAL_SESSION_SCOPE } from '@/lib/session-key';
import type { TSearchProvider } from '@/lib/search-extract';
import {
  DEFAULT_SEARCH_LIMIT,
  MAX_QUERY_LENGTH,
  MAX_SEARCH_LIMIT,
  MIN_QUERY_LENGTH,
  parseSearchTerms,
  SEARCH_PROVIDERS,
  searchTimeline,
  type ISearchRequest,
} from '@/lib/timeline-search';

export type TSearchQueryError = 'bad-query' | 'bad-request';

export type TSearchQueryResult =
  | { ok: true; query: ISearchRequest }
  | { ok: false; error: TSearchQueryError };

const WORKSPACE_ID = /^[A-Za-z0-9._-]+$/;

const single = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? undefined : value;

const parseInteger = (value: string | undefined, fallback: number): number | null => {
  if (value === undefined || value === '') return fallback;
  if (!/^-?\d+$/.test(value)) return null;
  return Number(value);
};

const isSearchProvider = (value: string): value is TSearchProvider =>
  (SEARCH_PROVIDERS as readonly string[]).includes(value);

export const parseSearchQuery = (query: NextApiRequest['query']): TSearchQueryResult => {
  const raw = single(query.q) ?? '';
  const trimmed = raw.trim();
  if (trimmed.length < MIN_QUERY_LENGTH || trimmed.length > MAX_QUERY_LENGTH) {
    return { ok: false, error: 'bad-query' };
  }

  const terms = parseSearchTerms(trimmed);
  if (terms.length === 0) return { ok: false, error: 'bad-query' };

  const scope = single(query.workspaceId);
  if (scope !== undefined && scope !== GLOBAL_SESSION_SCOPE && !WORKSPACE_ID.test(scope)) {
    return { ok: false, error: 'bad-request' };
  }

  const provider = single(query.provider);
  if (provider !== undefined && !isSearchProvider(provider)) return { ok: false, error: 'bad-request' };

  const limit = parseInteger(single(query.limit), DEFAULT_SEARCH_LIMIT);
  if (limit === null || limit < 1) return { ok: false, error: 'bad-request' };

  const offset = parseInteger(single(query.offset), 0);
  if (offset === null || offset < 0) return { ok: false, error: 'bad-request' };

  return {
    ok: true,
    query: {
      terms,
      workspaceId: scope ?? null,
      provider: provider ?? null,
      limit: Math.min(limit, MAX_SEARCH_LIMIT),
      offset,
    },
  };
};

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const parsed = parseSearchQuery(req.query);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });

  return res.status(200).json(await searchTimeline(parsed.query));
};

export default handler;
