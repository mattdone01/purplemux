import { afterEach, describe, expect, it } from 'vitest';
import { hostWarnings, readHostMetrics, type IHostMetricsDeps } from '@/lib/host-metrics';
import { HOST_SIGNALS_STALE_MS, hostSignalsView, parseHostSignals, resetHostSignals, runHostSignalsOnce } from '@/lib/host-signals';

// Story 20: host pressure (statfs) and the optional host-signal command.

const GB = 1024 ** 3;
const fs = (usedPct: number, inodesPct = 10, total = 1000) => ({
  bsize: GB, blocks: total, bfree: total - (total * usedPct) / 100, bavail: total - (total * usedPct) / 100, files: 1000, ffree: 1000 - inodesPct * 10,
});
const deps = (over: Partial<IHostMetricsDeps> = {}): IHostMetricsDeps => ({
  platform: 'linux',
  statfs: async (p) => (p === '/' ? fs(99) : p === '/tmp' ? fs(5, 90) : fs(99)),
  loadavg: () => [1.5, 2, 3],
  meminfo: async () => 'MemTotal: 100 kB\nMemAvailable:   2048 kB\n',
  freemem: () => 1,
  purplemuxDir: '/home/u/.purplemux',
  ...over,
});

describe('host metrics', () => {
  it('reads disk %, free bytes and inodes; 99 % disk and 90 % /tmp inodes are warnings', async () => {
    const host = await readHostMetrics(deps());
    expect(host).toMatchObject({ available: true, disks: [{ path: '/', usedPct: 99, freeBytes: 10 * GB, inodesUsedPct: 10 }], tmpInodesUsedPct: 90, loadAverage: [1.5, 2, 3], memAvailableBytes: 2048 * 1024 });
    const warn = hostWarnings(host);
    expect([...warn.disks]).toEqual(['/']);
    expect(warn.tmpInodes).toBe(true);
    expect(warn.inodes.size).toBe(0);
  });

  it('lists the ~/.purplemux filesystem separately only when it differs from /', async () => {
    const host = await readHostMetrics(deps({ statfs: async (p) => (p === '/' ? fs(40) : p === '/tmp' ? fs(5) : fs(70)) }));
    expect(host.available && host.disks.map((d) => [d.path, d.usedPct])).toEqual([['/', 40], ['/home/u/.purplemux', 70]]);
    expect([...hostWarnings(host).disks]).toEqual([]);
  });

  it('thresholds: disk ≥ 90 % and inodes ≥ 85 % warn; just below does not', async () => {
    const at = await readHostMetrics(deps({ statfs: async () => fs(90, 85) }));
    expect(hostWarnings(at)).toMatchObject({ tmpInodes: true });
    expect([...hostWarnings(at).disks]).toEqual(['/']);
    expect([...hostWarnings(at).inodes]).toEqual(['/']);
    const below = await readHostMetrics(deps({ statfs: async () => fs(89.9, 84.9) }));
    expect(hostWarnings(below)).toMatchObject({ tmpInodes: false });
    expect(hostWarnings(below).disks.size + hostWarnings(below).inodes.size).toBe(0);
  });

  it('is unavailable off Linux (NFR-7), never zeros', async () => {
    expect(await readHostMetrics(deps({ platform: 'darwin' }))).toEqual({ available: false, reason: 'host metrics are Linux only (this host is darwin)' });
  });
});

const VALID = { schemaVersion: 1, stampedAt: 1790000000000, gateSlots: { total: 6, held: 2, holders: [{ pid: 123, log: '/abs/log' }] }, worktrees: [{ repo: 'treasury-ui', count: 374, byEpic: { 'pft-1386-1397': 12 } }], tmpInodesPct: 41.2 };

describe('host signals', () => {
  afterEach(() => resetHostSignals());
  const clock = { now: 1_000_000 };
  const run = (command: string | null, out: { stdout: string } | { error: string }) =>
    runHostSignalsOnce({ now: () => clock.now, command: async () => command, run: async () => out });

  it('parses the pinned schema; unknown keys are ignored', () => {
    expect(parseHostSignals(JSON.stringify({ ...VALID, extra: 'x' }))).toMatchObject({ ok: true, value: { gateSlots: { total: 6, held: 2 } } });
  });

  it.each([
    ['not JSON', '{nope', /^not JSON/],
    ['a missing required key', JSON.stringify({ ...VALID, tmpInodesPct: undefined }), /^invalid: tmpInodesPct/],
    ['a wrong schema version', JSON.stringify({ ...VALID, schemaVersion: 2 }), /^invalid: schemaVersion/],
  ])('refuses %s with the validation error', (_label, stdout, error) => {
    const r = parseHostSignals(stdout);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(error);
  });

  it('no command: "not configured"; a valid run: its values and stamp; stale after 15 min', async () => {
    await run(null, { stdout: '' });
    expect(hostSignalsView(clock.now)).toEqual({ state: 'not-configured' });
    await run('host-signals.py', { stdout: JSON.stringify(VALID) });
    expect(hostSignalsView(clock.now)).toMatchObject({ state: 'ok', ranAt: 1_000_000, stale: false, value: { tmpInodesPct: 41.2 } });
    expect(hostSignalsView(clock.now + HOST_SIGNALS_STALE_MS + 1)).toMatchObject({ state: 'ok', stale: true });
  });

  it('invalid JSON or a failing command shows the error, never zeros', async () => {
    await run('host-signals.py', { stdout: '{"schemaVersion":1}' });
    expect(hostSignalsView(clock.now)).toMatchObject({ state: 'error', error: expect.stringMatching(/^invalid: /) });
    await run('host-signals.py', { error: 'timed out after 10 s' });
    expect(hostSignalsView(clock.now)).toEqual({ state: 'error', error: 'command failed: timed out after 10 s', ranAt: 1_000_000, stale: false });
  });

  it('the real runner: a shell command\'s JSON is read; a failing command reports its exit and stderr', async () => {
    const { defaultHostSignalsDeps } = await import('@/lib/host-signals');
    const real = defaultHostSignalsDeps();
    await runHostSignalsOnce({ ...real, now: () => 5, command: async () => `printf '%s' '${JSON.stringify(VALID)}'` });
    expect(hostSignalsView(5)).toMatchObject({ state: 'ok', value: { gateSlots: { held: 2 } } });
    await runHostSignalsOnce({ ...real, now: () => 6, command: async () => 'echo broken >&2; exit 3' });
    expect(hostSignalsView(6)).toMatchObject({ state: 'error', error: expect.stringMatching(/^command failed: .*broken/) });
  });
});
