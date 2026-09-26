import { describe, expect, it, vi } from 'vitest';
import type { NextApiResponse } from 'next';
import { isCodedError } from '@/lib/coded-error';

// Story 35: server.ts builds the watch manager and the notes service at boot, and the API routes are
// a separate bundle with their own copy of each module. A refusal thrown by the boot-time singleton
// is an instance of the OTHER graph's class. vi.resetModules() between the two imports reproduces
// that: the route module and the throwing class come from two module graphs.

vi.mock('@/lib/logger', () => {
  const logger = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => logger };
  return { createLogger: () => logger };
});

const response = () => {
  const res = { statusCode: 0, body: null as unknown };
  const api = {
    status: (code: number) => {
      res.statusCode = code;
      return api;
    },
    json: (body: unknown) => {
      res.body = body;
      return api;
    },
  };
  return { res, api: api as unknown as NextApiResponse };
};

describe('coded refusals across module graphs (story 35)', () => {
  it('a watch refusal thrown by the other graph keeps its status and code', async () => {
    vi.resetModules();
    const { sendWatchError } = await import('@/lib/watch-http');
    const routeGraph = await import('@/lib/watch-store');
    vi.resetModules();
    const serverGraph = await import('@/lib/watch-store');
    const err = new serverGraph.WatchError('watch-invalid', 'o/r#404 does not exist');
    expect(err).not.toBeInstanceOf(routeGraph.WatchError);

    const { res, api } = response();
    sendWatchError(api, err);
    expect(res).toEqual({ statusCode: 400, body: { error: 'o/r#404 does not exist', code: 'watch-invalid' } });
  });

  it('a note refusal thrown by the other graph keeps its status and code', async () => {
    vi.resetModules();
    const { sendNoteError } = await import('@/lib/notes-http');
    const routeGraph = await import('@/lib/notes-store');
    vi.resetModules();
    const serverGraph = await import('@/lib/notes-store');
    const err = new serverGraph.NoteError('note-not-found', 'no note n-abcd1234');
    expect(err).not.toBeInstanceOf(routeGraph.NoteError);

    const { res, api } = response();
    sendNoteError(api, err);
    expect(res).toEqual({ statusCode: 404, body: { error: 'no note n-abcd1234', code: 'note-not-found' } });
  });

  it('an unbranded error is still an internal failure, whatever code it carries', async () => {
    const { sendWatchError } = await import('@/lib/watch-http');
    const { sendNoteError } = await import('@/lib/notes-http');
    const forged = Object.assign(new Error('boom'), { code: 'watch-invalid' });
    const w = response();
    sendWatchError(w.api, forged);
    expect(w.res).toEqual({ statusCode: 500, body: { error: 'watch operation failed', code: 'watch-internal' } });
    const n = response();
    sendNoteError(n.api, Object.assign(new Error('boom'), { code: 'note-not-found' }));
    expect(n.res).toEqual({ statusCode: 500, body: { error: 'note operation failed', code: 'note-internal' } });
  });

  it('isCodedError needs an Error, the brand and a string code', () => {
    const branded = Object.assign(new Error('x'), { name: 'WatchError', code: 'watch-cap' });
    expect(isCodedError(branded, 'WatchError')).toBe(true);
    expect(isCodedError(branded, 'NoteError')).toBe(false);
    expect(isCodedError(Object.assign(new Error('x'), { name: 'WatchError', code: 7 }), 'WatchError')).toBe(false);
    expect(isCodedError({ name: 'WatchError', code: 'watch-cap', message: 'x' }, 'WatchError')).toBe(false);
    expect(isCodedError(null, 'WatchError')).toBe(false);
  });
});
