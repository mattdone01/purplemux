import { type ChildProcessWithoutNullStreams, spawn } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CODEX_HOOK_SCRIPT_CONTENT,
  GROK_HOOK_SCRIPT_CONTENT,
  HOOK_MAX_TIME_SECONDS,
  HOOK_SCRIPT_CONTENT,
  HOOK_SCRIPT_FILES,
} from '@/lib/hook-scripts';

// A hook runs on the agent's critical path: Codex waits for codex-hook.sh on every
// tool call, and Claude waits for status-hook.sh on Stop and Notification. A server
// that accepts the connection and never answers must cost at most HOOK_MAX_TIME_SECONDS
// per event. Measured 2026-09-29 (Codex Astra lane, epic ci-spot-runners): the codex
// hook had `--connect-timeout 1` and no `--max-time`, and every tool call waited
// minutes on a slow server while the tool itself finished at once.
//
// The server here is a real listener that never replies: the kernel completes the
// handshake, curl sends the request, and no response ever comes. The curl is the real one.

const SESSION = 'pt-ws-1-pane-a-tab-w';
/** Slack over the bound for process start-up on a loaded host. */
const SLACK_MS = 2_500;
/** Kill a hook that is still running here: the unbounded case, reported as a failure, not a hang. */
const KILL_MS = 15_000;

interface IRun {
  code: number | null;
  elapsedMs: number;
  killed: boolean;
}

describe('every hook POST is bounded against a server that never answers', () => {
  let server: net.Server;
  let dir: string;
  let home: string;
  let bin: string;
  const sockets: net.Socket[] = [];

  beforeAll(async () => {
    server = net.createServer((socket) => {
      sockets.push(socket); // read nothing, answer nothing
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as net.AddressInfo;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-hook-bounded-'));
    home = path.join(dir, 'home');
    bin = path.join(dir, 'bin');
    fs.mkdirSync(path.join(home, '.purplemux'), { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(home, '.purplemux', 'port'), String(port));
    fs.writeFileSync(path.join(home, '.purplemux', 'cli-token'), 'tok');
    fs.writeFileSync(path.join(bin, 'tmux'), `#!/bin/sh\necho '${SESSION}'\n`, { mode: 0o755 });
  });

  afterAll(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const run = (content: string, args: string[], stdin: string, shell: string): Promise<IRun> => {
    const script = path.join(dir, `hook-${Math.random().toString(36).slice(2)}.sh`);
    fs.writeFileSync(script, content, { mode: 0o700 });
    const started = Date.now();
    return new Promise((resolve) => {
      // stdin, stdout and stderr are pipes (the spawn default), as under Codex and Claude:
      // a hook that leaves a child holding them open also keeps its caller waiting.
      const env: Record<string, string> = { HOME: home, PATH: `${bin}:/usr/bin:/bin` };
      const child: ChildProcessWithoutNullStreams = spawn(shell, [script, ...args], { env: env as NodeJS.ProcessEnv });
      let killed = false;
      const timer = setTimeout(() => {
        killed = true;
        child.kill('SIGKILL');
      }, KILL_MS);
      child.stdout.resume();
      child.stderr.resume();
      child.on('close', (code: number | null) => {
        clearTimeout(timer);
        resolve({ code, elapsedMs: Date.now() - started, killed });
      });
      child.stdin.end(stdin);
    });
  };

  const bound = HOOK_MAX_TIME_SECONDS * 1000 + SLACK_MS;

  it.each([
    ['codex PreToolUse', CODEX_HOOK_SCRIPT_CONTENT, [], '{"hook_event_name":"PreToolUse","tool_name":"shell"}', 'bash'],
    ['codex PostToolUse', CODEX_HOOK_SCRIPT_CONTENT, [], '{"hook_event_name":"PostToolUse","tool_name":"shell"}', 'bash'],
    ['codex Stop', CODEX_HOOK_SCRIPT_CONTENT, [], '{"hook_event_name":"Stop"}', 'bash'],
    ['claude stop', HOOK_SCRIPT_CONTENT, ['stop'], '{}', 'sh'],
    ['claude notification', HOOK_SCRIPT_CONTENT, ['notification'], '{"notification_type":"idle_prompt"}', 'sh'],
    ['claude session-start', HOOK_SCRIPT_CONTENT, ['session-start'], '{"source":"startup"}', 'sh'],
    ['claude post-tool', HOOK_SCRIPT_CONTENT, ['post-tool'], '{"tool_name":"Edit"}', 'sh'],
    ['grok', GROK_HOOK_SCRIPT_CONTENT, [], '{"hookEventName":"Stop"}', 'sh'],
  ])('%s returns within the bound and exits 0', async (_name, content, args, stdin, shell) => {
    const result = await run(content, args as string[], stdin as string, shell as string);

    expect(result.killed, `still running after ${KILL_MS} ms: the POST is unbounded`).toBe(false);
    expect(result.code).toBe(0);
    expect(result.elapsedMs).toBeLessThan(bound);
  }, KILL_MS + 5_000);

  it('a timeout after the connect is not spooled: the server may have applied the event', async () => {
    const spool = path.join(home, '.purplemux', 'hook-spool');
    fs.rmSync(spool, { recursive: true, force: true });

    await run(CODEX_HOOK_SCRIPT_CONTENT, [], '{"hook_event_name":"PostToolUse"}', 'bash');

    expect(fs.existsSync(spool) ? fs.readdirSync(spool) : []).toEqual([]);
  }, KILL_MS + 5_000);
});

describe('every curl in every installed script carries --max-time', () => {
  // A static check that also covers a curl this suite does not execute (the tab-identity
  // request, the statusline). A curl command may span lines joined by a trailing backslash.
  const curlCommands = (content: string): string[] =>
    content
      .replace(/\\\n/g, ' ')
      .split('\n')
      .filter((line) => /(^|[\s|(]|\$\()curl\s/.test(line));

  it.each(HOOK_SCRIPT_FILES.map((file) => [file.name, file.content]))('%s', (_name, content) => {
    const commands = curlCommands(content as string);

    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) expect(command, command.trim()).toMatch(/--max-time\s+("?\$\{?\w+\}?"?|\d+)/);
  });

  it('post_hook bounds every POST by default, and a caller can only lower the bound', () => {
    expect(HOOK_MAX_TIME_SECONDS).toBeGreaterThan(0);
    expect(HOOK_MAX_TIME_SECONDS).toBeLessThanOrEqual(3);
    // curl keeps the LAST --max-time: the default comes before the caller's options.
    expect(CODEX_HOOK_SCRIPT_CONTENT).toMatch(new RegExp(`--max-time ${HOOK_MAX_TIME_SECONDS} "\\$@"`));
  });
});
