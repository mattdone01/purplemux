import type { NextApiRequest, NextApiResponse } from 'next';
import { resolveCaller } from '@/lib/caller';
import { MissionControlError } from '@/lib/mission-control-errors';
import { sendMissionError, setMissionHeaders } from '@/lib/mission-control-http';
import { readQuestionMinVersion } from '@/lib/mission-question-config';
import { validateMissionQuestion } from '@/lib/mission-question-format';

export const config = {
  api: { bodyParser: { sizeLimit: '64kb' } },
};

/** The curator reshape (ADR-0037 §3) is story 23's; until it lands `--fix` has nothing to call. */
const RESHAPE = { enabled: false, reason: 'the curator reshape is not enabled on this server (harness-flow-loop story 23)' } as const;

/**
 * The events route's question check without the write (ADR-0037 §2-§3): `purplemux mc ask` runs it
 * before it posts, so the agent fixes every defect in the same turn.
 */
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  setMissionHeaders(res);
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    if (!(await resolveCaller(req, res))) throw new MissionControlError(401, 'unauthorized', 'CLI token required');
    const body = req.body as { question?: unknown } | null;
    if (!body || typeof body !== 'object' || !('question' in body)) {
      throw new MissionControlError(400, 'invalid-request', 'body must be { "question": { ... } }');
    }
    const minVersion = await readQuestionMinVersion();
    const verdict = validateMissionQuestion(body.question, minVersion);
    return res.status(200).json(verdict.ok
      ? { ok: true, formatVersion: verdict.formatVersion, minVersion, defects: [], lint: verdict.lint, question: verdict.question, reshape: RESHAPE }
      : { ok: false, formatVersion: verdict.formatVersion, minVersion, defects: verdict.defects, lint: [], question: null, reshape: RESHAPE });
  } catch (error) {
    sendMissionError(res, error);
  }
};

export default handler;
