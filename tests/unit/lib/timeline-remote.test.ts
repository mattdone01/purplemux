import { EventEmitter } from 'events';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ADR-0022: the browser timeline of a remote tab reads the tab's local transcript copy. Its pane is on
// another host, so the local pane lookup must never decide it (it answered "Cannot resolve pane pid").

const fx = vi.hoisted(() => ({ home: '', copy: null as null | { jsonlPath: string; sessionId: string }, syncs: 0 }));
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => fx.home }, homedir: () => fx.home };
});
const tmux = vi.hoisted(() => ({ getSessionPanePid: vi.fn(async () => null), getPaneTitle: vi.fn(async () => null) }));
vi.mock('@/lib/tmux', async (importOriginal) => ({ ...await importOriginal<typeof import('@/lib/tmux')>(), ...tmux }));
vi.mock('@/lib/session-host', () => ({ sessionHostOf: async (s: string) => (s.endsWith('tab-r') ? 'host-b' : null) }));
vi.mock('@/lib/remote-transcript', () => ({
  remoteTranscriptCopy: vi.fn(async () => fx.copy),
  syncRemoteTranscript: vi.fn(async () => { fx.syncs += 1; return !!fx.copy; }),
}));
vi.mock('@/lib/layout-store', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/layout-store')>(),
  updateTabAgentSessionId: vi.fn(async () => {}),
  updateTabAgentState: vi.fn(async () => {}),
  updateTabAgentSummary: vi.fn(async () => {}),
  updateTabLastUserMessage: vi.fn(async () => {}),
}));
vi.mock('@/lib/status-manager', () => ({ getStatusManager: () => ({ notifyLastUserMessage: vi.fn(), markAgentLaunch: vi.fn() }) }));

await import('@/lib/timeline-server');

const SESSION = 'pt-ws-a-pane-b-tab-r';
const SID = '0f9e2c4a-1111-2222-3333-444455556666';

class FakeSocket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent: Record<string, unknown>[] = [];
  closed: [number, string] | null = null;
  send(data: string) { this.sent.push(JSON.parse(data)); }
  ping() {}
  close(code: number, reason: string) { this.closed = [code, reason]; this.readyState = 3; this.emit('close'); }
  types() { return this.sent.map((m) => m.type); }
}

const writeCopy = async (sessionId: string) => {
  const file = path.join(fx.home, '.purplemux', 'remote-transcripts', 'tab-r', `${sessionId}.jsonl`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-11-16T02:00:00.000Z', sessionId, message: { role: 'user', content: 'hello from the remote host' } })}\n`);
  return file;
};

const connect = async () => {
  const { handleTimelineConnection } = await import('@/lib/timeline-server');
  const ws = new FakeSocket();
  await handleTimelineConnection(ws as never, { url: `/api/timeline?session=${SESSION}&panelType=claude-code` } as never);
  return ws;
};

describe('timeline of a remote tab (ADR-0022)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    fx.home = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-timeline-remote-'));
    fx.copy = null;
    fx.syncs = 0;
  });
  afterEach(async () => {
    vi.useRealTimers();
    await fs.rm(fx.home, { recursive: true, force: true });
  });

  it('serves the bound transcript copy, never the local pane lookup', async () => {
    fx.copy = { jsonlPath: await writeCopy(SID), sessionId: SID };
    const ws = await connect();
    expect(tmux.getSessionPanePid).not.toHaveBeenCalled();
    expect(ws.closed).toBeNull();
    expect(fx.syncs).toBeGreaterThan(0);
    const init = ws.sent.find((m) => m.type === 'timeline:init');
    expect(init).toMatchObject({ jsonlPath: fx.copy.jsonlPath });
    expect((init as { entries: unknown[] }).entries.length).toBeGreaterThan(0);
    ws.close(1000, 'done');
  });

  it('with no bound session it shows the waiting view, then follows the session the hook binds', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const ws = await connect();
    expect(ws.closed).toBeNull();
    expect(ws.sent.find((m) => m.type === 'timeline:init')).toMatchObject({ entries: [], sessionId: '' });
    fx.copy = { jsonlPath: await writeCopy(SID), sessionId: SID };
    const { REMOTE_TIMELINE_REFRESH_MS } = await import('@/lib/timeline-server');
    await vi.advanceTimersByTimeAsync(REMOTE_TIMELINE_REFRESH_MS);
    await vi.waitFor(() => expect(ws.sent.filter((m) => m.type === 'timeline:init').at(-1)).toMatchObject({ jsonlPath: fx.copy?.jsonlPath }));
    expect(ws.sent).toContainEqual(expect.objectContaining({ type: 'timeline:session-changed', newSessionId: SID, reason: 'new-session-started' }));
    const syncsAtClose = fx.syncs;
    ws.close(1000, 'done');
    await vi.advanceTimersByTimeAsync(REMOTE_TIMELINE_REFRESH_MS * 2);
    expect(fx.syncs).toBe(syncsAtClose);
  });

  it('a session bound before Claude wrote its file is followed once the copy appears (review r1 finding 2)', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const file = path.join(fx.home, '.purplemux', 'remote-transcripts', 'tab-r', `${SID}.jsonl`);
    fx.copy = { jsonlPath: file, sessionId: SID };
    const ws = await connect();
    expect(ws.sent.find((m) => m.type === 'timeline:init')).toMatchObject({ entries: [], sessionId: SID });
    const { REMOTE_TIMELINE_REFRESH_MS } = await import('@/lib/timeline-server');
    await vi.advanceTimersByTimeAsync(REMOTE_TIMELINE_REFRESH_MS);
    expect(ws.sent.filter((m) => m.type === 'timeline:init')).toHaveLength(1);
    await writeCopy(SID);
    await vi.advanceTimersByTimeAsync(REMOTE_TIMELINE_REFRESH_MS);
    await vi.waitFor(() => expect(ws.sent.filter((m) => m.type === 'timeline:init').at(-1)).toMatchObject({ jsonlPath: file }));
    const last = ws.sent.filter((m) => m.type === 'timeline:init').at(-1) as { entries: unknown[] };
    expect(last.entries.length).toBeGreaterThan(0);
    expect(ws.sent).toContainEqual(expect.objectContaining({ type: 'timeline:session-changed', newSessionId: SID, reason: 'new-session-started' }));
    const inits = ws.sent.filter((m) => m.type === 'timeline:init').length;
    await vi.advanceTimersByTimeAsync(REMOTE_TIMELINE_REFRESH_MS * 2);
    expect(ws.sent.filter((m) => m.type === 'timeline:init')).toHaveLength(inits);
    ws.close(1000, 'done');
  });

  it('allows a subscribe to a transcript copy and refuses a path that escapes it', async () => {
    vi.resetModules(); // the allow-list reads the home directory when it loads
    const { isAllowedJsonlPath } = await import('@/lib/path-validation');
    expect(isAllowedJsonlPath(path.join(fx.home, '.purplemux', 'remote-transcripts', 'tab-r', `${SID}.jsonl`))).toBe(true);
    expect(isAllowedJsonlPath(path.join(fx.home, '.purplemux', 'remote-transcripts', '..', 'cli-token.jsonl'))).toBe(false);
    expect(isAllowedJsonlPath(path.join(fx.home, '.purplemux', 'remote-transcripts', 'tab-r', 'mirror.json'))).toBe(false);
  });
});
