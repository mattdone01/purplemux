import type { NextApiRequest, NextApiResponse } from 'next';
import { bodyOf } from '@/lib/lease-http';
import { requireMissionHumanMutation, sendMissionError, setMissionHeaders } from '@/lib/mission-control-http';
import { sendNoteError } from '@/lib/notes-http';
import { getNotesService } from '@/lib/notes-service';

/**
 * A note from the human session (ADR-0029 §6): the `human` admission, to the target workspace's
 * enabled orchestrator; `toEpic` resolves to its live holder's workspace now. It types nothing.
 */
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  setMissionHeaders(res);
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  let actor: string;
  try {
    ({ actor } = await requireMissionHumanMutation(req));
  } catch (error) {
    return sendMissionError(res, error);
  }
  try {
    const body = bodyOf(req);
    const service = await getNotesService();
    const target = await service.humanTarget({ toWorkspace: body.toWorkspace, toEpic: body.toEpic });
    const note = await service.sendHuman(actor, target, { subject: body.subject, body: body.body });
    return res.status(200).json({ note });
  } catch (err) {
    return sendNoteError(res, err, { 'note-too-large': 400 });
  }
};

export default handler;
