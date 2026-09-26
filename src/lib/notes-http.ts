import type { NextApiResponse } from 'next';
import { createLogger } from '@/lib/logger';
import { isCodedError } from '@/lib/coded-error';
import type { NoteError } from '@/lib/notes-store';

const log = createLogger('notes-http');

const STATUS: Record<string, number> = {
  'note-not-found': 404,
  'note-too-large': 413,
  'note-target-missing': 400,
  'note-invalid': 400,
  forbidden: 403,
  'note-cap': 409,
};

/** Every note refusal carries `code`, which the CLI maps to its exit (ADR-0016). */
export const sendNoteError = (res: NextApiResponse, err: unknown): void => {
  if (isCodedError<NoteError>(err, 'NoteError', STATUS)) {
    res.status(STATUS[err.code] ?? 500).json({ error: err.message, code: err.code });
    return;
  }
  log.error(`notes route failed: ${err instanceof Error ? err.message : err}`);
  // Fail closed: an unreadable store answers nothing about who sent what.
  res.status(500).json({ error: 'note operation failed', code: 'note-internal' });
};
