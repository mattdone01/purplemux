import { describe, expect, it, vi } from 'vitest';
import type { NextApiResponse } from 'next';
import { brandCodedError, isCodedError } from '@/lib/coded-error';

// Story 35: server.ts builds the watch manager and the notes service at boot, and the API routes are
// a separate bundle with their own copy of each module (the deploy announcer is branded too). A refusal thrown by the boot-time singleton
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

  it('a deploy refusal thrown by the other graph keeps its status and code', async () => {
    vi.resetModules();
    const { sendDeployError } = await import('@/lib/deploy-http');
    const routeGraph = await import('@/lib/deploy-announce');
    vi.resetModules();
    const serverGraph = await import('@/lib/deploy-announce');
    const err = new serverGraph.DeployError('deploy-not-found', 'no deploy announcement d-abcd1');
    expect(err).not.toBeInstanceOf(routeGraph.DeployError);

    const { res, api } = response();
    sendDeployError(api, err);
    expect(res).toEqual({ statusCode: 404, body: { error: 'no deploy announcement d-abcd1', code: 'deploy-not-found' } });
  });

  it('an error without the brand is an internal failure, even named like a refusal', async () => {
    const { sendWatchError } = await import('@/lib/watch-http');
    const { sendNoteError } = await import('@/lib/notes-http');
    const w = response();
    sendWatchError(w.api, Object.assign(new Error('boom'), { name: 'WatchError', code: 'watch-invalid' }));
    expect(w.res).toEqual({ statusCode: 500, body: { error: 'watch operation failed', code: 'watch-internal' } });
    const n = response();
    sendNoteError(n.api, Object.assign(new Error('boom'), { code: 'note-not-found' }));
    expect(n.res).toEqual({ statusCode: 500, body: { error: 'note operation failed', code: 'note-internal' } });
  });

  it('a branded error whose code the route does not map is an internal failure', async () => {
    const { sendWatchError } = await import('@/lib/watch-http');
    const err = Object.assign(new Error('raw detail'), { code: 'watch-unheard-of' });
    brandCodedError(err, 'WatchError');
    const { res, api } = response();
    sendWatchError(api, err);
    expect(res).toEqual({ statusCode: 500, body: { error: 'watch operation failed', code: 'watch-internal' } });
  });

  it('isCodedError needs an Error with the brand of that class and a mapped string code', () => {
    const codes = { 'watch-cap': 409 };
    const branded = Object.assign(new Error('x'), { code: 'watch-cap' });
    brandCodedError(branded, 'WatchError');
    expect(branded.name).toBe('WatchError');
    expect(isCodedError(branded, 'WatchError', codes)).toBe(true);
    expect(isCodedError(branded, 'NoteError', codes)).toBe(false);
    expect(isCodedError(branded, 'WatchError', {})).toBe(false);
    const numeric = Object.assign(new Error('x'), { code: 7 });
    brandCodedError(numeric, 'WatchError');
    expect(isCodedError(numeric, 'WatchError', { 7: 400 })).toBe(false);
    expect(isCodedError({ name: 'WatchError', code: 'watch-cap', message: 'x' }, 'WatchError', codes)).toBe(false);
    expect(isCodedError(null, 'WatchError', codes)).toBe(false);
    // An inherited property is not a mapped code.
    const proto = Object.assign(new Error('x'), { code: 'toString' });
    brandCodedError(proto, 'WatchError');
    expect(isCodedError(proto, 'WatchError', codes)).toBe(false);
  });
});
