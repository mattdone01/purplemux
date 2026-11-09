import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ICaller } from '@/lib/caller';

// vel-D61: one ssh over a DERP relay took 18-25 s, and ADR-0022 §5 gave a tmux call or a host check 5 s. The
// budget is now a fleet value, per host or fleet-wide, with the 5 s default as its floor; every other remote
// budget and ssh's ConnectTimeout scale with it, so an unset key changes nothing.

interface ISpawn { args: string[]; timeout: number }
const spawned = vi.hoisted(() => ({ list: [] as ISpawn[] }));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  type TCallback = (err: Error | null, stdout: string | Buffer, stderr: string) => void;
  const execFile = (_cmd: string, args: string[], opts: { timeout: number; encoding?: string }, cb: TCallback) => {
    spawned.list.push({ args, timeout: opts.timeout });
    queueMicrotask(() => cb(null, opts.encoding === 'buffer' ? Buffer.from('ok') : 'ok', ''));
    return { stdin: { on: () => {}, end: () => {} } };
  };
  return { ...actual, default: { ...actual, execFile }, execFile };
});

let directory = '';
let home: ReturnType<typeof vi.spyOn>;
const admin: ICaller = { scope: { type: 'admin' } as ICaller['scope'], workspaceId: null, tabId: null, tabName: null, verified: false, identity: 'none', admin: true };
const orchestrator: ICaller = { scope: { type: 'workspace', workspaceId: 'ws-a' } as ICaller['scope'], workspaceId: 'ws-a', tabId: 'tab-o', tabName: 'o', verified: true, identity: 'launch', admin: false };
const authority = { isWorkspaceOrchestrator: vi.fn(async () => true), now: () => 1 };

const set = async (key: string, value: string) => {
  const { mutateFleetConfig, setValue } = await import('@/lib/fleet-config-store');
  await mutateFleetConfig((state) => setValue(state, { key, value }, { workspaceId: null, tabId: null, admin: true }, Date.now()));
};

const connectTimeout = (args: string[]): string | undefined => args.find((a) => a.startsWith('ConnectTimeout='));

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-remote-timeouts-'));
  home = vi.spyOn(os, 'homedir').mockReturnValue(directory);
  delete (globalThis as Record<string, unknown>).__ptFleetConfigLock;
  spawned.list = [];
});

