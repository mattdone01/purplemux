import type { NextApiRequest, NextApiResponse } from 'next';
import { readEntriesBefore } from '@/lib/session-parser';
import { readCodexEntriesBefore } from '@/lib/session-parser-codex';
import { readGrokEntriesBefore } from '@/lib/session-parser-grok';
import { isAllowedJsonlPath, isCodexJsonlPath, isGrokJsonlPath } from '@/lib/path-validation';

const DEFAULT_LIMIT = 256;

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const jsonlPath = req.query.jsonlPath as string;
  if (!jsonlPath) {
    return res.status(400).json({ error: 'jsonlPath parameter required' });
  }

  if (!isAllowedJsonlPath(jsonlPath)) {
    return res.status(403).json({ error: 'Path not allowed' });
  }

  const beforeByte = parseInt(req.query.beforeByte as string, 10);
  if (isNaN(beforeByte) || beforeByte < 0) {
    return res.status(400).json({ error: 'beforeByte parameter required' });
  }

  const limit = parseInt(req.query.limit as string, 10) || DEFAULT_LIMIT;
  const untilByteParam = parseInt(req.query.untilByte as string, 10);
  const untilByte = Number.isFinite(untilByteParam) && untilByteParam >= 0
    ? untilByteParam
    : undefined;

  // `beforeByte` is a cursor into the entry stream, not necessarily a byte
  // offset: grok numbers entries by update ordinal, so the same parameter names
  // the oldest seq the client already holds.
  const isCodex = isCodexJsonlPath(jsonlPath);
  let result;
  if (isCodex) {
    result = await readCodexEntriesBefore(jsonlPath, beforeByte, limit, untilByte);
  } else if (isGrokJsonlPath(jsonlPath)) {
    result = await readGrokEntriesBefore(jsonlPath, beforeByte, limit);
  } else {
    result = await readEntriesBefore(jsonlPath, beforeByte, limit);
  }

  return res.status(200).json({
    entries: result.entries,
    startByteOffset: result.startByteOffset,
    hasMore: result.hasMore,
    replaceEntries: isCodex,
  });
};

export default handler;
