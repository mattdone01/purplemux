import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// ADR-0050 (S1): the generic branch of the Claude status hook forwards the session's messaging socket path and its
// permission mode on session-start, prompt-submit and notification. It never reads the session's messaging token.

const SOCKET = '/run/user/1000/cc-socks/4242.sock';

describe('the Claude status hook forwards the messaging address (ADR-0050)', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-hook-socket-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const run = async (event: string, stdin: string, socket: string | undefined): Promise<Record<string, unknown> | null> => {
    const { HOOK_SCRIPT_CONTENT } = await import('@/lib/hook-scripts');
    const home = path.join(dir, 'home');
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(path.join(home, '.purplemux'), { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(home, '.purplemux', 'port'), '8022');
    fs.writeFileSync(path.join(home, '.purplemux', 'cli-token'), 'tok');
    const script = path.join(dir, 'status-hook.sh');
    fs.writeFileSync(script, HOOK_SCRIPT_CONTENT);
    const captured = path.join(dir, 'payload');
    fs.rmSync(captured, { force: true });
    fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/sh\ncase "$*" in *api/status/hook*) cat > '${captured}' ;; esac\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'tmux'), '#!/bin/sh\necho pt-ws-A-pane-a-tab-1\n', { mode: 0o755 });
    const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', HOME: home, PATH: `${bin}:/usr/bin:/bin` };
    if (socket !== undefined) env.CLAUDE_CODE_MESSAGING_SOCKET = socket;
    const r = spawnSync('sh', [script, event], { input: stdin, env, encoding: 'utf-8' });
    expect(r.status).toBe(0);
    return fs.existsSync(captured) ? JSON.parse(fs.readFileSync(captured, 'utf-8')) : null;
  };

  it.each(['session-start', 'prompt-submit', 'notification'])('hook-script-forwards-socket: %s adds the socket when it matches the grammar', async (event) => {
    const payload = await run(event, JSON.stringify({ session_id: 's', permission_mode: 'bypassPermissions' }), SOCKET);
    expect(payload).toMatchObject({ event, session: 'pt-ws-A-pane-a-tab-1', socket: SOCKET, permissionMode: 'bypassPermissions' });
  });

  it('adds no socket when the variable is absent, and still forwards the event', async () => {
    const payload = await run('prompt-submit', '{}', undefined);
    expect(payload).toEqual({ event: 'prompt-submit', session: 'pt-ws-A-pane-a-tab-1' });
  });

  it.each([
    ['a relative path', 'run/user/1000/cc-socks/1.sock'],
    ['a quote', '/run/user/1000/cc"socks/1.sock'],
    ['a space', '/run/user/1000/cc socks/1.sock'],
    ['a newline', `${SOCKET}\n/x.sock`],
    ['no .sock suffix', '/run/user/1000/cc-socks/1'],
    ['a path over 106 characters before .sock', `/${'a'.repeat(107)}.sock`],
    ['an empty value', ''],
  ])('adds no socket for %s', async (_label, socket) => {
    const payload = await run('session-start', JSON.stringify({ source: 'startup' }), socket);
    expect(payload).toEqual({ event: 'session-start', session: 'pt-ws-A-pane-a-tab-1', source: 'startup' });
  });

  it('keeps the existing fields: the notification type and the session-start source', async () => {
    expect(await run('notification', JSON.stringify({ notification_type: 'idle_prompt' }), SOCKET))
      .toEqual({ event: 'notification', session: 'pt-ws-A-pane-a-tab-1', notificationType: 'idle_prompt', socket: SOCKET });
    expect(await run('session-start', JSON.stringify({ source: 'compact' }), SOCKET))
      .toEqual({ event: 'session-start', session: 'pt-ws-A-pane-a-tab-1', source: 'compact', socket: SOCKET });
  });

  it('forwards a permission mode only as a plain word', async () => {
    const payload = await run('prompt-submit', '{"permission_mode":"by\\"pass"}', SOCKET);
    expect(payload).toEqual({ event: 'prompt-submit', session: 'pt-ws-A-pane-a-tab-1', socket: SOCKET });
  });

  it.each(['pre-compact', 'post-compact', 'stop-failure'])('adds no socket on %s', async (event) => {
    const payload = await run(event, '{}', SOCKET);
    expect(payload).not.toHaveProperty('socket');
  });

  it('marks a prompt-submit whose prompt is a message from another session crossSession (D8), and no other', async () => {
    const message = JSON.stringify({ permission_mode: 'bypassPermissions', prompt: '<cross-session-message from="uds:/run/user/1000/cc-socks/1.sock" from-name="a" from-mode="bypass">\nhi\n</cross-session-message>' });
    expect(await run('prompt-submit', message, SOCKET)).toEqual({
      event: 'prompt-submit', session: 'pt-ws-A-pane-a-tab-1', socket: SOCKET, permissionMode: 'bypassPermissions', crossSession: true,
    });
    expect(await run('prompt-submit', JSON.stringify({ prompt: 'please read <cross-session-message from="x"> later' }), SOCKET)).not.toHaveProperty('crossSession');
    expect(await run('notification', message, SOCKET)).not.toHaveProperty('crossSession');
  });

  it('hook-script-never-reads-token: no script the server writes names the messaging token', async () => {
    const scripts = await import('@/lib/hook-scripts');
    for (const [name, value] of Object.entries(scripts)) {
      if (typeof value === 'string') expect(value, name).not.toContain('CLAUDE_CODE_MESSAGING_TOKEN');
    }
  });
});
