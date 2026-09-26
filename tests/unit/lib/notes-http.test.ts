import type { NextApiResponse } from 'next';
import { describe, expect, it, vi } from 'vitest';

// Story 22 acceptance: the notes service is created by the server bundle and
// shared on globalThis, while each Next API route holds its own copy of
// notes-store. A refusal thrown by one copy must still map to its code in
// another; with `instanceof` it answered 500 note-internal.

vi.mock('@/lib/logger', () => {
  const logger = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => logger };
  return { createLogger: () => logger };
});

const response = () => {
  const state: { status: number; body: unknown } = { status: 0, body: undefined };
  const res = {
    status(code: number) { state.status = code; return this; },
    json(body: unknown) { state.body = body; return this; },
  } as unknown as NextApiResponse;
  return { res, state };
};

describe('sendNoteError', () => {
  it('maps a NoteError thrown by ANOTHER copy of notes-store to its code (the production bundle split)', async () => {
    const serverCopy = await import('@/lib/notes-store');
    vi.resetModules();
    const routeCopy = await import('@/lib/notes-http');
    const routeStore = await import('@/lib/notes-store');
    expect(routeStore.NoteError).not.toBe(serverCopy.NoteError);

    const { res, state } = response();
    routeCopy.sendNoteError(res, new serverCopy.NoteError('forbidden', 'only the recipient workspace acks note n-1'));
    expect(state).toEqual({ status: 403, body: { error: 'only the recipient workspace acks note n-1', code: 'forbidden' } });
  });

  it('still answers 500 note-internal for an error that is not a note refusal', async () => {
    const { sendNoteError } = await import('@/lib/notes-http');
    const unknownCode = Object.assign(new Error('x'), { name: 'NoteError', code: 'made-up' });
    for (const err of [new Error('disk full'), Object.assign(new Error('x'), { name: 'NoteError' }), unknownCode, 'plain string']) {
      const { res, state } = response();
      sendNoteError(res, err);
      expect(state).toEqual({ status: 500, body: { error: 'note operation failed', code: 'note-internal' } });
    }
  });
});