afterEach(() => {
  home.mockRestore();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('the remote ssh budget (vel-D61)', () => {
  it('parses whole milliseconds from the 5000 ms floor to 120000 ms, and nothing else', async () => {
    const { parseRemoteTimeoutMs } = await import('@/lib/remote-timeouts');
    expect(parseRemoteTimeoutMs('5000')).toBe(5000);
    expect(parseRemoteTimeoutMs(' 30000 ')).toBe(30_000);
    expect(parseRemoteTimeoutMs('120000')).toBe(120_000);
    for (const bad of ['4999', '0', '120001', '30s', '30000.5', '-30000', '', null, undefined, '1e5']) {
      expect(parseRemoteTimeoutMs(bad), String(bad)).toBeNull();
    }
  });

  it('the per-host key wins over the fleet key, and an invalid stored value falls through', async () => {
    const { remoteTimeoutMsIn } = await import('@/lib/remote-timeouts');
    const state = (values: Record<string, string>) => ({
      values: Object.fromEntries(Object.entries(values).map(([k, value]) => [k, { value, version: 1, setAt: 1, setBy: { workspaceId: null, tabId: null, admin: true } }])),
      versions: {},
      history: [],
    });
    expect(remoteTimeoutMsIn(state({}), 'agent-exec-v2')).toBe(5000);
    expect(remoteTimeoutMsIn(state({ 'remote.timeout-ms': '20000' }), 'agent-exec-v2')).toBe(20_000);
    expect(remoteTimeoutMsIn(state({ 'remote.timeout-ms': '20000', 'remote.timeout-ms.agent-exec-v2': '40000' }), 'agent-exec-v2')).toBe(40_000);
    expect(remoteTimeoutMsIn(state({ 'remote.timeout-ms': '20000', 'remote.timeout-ms.agent-exec-v2': '40000' }), 'ai-server')).toBe(20_000);
    expect(remoteTimeoutMsIn(state({ 'remote.timeout-ms': '20000', 'remote.timeout-ms.ai-server': '1000' }), 'ai-server')).toBe(20_000);
  });

  it('scales a call budget and the connect timeout by the ratio to the default', async () => {
    const { remoteBudget } = await import('@/lib/remote-timeouts');
    expect(remoteBudget(5000, 5000)).toEqual({ timeoutMs: 5000, connectTimeoutS: 5 });
    expect(remoteBudget(20_000, 5000)).toEqual({ timeoutMs: 20_000, connectTimeoutS: 5 });
    expect(remoteBudget(5000, 30_000)).toEqual({ timeoutMs: 30_000, connectTimeoutS: 30 });
    expect(remoteBudget(10_000, 30_000)).toEqual({ timeoutMs: 60_000, connectTimeoutS: 30 });
    expect(remoteBudget(20_000, 7500)).toEqual({ timeoutMs: 30_000, connectTimeoutS: 8 });
  });

  it('unset: runSsh and runSshBuffer keep the budgets ADR-0022 §5 names', async () => {
    const { runSsh, runSshBuffer } = await import('@/lib/remote-host');
    await runSsh('agent-exec-v2', 'true', { timeoutMs: 5000 });
    await runSsh('agent-exec-v2', 'sh -s', { timeoutMs: 20_000 });
    await runSshBuffer('agent-exec-v2', 'cat x', { timeoutMs: 10_000, maxBytes: 16 });
    expect(spawned.list.map((s) => s.timeout)).toEqual([5000, 20_000, 10_000]);
    expect(spawned.list.map((s) => connectTimeout(s.args))).toEqual(['ConnectTimeout=5', 'ConnectTimeout=5', 'ConnectTimeout=5']);
  });

  it('set for one host: that host scales, another keeps the default, at the next call with no restart', async () => {
    const { runSsh, runSshBuffer } = await import('@/lib/remote-host');
    await set('remote.timeout-ms.agent-exec-harness', '30000');
    await runSsh('agent-exec-harness', 'true', { timeoutMs: 5000 });
    await runSshBuffer('agent-exec-harness', 'cat x', { timeoutMs: 10_000, maxBytes: 16 });
    await runSsh('agent-exec-v2', 'true', { timeoutMs: 5000 });
    expect(spawned.list.map((s) => [s.args[s.args.indexOf('--') + 1], s.timeout, connectTimeout(s.args)])).toEqual([
      ['agent-exec-harness', 30_000, 'ConnectTimeout=30'],
      ['agent-exec-harness', 60_000, 'ConnectTimeout=30'],
      ['agent-exec-v2', 5000, 'ConnectTimeout=5'],
    ]);
  });

  it('a fleet store that cannot be read gives the default budget, never a shorter one, and the call still runs', async () => {
    fs.mkdirSync(path.join(directory, '.purplemux'), { recursive: true });
    fs.writeFileSync(path.join(directory, '.purplemux', 'fleet-config.json'), '{ not json');
    const { runSsh } = await import('@/lib/remote-host');
    await expect(runSsh('agent-exec-v2', 'true', { timeoutMs: 5000 })).resolves.toEqual({ stdout: 'ok', stderr: '' });
    expect(spawned.list.map((s) => [s.timeout, connectTimeout(s.args)])).toEqual([[5000, 'ConnectTimeout=5']]);
  });

  it('sshArgv keeps ConnectTimeout=5 when no budget is given (the attach)', async () => {
    const { sshArgv } = await import('@/lib/remote-host');
    expect(connectTimeout(sshArgv('agent-exec-v2', 'x', { tty: true }))).toBe('ConnectTimeout=5');
    expect(connectTimeout(sshArgv('agent-exec-v2', 'x', { connectTimeoutS: 25 }))).toBe('ConnectTimeout=25');
  });
});

describe('the remote timeout keys are admin-only and checked at write time', () => {
  it.each([
    ['remote.timeout-ms', '5000'],
    ['remote.timeout-ms', '30000'],
    ['remote.timeout-ms.agent-exec-v2', '120000'],
    ['remote.timeout-ms.ai_server.tail', '25000'],
  ])('the admin sets %s=%s', async (key, value) => {
    const { putValue } = await import('@/lib/fleet-config-http');
    expect(await putValue(admin, key, { value }, authority)).toMatchObject({ key, changed: true, value: { value } });
  });

  it('an orchestrator may not set remote.timeout-ms', async () => {
    const { putValue } = await import('@/lib/fleet-config-http');
    await expect(putValue(orchestrator, 'remote.timeout-ms', { value: '30000' }, authority)).rejects.toMatchObject({ code: 'forbidden' });
  });

  it.each([
    ['remote.timeout-ms', '4999', 'whole milliseconds 5000..120000'],
    ['remote.timeout-ms', '30s', 'whole milliseconds 5000..120000'],
    ['remote.timeout-ms', '120001', 'whole milliseconds 5000..120000'],
    ['remote.timeout-ms.agent-exec-v2', '1000', 'whole milliseconds 5000..120000'],
    ['remote.timeout-ms.-oProxyCommand', '30000', 'not a timeout key'],
    ['remote.timeout-ms.', '30000', 'not a timeout key'],
  ])('%s=%j is refused (%s)', async (key, value, message) => {
    const { putValue } = await import('@/lib/fleet-config-http');
    await expect(putValue(admin, key, { value }, authority)).rejects.toMatchObject({ code: 'config-invalid', message: expect.stringContaining(message) });
  });
});
