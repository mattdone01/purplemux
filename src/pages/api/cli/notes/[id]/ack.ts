import type { NextApiRequest, NextApiResponse } from 'next';
import { bodyOf, requireCaller, requireMethod } from '@/lib/lease-http';
import { sendNoteError } from '@/lib/notes-http';
import { getNotesService } from '@/lib/notes-service';

/** Acknowledge a delivered note: the recipient workspace only (ADR-0013). */
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (!requireMethod(req, res, 'POST')) return;
  const caller = await requireCaller(req, res);
  if (!caller) return;
  try {
    const note = await (await getNotesService()).ack(caller, req.query.id, bodyOf(req).comment);
    return res.status(200).json({ note });
  } catch (err) {
    return sendNoteError(res, err);
  }
};

export default handler;
