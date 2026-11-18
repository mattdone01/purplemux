import { describe, expect, it } from 'vitest';
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

  it('tmux\'s own "no server running" is a known empty tree', async () => {
    const tree = await readLocalTree(execOf({
      'display-message': async () => { throw fail({ code: 1, stderr: 'no server running on /tmp/tmux-1000/purple\n' }); },
      'list-panes': async () => ({ stdout: '' }),
    }));
    expect(tree).toEqual({ readable: true, serverPid: null, panes: [] });
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
