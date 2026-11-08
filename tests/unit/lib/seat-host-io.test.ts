import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SeatHostUnreachable } from '@/lib/context-lifecycle';
import { buildCheckpoint, GIT_FACTS_SCRIPT, sha256 } from '@/lib/rotation-checkpoint';
import { checkpointCopyPath, createSeatHostIo, type ISeatHostIoDeps } from '@/lib/seat-host-io';

vi.mock('@/lib/logger', () => {
  const logger = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => logger };
  return { createLogger: () => logger };
});

// vel-D5 AC3: a seat's files and git facts on its own host. Only ssh itself failing is a wait (SeatHostUnreachable);
// a missing file is a refusal like a local one.

const sshFailure = () => Object.assign(new Error('ssh: connect to host ai-server port 22: Connection timed out'), { code: 255, stderr: 'Connection timed out' });
const remoteExit = (code: number, stderr: string) => Object.assign(new Error('command failed'), { code, stderr });

const TEXT = '# Handoff: kit · updated 2026-11-08T10:00:00Z\n\n## Resume command\n/v2-lane kit\n';

const checkpoint = (handoffPath: string) => buildCheckpoint({
  taskId: 'seat:ws-a:kit', attempt: 1, workspaceId: 'ws-a', tabId: 'tab-kit', tabName: 'kit', host: 'ai-server', createdAt: 1,
  handoffPath, handoffText: TEXT, facts: { kind: 'no-cwd', cwd: null, worktree: null, branch: null, head: null, baseRef: null, base: null, dirty: null },
  sessionBefore: 'sess-1',
});

describe('seat host io', () => {
  let dir = '';
  let deps: ISeatHostIoDeps & { runSsh: ReturnType<typeof vi.fn>; runSshBuffer: ReturnType<typeof vi.fn>; runLocal: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-seat-io-'));
    deps = { runSsh: vi.fn(), runSshBuffer: vi.fn(), runLocal: vi.fn() } as never;
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('a remote handoff is read over ssh with the path quoted, a BOM kept', async () => {
    deps.runSshBuffer.mockResolvedValue(Buffer.from(`\ufeff${TEXT}`));
    const io = createSeatHostIo(deps);
    expect(await io.readFile('ai-server', "/srv/it's/handoff.md")).toBe(`\ufeff${TEXT}`);
    expect(deps.runSshBuffer.mock.calls[0][0]).toBe('ai-server');
    expect(deps.runSshBuffer.mock.calls[0][1]).toBe("cat -- '/srv/it'\\''s/handoff.md'");
  });

  it('ssh failing is SeatHostUnreachable; a file missing on the host is a plain refusal; bad UTF-8 is a refusal', async () => {
    const io = createSeatHostIo(deps);
    deps.runSshBuffer.mockRejectedValueOnce(sshFailure());
    await expect(io.readFile('ai-server', '/srv/h.md')).rejects.toBeInstanceOf(SeatHostUnreachable);
    deps.runSshBuffer.mockRejectedValueOnce(remoteExit(1, 'cat: /srv/h.md: No such file or directory'));
    const missing = await io.readFile('ai-server', '/srv/h.md').catch((err) => err);
    expect(missing).not.toBeInstanceOf(SeatHostUnreachable);
    expect(String(missing)).toContain('/srv/h.md cannot be read on ai-server (exit 1: cat: /srv/h.md: No such file or directory)');
    deps.runSshBuffer.mockResolvedValueOnce(Buffer.from([0xff, 0xfe]));
    await expect(io.readFile('ai-server', '/srv/h.md')).rejects.toThrow();
  });

  it('git facts run the one script: locally with sh, remotely on stdin with quoted arguments', async () => {
    deps.runLocal.mockResolvedValue('kind\tno-repo\ncwd\t/w\n');
    deps.runSsh.mockResolvedValue({ stdout: 'kind\tok\nworktree\t/srv/wt\nhead\tabc\ncontains\t1\n', stderr: '' });
    const io = createSeatHostIo(deps);
    expect(await io.gitFacts(null, '/w', null)).toMatchObject({ kind: 'no-repo', cwd: '/w' });
    expect(deps.runLocal).toHaveBeenCalledWith(['/w', '']);
    expect(await io.gitFacts('ai-server', '/srv/wt', 'abc')).toMatchObject({ kind: 'ok', worktree: '/srv/wt', head: 'abc', containsExpected: true });
    expect(deps.runSsh).toHaveBeenCalledWith('ai-server', "sh -s -- '/srv/wt' 'abc'", { timeoutMs: 15_000, input: GIT_FACTS_SCRIPT });
    deps.runSsh.mockRejectedValueOnce(sshFailure());
    await expect(io.gitFacts('ai-server', '/srv/wt', null)).rejects.toBeInstanceOf(SeatHostUnreachable);
  });

  it('places the checkpoint beside a local handoff and writes the handoff back only when it is missing or differs', async () => {
    const io = createSeatHostIo(deps);
    const file = path.join(dir, 'seats', 'kit', 'handoff.md');
    const cp = checkpoint(file);
    expect(await io.placeCheckpoint(null, cp, false)).toEqual({ restored: false });
    expect(JSON.parse(await fs.readFile(checkpointCopyPath(file), 'utf-8'))).toEqual(cp);
    await expect(fs.stat(file)).rejects.toThrow();
    expect(await io.placeCheckpoint(null, cp, true)).toEqual({ restored: true });
    expect(await fs.readFile(file, 'utf-8')).toBe(TEXT);
    expect(await io.placeCheckpoint(null, cp, true)).toEqual({ restored: false });
    await fs.writeFile(file, 'edited\n');
    expect(await io.placeCheckpoint(null, cp, true)).toEqual({ restored: true });
    expect(sha256(await fs.readFile(file, 'utf-8'))).toBe(cp.handoffDigest);
  });

  it('a remote placement writes whole files over ssh and waits when the host does not answer', async () => {
    const io = createSeatHostIo(deps);
    const cp = checkpoint('/srv/wt/handoff.md');
    deps.runSsh.mockResolvedValue({ stdout: '', stderr: '' });
    deps.runSshBuffer.mockResolvedValue(Buffer.from(TEXT));
    expect(await io.placeCheckpoint('ai-server', cp, true)).toEqual({ restored: false });
    const [host, command, opts] = deps.runSsh.mock.calls[0];
    expect(host).toBe('ai-server');
    expect(command).toBe("umask 077; mkdir -p -- \"$(dirname -- '/srv/wt/handoff.md.checkpoint.json')\" && cat > '/srv/wt/handoff.md.checkpoint.json'.tmp.$$ && mv -f -- '/srv/wt/handoff.md.checkpoint.json'.tmp.$$ '/srv/wt/handoff.md.checkpoint.json'");
    expect(JSON.parse(opts.input)).toEqual(cp);
    deps.runSshBuffer.mockRejectedValueOnce(remoteExit(1, 'No such file'));
    expect(await io.placeCheckpoint('ai-server', cp, true)).toEqual({ restored: true });
    expect(deps.runSsh.mock.calls.at(-1)?.[2].input).toBe(TEXT);
    deps.runSsh.mockRejectedValueOnce(sshFailure());
    await expect(io.placeCheckpoint('ai-server', cp, true)).rejects.toBeInstanceOf(SeatHostUnreachable);
    deps.runSshBuffer.mockRejectedValueOnce(sshFailure());
    await expect(io.placeCheckpoint('ai-server', cp, true)).rejects.toBeInstanceOf(SeatHostUnreachable);
  });
});
