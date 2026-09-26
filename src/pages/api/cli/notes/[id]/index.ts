import type { NextApiRequest, NextApiResponse } from 'next';
import { requireCaller, requireMethod } from '@/lib/lease-http';
import { sendNoteError } from '@/lib/notes-http';
import { getNotesService } from '@/lib/notes-service';

/** The note and its body: the recipient workspace, the sender workspace, or admin (ADR-0013). */
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (!requireMethod(req, res, 'GET')) return;
  const caller = await requireCaller(req, res);
  if (!caller) return;
  try {
    return res.status(200).json(await (await getNotesService()).show(caller, req.query.id));
  } catch (err) {
    return sendNoteError(res, err);
  }
};

export default handler;
