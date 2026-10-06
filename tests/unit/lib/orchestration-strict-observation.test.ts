import { beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ output: '', failure: null as unknown, read: vi.fn() }));
vi.mock('child_process', () => ({ execFile: (_bin: string, _args: string[], _opts: unknown, callback: (error: unknown, result: { stdout: string; stderr: string }) => void) => callback(fixture.failure, { stdout: fixture.output, stderr: '' }) }));
// promisify(execFile) needs the native custom signature; this stub supplies the same object shape.
vi.mock('fs/promises', () => ({ default: { readFile: fixture.read } }));
vi.mock('@/lib/platform', () => ({ isLinux: true }));
import { observeProviderProcess } from '@/lib/process-utils';
import { observeSessionStrict } from '@/lib/tmux';
beforeEach(() => { fixture.output = ''; fixture.failure = null; fixture.read.mockReset(); });
describe('strict low-level runtime proof', () => {
  it('only accepts an exact explicit missing-session response as absent', async () => {
    fixture.failure = { code: 1, stderr: "can't find session: target" };
    expect(await observeSessionStrict('target')).toMatchObject({ state: 'absent' });
    for (const error of [{ code: 1, stderr: 'no server running' }, { code: 1, stderr: "can't find session: other" }, { code: 1, stderr: "can't find session: target", killed: true }, { code: 'EACCES' }]) {
      fixture.failure = error; expect(await observeSessionStrict('target')).toMatchObject({ state: 'unknown' });
    }
  });
  it('requires an unambiguous matching session and pane identity', async () => {
    fixture.output = 'target\t%4\t40\n'; expect(await observeSessionStrict('target')).toMatchObject({ state: 'present', panePid: 40 });
    for (const output of ['', 'other\t%4\t40', 'target\t%4\t0', 'target\t%4\t40\ntarget\t%5\t41']) {
      fixture.output = output; expect(await observeSessionStrict('target')).toMatchObject({ state: 'unknown' });
    }
  });
  it('distinguishes a shell without a provider from unreadable process evidence', async () => {
    fixture.output = '40 1 bash'; fixture.read.mockResolvedValue(Buffer.from('/bin/bash\0'));
    expect(await observeProviderProcess(40, 'claude')).toMatchObject({ state: 'absent' });
    fixture.read.mockRejectedValue(new Error('permission'));
    expect(await observeProviderProcess(40, 'claude')).toMatchObject({ state: 'unknown' });
    fixture.failure = new Error('timeout'); expect(await observeProviderProcess(40, 'claude')).toMatchObject({ state: 'unknown' });
  });
  it('binds the current provider PID and start generation; another session does not count', async () => {
    fixture.output = '40 1 bash\n41 40 claude\n50 1 claude';
    fixture.read.mockImplementation(async (file: string) => file.endsWith('/stat') ? '41 (claude) '+['S', ...Array(18).fill('0'), '123'].join(' ') : Buffer.from(file.includes('/40/') ? '/bin/bash\0' : '/bin/claude\0'));
    expect(await observeProviderProcess(40, 'claude')).toEqual({ state: 'present', identity: '41:123:claude' });
    fixture.output = '40 1 bash\n50 1 claude'; expect(await observeProviderProcess(40, 'claude')).toMatchObject({ state: 'absent' });
  });
});
