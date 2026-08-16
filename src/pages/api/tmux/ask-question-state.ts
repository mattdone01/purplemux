import type { NextApiRequest, NextApiResponse } from 'next';
import { hasSession } from '@/lib/tmux';
import { capturePaneAtWidth } from '@/lib/capture-at-width';
import { createLogger } from '@/lib/logger';
import { parseAskQuestionPane } from '@/lib/ask-user-question-pane';
import type { IAskUserQuestionItem } from '@/types/timeline';

const log = createLogger('tmux');

// Coerced rather than filtered: the caller indexes its own questions array by
// position, so a dropped entry would silently answer the wrong question.
const toQuestion = (raw: unknown): IAskUserQuestionItem => {
  const value = (raw ?? {}) as Record<string, unknown>;
  return {
    question: typeof value.question === 'string' ? value.question : '',
    header: typeof value.header === 'string' ? value.header : '',
    options: [],
    multiSelect: Boolean(value.multiSelect),
  };
};

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { session, questions } = req.body as { session?: string; questions?: unknown[] };

  if (!session || !Array.isArray(questions) || questions.length === 0) {
    return res.status(400).json({ error: 'session and questions parameters required' });
  }

  const exists = await hasSession(session);
  if (!exists) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const parsed = questions.map(toQuestion);

  try {
    const content = await capturePaneAtWidth(session, 120, 50);
    if (content === null) {
      return res.status(200).json({
        phase: 'unavailable',
        activeIndex: -1,
        answered: parsed.map(() => false),
        complete: false,
        options: [],
      });
    }

    return res.status(200).json(parseAskQuestionPane(content, parsed));
  } catch (err) {
    log.error(`ask-question-state query failed: ${err instanceof Error ? err.message : err}`);
    return res.status(500).json({ error: 'Terminal capture failed' });
  }
};

export default handler;
