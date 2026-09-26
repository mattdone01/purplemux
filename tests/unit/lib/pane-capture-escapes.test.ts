import { beforeEach, describe, expect, it, vi } from 'vitest';

// Story 17 review r1 finding 3: L7's root cause was a capture without `-e`. These
// pin the escapes on every capture that reads a composer: `tab result`, the
// pane probe's plain capture, the inbox dispatcher.

const calls = vi.hoisted(() => ({ args: [] as string[][] }));
const capture = vi.hoisted(() => vi.fn(async () => 'pane'));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const execFile = (_cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, out: unknown) => void) => {
    calls.args.push(args);
    cb(null, { stdout: 'pane', stderr: '' });
  };
  return { ...actual, default: { ...actual, execFile }, execFile };
});
vi.mock('@/lib/capture-at-width', () => ({ capturePaneAtWidth: capture }));
vi.mock('@/lib/status-manager', () => ({ getStatusManager: () => ({}) }));

describe('captures that read a composer keep the escapes (story 17)', () => {
  beforeEach(() => {
    calls.args = [];
    capture.mockClear();
  });

  it('tab result captures with -e -J', async () => {
    const { capturePaneContentAnsi } = await import('@/lib/tmux');
    await capturePaneContentAnsi('s-1');
    expect(calls.args).toEqual([['-L', 'purple', 'capture-pane', '-p', '-e', '-J', '-t', 's-1']]);
  });

  it('capturePaneContent adds -e only when asked', async () => {
    const { capturePaneContent, capturePaneContentWithHistory } = await import('@/lib/tmux');
    await capturePaneContent('s-1', { escapes: true });
    await capturePaneContent('s-1');
    await capturePaneContentWithHistory('s-1', 50, { escapes: true });
    expect(calls.args).toEqual([
      ['-L', 'purple', 'capture-pane', '-p', '-e', '-t', 's-1'],
      ['-L', 'purple', 'capture-pane', '-p', '-t', 's-1'],
      ['-L', 'purple', 'capture-pane', '-p', '-e', '-S', '-50', '-t', 's-1'],
    ]);
  });

  it('the inbox dispatcher captures with escapes', async () => {
    const { defaultInboxDeps } = await import('@/lib/inbox-dispatcher');
    await (await defaultInboxDeps()).capture('s-1');
    expect(capture).toHaveBeenCalledWith('s-1', 120, 50, { escapes: true });
  });
});
