import type { NextApiRequest, NextApiResponse } from 'next';
import { isValidCodexEffort } from '@/lib/agent-effort';
import { isValidModelName } from '@/lib/claude-command-shared';
import { buildCodexRuntimeArgs } from '@/lib/providers/codex';
import { getActiveWorkspaceId } from '@/lib/workspace-store';
import { createLogger } from '@/lib/logger';

const log = createLogger('codex-launch-args');

const stringOrNull = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body as {
    workspaceId?: unknown;
    resumeSessionId?: unknown;
    model?: unknown;
    effort?: unknown;
  } | null | undefined;
  const hasModel = body !== null && body !== undefined
    && Object.prototype.hasOwnProperty.call(body, 'model');
  const hasEffort = body !== null && body !== undefined
    && Object.prototype.hasOwnProperty.call(body, 'effort');
  if (hasModel && !isValidModelName(body?.model)) {
    return res.status(400).json({ error: 'Invalid model' });
  }
  if (hasEffort && !isValidCodexEffort(body?.effort)) {
    return res.status(400).json({ error: 'Invalid effort' });
  }

  const workspaceId = stringOrNull(body?.workspaceId) ?? await getActiveWorkspaceId();
  const resumeSessionId = stringOrNull(body?.resumeSessionId) ?? undefined;
  const model = hasModel ? body?.model as string : undefined;
  const effort = hasEffort ? body?.effort as string : undefined;

  try {
    const args = await buildCodexRuntimeArgs(workspaceId ?? undefined, resumeSessionId, { model, effort });
    return res.status(200).json({ args });
  } catch (err) {
    log.error(`codex launch args build failed: ${err instanceof Error ? err.message : err}`);
    return res.status(500).json({ error: 'Failed to build Codex launch args' });
  }
};

export default handler;
