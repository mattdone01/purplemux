import type { NextApiRequest, NextApiResponse } from 'next';
import { bodyOf, requireCaller, requireMethod } from '@/lib/lease-http';
import { sendNoteError } from '@/lib/notes-http';
import { getNotesService } from '@/lib/notes-service';

/** ACK a local note from its workspace, or a cross-workspace note from its current routed coordinator. */
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
