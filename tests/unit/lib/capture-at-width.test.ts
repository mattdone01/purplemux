import { beforeEach, describe, expect, it, vi } from 'vitest';

const tmux = vi.hoisted(() => ({
  capturePaneContent: vi.fn(async () => 'pane'),
  capturePaneContentWithHistory: vi.fn(async () => 'pane+history'),
}));

const server = vi.hoisted(() => {
  const calls: string[] = [];
  return {
    calls,
    size: { cols: 40, rows: 24 } as { cols: number; rows: number } | null,
    pauseSession: vi.fn(() => {
      calls.push('pause');
      return server.size ? { ...server.size } : null;
    }),
    resumeSession: vi.fn(() => {
      calls.push('resume');
    }),
    resizeSessionPty: vi.fn((_session: string, cols: number, rows: number) => {
      calls.push(`resize:${cols}x${rows}`);
    }),
    getActiveSessionSize: vi.fn(() => (server.size ? { ...server.size } : null)),
  };
});

vi.mock('@/lib/tmux', () => tmux);
vi.mock('@/lib/terminal-server', () => server);

const { capturePaneAtWidth } = await import('@/lib/capture-at-width');

beforeEach(() => {
  server.calls.length = 0;
  server.size = { cols: 40, rows: 24 };
  vi.clearAllMocks();
  server.pauseSession.mockImplementation(() => {
    server.calls.push('pause');
    return server.size ? { ...server.size } : null;
  });
  server.getActiveSessionSize.mockImplementation(() => (server.size ? { ...server.size } : null));
});

describe('capturePaneAtWidth', () => {
  it('skips the pause dance entirely on a terminal already wide enough', async () => {
    server.size = { cols: 120, rows: 50 };

    await expect(capturePaneAtWidth('s1', 120, 50)).resolves.toBe('pane+history');

    expect(server.pauseSession).not.toHaveBeenCalled();
    expect(server.resizeSessionPty).not.toHaveBeenCalled();
  });

  it('resumes output BEFORE the restore resize, so the client receives the corrected redraw', async () => {
    await capturePaneAtWidth('s1', 120, 50);

    // Output is suppressed while paused. A restore resize issued before the
    // resume has its redraw dropped, and the browser keeps a stale frame — the
    // "terminal looks frozen, I cannot move between options" report.
    expect(server.calls).toEqual(['pause', 'resize:120x50', 'resume', 'resize:40x24']);
  });

  it('restores the size the client currently wants, not the one captured at pause time', async () => {
    // A rotate/resize lands while the pty is paused; MSG_RESIZE records it but
    // cannot apply it, so the restore must read the current size.
    server.getActiveSessionSize.mockImplementation(() => ({ cols: 80, rows: 30 }));
    // pauseSession still reports the size the pty had when it was paused.

    await capturePaneAtWidth('s1', 120, 50);

    expect(server.calls).toEqual(['pause', 'resize:120x50', 'resume', 'resize:80x30']);
  });

  it('restores and resumes even when the capture throws', async () => {
    tmux.capturePaneContent.mockRejectedValueOnce(new Error('boom'));

    await expect(capturePaneAtWidth('s1', 120, 50)).rejects.toThrow('boom');

    expect(server.calls).toEqual(['pause', 'resize:120x50', 'resume', 'resize:40x24']);
  });

  it('falls back to a plain capture when the session has no live connection to pause', async () => {
    server.size = null;

    await expect(capturePaneAtWidth('s1', 120, 50)).resolves.toBe('pane');

    expect(server.resizeSessionPty).not.toHaveBeenCalled();
    expect(server.resumeSession).not.toHaveBeenCalled();
  });
});
