import { describe, expect, it } from 'vitest';
import { liveTmuxProcesses, usesTmuxSocket, type ITmuxProcessDeps } from '@/lib/tab-orphans';
import { readLocalTree } from '@/lib/tmux';

// The orphan sweep's read of this server's tmux: only tmux's own "no server" is an empty tree. Any other failure or
// a timeout is unreadable, never an empty pane list that would leave every live seat unheld.

const fail = (fields: Record<string, unknown>) => Object.assign(new Error('Command failed: tmux'), fields);

const execOf = (answers: Record<string, () => Promise<{ stdout: string }>>) => async (args: string[]) => answers[args[0]]();

describe('readLocalTree', () => {
  it('reads the server pid and every pane root', async () => {
    const tree = await readLocalTree(execOf({
      'display-message': async () => ({ stdout: '4100\n' }),
      'list-panes': async () => ({ stdout: '4101 1700000000 pt-ws-test1-pane-p1-tab-aaaa\n4102 1700000000 pt-ws-test1-pane-p2-tab-bbbb\n' }),
    }));
    expect(tree).toMatchObject({ readable: true, serverPid: 4100 });
    expect(tree.readable && tree.panes.map((p) => [p.panePid, p.session])).toEqual([[4101, 'pt-ws-test1-pane-p1-tab-aaaa'], [4102, 'pt-ws-test1-pane-p2-tab-bbbb']]);
  });

  const absent = execOf({
    'display-message': async () => { throw fail({ code: 1, stderr: 'no server running on /tmp/tmux-1000/purple\n' }); },
    'list-panes': async () => ({ stdout: '' }),
  });

  it('tmux\'s own "no server running", with no tmux process left on the socket, is a known empty tree', async () => {
    expect(await readLocalTree(absent, async () => [])).toEqual({ readable: true, serverPid: null, panes: [] });
  });

  it('"no server" while a tmux process still names the socket (its file was deleted) is unreadable', async () => {
    expect(await readLocalTree(absent, async () => [4100])).toEqual({ readable: false, reason: 'socket gone, server alive (pid 4100)' });
    const listGone = execOf({
      'display-message': async () => ({ stdout: '4100\n' }),
      'list-panes': async () => { throw fail({ code: 1, stderr: 'error connecting to /tmp/tmux-1000/purple (No such file or directory)\n' }); },
    });
    expect(await readLocalTree(listGone, async () => [4100])).toEqual({ readable: false, reason: 'socket gone, server alive (pid 4100)' });
  });

  it('"no server" with a process table that cannot be read is unreadable', async () => {
    expect(await readLocalTree(absent, async () => null)).toMatchObject({ readable: false });
  });

  it('a connect error that is not absence is unreadable', async () => {
    const tree = await readLocalTree(execOf({
      'display-message': async () => { throw fail({ code: 1, stderr: 'error connecting to /tmp/tmux-1000/purple (Permission denied)\n' }); },
      'list-panes': async () => ({ stdout: '' }),
    }), async () => []);
    expect(tree).toEqual({ readable: false, reason: 'tmux display-message failed (exit 1: error connecting to /tmp/tmux-1000/purple (Permission denied))' });
  });

  it('a tmux error on the pane list is unreadable, with the reason', async () => {
    const tree = await readLocalTree(execOf({
      'display-message': async () => ({ stdout: '4100\n' }),
      'list-panes': async () => { throw fail({ code: 1, stderr: 'server exited unexpectedly\n' }); },
    }));
    expect(tree).toEqual({ readable: false, reason: 'tmux list-panes failed (exit 1: server exited unexpectedly)' });
  });

  it('a timeout is unreadable, never empty', async () => {
    const tree = await readLocalTree(execOf({
      'display-message': async () => ({ stdout: '4100\n' }),
      'list-panes': async () => { throw fail({ killed: true, signal: 'SIGTERM', code: null, stderr: '' }); },
    }));
    expect(tree).toEqual({ readable: false, reason: 'tmux list-panes timed out' });
    const server = await readLocalTree(execOf({
      'display-message': async () => { throw fail({ killed: true, signal: 'SIGTERM', code: null, stderr: '' }); },
      'list-panes': async () => ({ stdout: '' }),
    }));
    expect(server).toEqual({ readable: false, reason: 'tmux display-message timed out' });
  });

  it('a server pid or a pane line it cannot parse is unreadable', async () => {
    expect(await readLocalTree(execOf({
      'display-message': async () => ({ stdout: '\n' }),
      'list-panes': async () => ({ stdout: '' }),
    }))).toEqual({ readable: false, reason: 'tmux server pid unreadable' });
    expect(await readLocalTree(execOf({
      'display-message': async () => ({ stdout: '4100\n' }),
      'list-panes': async () => ({ stdout: 'garbage\n' }),
    }))).toMatchObject({ readable: false });
  });
});

describe('usesTmuxSocket', () => {
  it('finds -L name or -S path alone, joined or behind other flags, before the command', () => {
    for (const argv of [
      ['tmux', '-L', 'purple', 'new-session'], ['tmux', '-Lpurple'], ['tmux', '-uL', 'purple', 'ls'], ['tmux', '-f', '/x.conf', '-L', 'purple'],
      ['tmux', '-S', '/tmp/tmux-1000/purple', 'new-session'], ['tmux', '-S/tmp/tmux-1000/purple'],
    ]) expect(usesTmuxSocket(argv, 'purple', '/tmp/tmux-1000/purple')).toBe(true);
    for (const argv of [
      ['tmux', '-L', 'other'], ['tmux', 'new-session', '-L', 'purple'], ['tmux', '-f', 'purple'], ['tmux', '--', '-L', 'purple'], ['tmux'],
      ['tmux', '-S', '/tmp/tmux-1000/other'],
    ]) expect(usesTmuxSocket(argv, 'purple', '/tmp/tmux-1000/purple')).toBe(false);
  });
});

describe('liveTmuxProcesses (fake /proc)', () => {
  const procs: Record<number, { uid: number; comm: string; argv: string[] }> = {
    4100: { uid: 1000, comm: 'tmux: server', argv: ['tmux', '-L', 'purple', '-f', '/x.conf', 'new-session', '-d'] },
    4101: { uid: 1000, comm: 'tmux: server', argv: ['tmux', '-L', 'other', 'new-session'] },
    4102: { uid: 0, comm: 'tmux: server', argv: ['tmux', '-L', 'purple'] },
    4103: { uid: 1000, comm: 'bash', argv: ['bash', '-c', 'tmux -L purple attach'] },
  };
  const argvRead: number[] = [];
  const deps: ITmuxProcessDeps = {
    listPids: async () => Object.keys(procs).map(Number),
    ownerUid: async (pid) => procs[pid]?.uid ?? null,
    comm: async (pid) => procs[pid]?.comm ?? null,
    argv: async (pid) => { argvRead.push(pid); return procs[pid]?.argv ?? null; },
    uid: 1000,
  };

  it('names only this user\'s tmux processes on this socket, and reads no other process\'s argv', async () => {
    expect(await liveTmuxProcesses(deps, 'purple', '/tmp/tmux-1000/purple')).toEqual([4100]);
    expect(argvRead.sort()).toEqual([4100, 4101]);
  });

  it('a process table that cannot be listed is null, never "none"', async () => {
    expect(await liveTmuxProcesses({ ...deps, listPids: async () => { throw new Error('no /proc'); } }, 'purple', null)).toBeNull();
  });
});
