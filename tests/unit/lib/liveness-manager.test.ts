import { describe, expect, it, vi } from 'vitest';
import {
  BACKGROUND_EXIT_FILE_GRACE_MS,
  LivenessManager,
  parseProbeAge,
  tailLines,
  PROBE_FAILURE_ALERT_THRESHOLD,
  type ILivenessManagerDeps,
  type IProbeRunResult,
} from '@/lib/liveness-manager';
import type { IBackgroundJob, ILivenessProbe, TLivenessEvent } from '@/types/liveness';

vi.mock('@/lib/liveness-store', () => ({
  readAllLiveness: vi.fn(async () => ({ probes: [], jobs: [] })),
  upsertProbe: vi.fn(async () => {}),
  removeProbes: vi.fn(async () => 0),
  upsertJob: vi.fn(async () => {}),
  removeJobs: vi.fn(async () => 0),
  removeTabEntries: vi.fn(async () => {}),
}));

const probe = (overrides: Partial<ILivenessProbe> = {}): ILivenessProbe => ({
  workspaceId: 'ws-1',
  tabId: 'tab-1',
  label: 'drain',
  command: 'progress-age.sh',
  stalenessThresholdS: 900,
  intervalS: 60,
  registeredAt: 0,
  ...overrides,
});

const job = (overrides: Partial<IBackgroundJob> = {}): IBackgroundJob => ({
  workspaceId: 'ws-1',
  tabId: 'tab-1',
  pid: 4242,
  label: 'drain',
  registeredAt: 0,
  ...overrides,
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

interface IHarness {
  manager: LivenessManager;
  events: TLivenessEvent[];
  tick: () => Promise<void>;
  setNow: (t: number) => void;
  deps: ILivenessManagerDeps & {
    runCommand: ReturnType<typeof vi.fn>;
    isPidAlive: ReturnType<typeof vi.fn>;
    readTail: ReturnType<typeof vi.fn>;
  };
}

const harness = (): IHarness => {
  let now = 1_000_000;
  const deps = {
    runCommand: vi.fn<(c: string, cwd: string | undefined, t: number) => Promise<IProbeRunResult>>(
      async () => ({ stdout: '0\n', stderr: '', exitCode: 0 }),
    ),
    isPidAlive: vi.fn<(pid: number) => boolean>(() => true),
    readTail: vi.fn<(file: string, maxBytes: number) => Promise<string | null>>(async () => null),
    resolveCwd: async () => '/tmp',
    now: () => now,
  };
  const manager = new LivenessManager(deps);
  const events: TLivenessEvent[] = [];
  return {
    manager,
    events,
    deps,
    tick: () => manager.tick((e) => events.push(e)),
    setNow: (t: number) => { now = t; },
  };
};

describe('parseProbeAge', () => {
  it('reads a fully numeric last non-empty line', () => {
    expect(parseProbeAge('noise\n1234\n')).toBe(1234);
    expect(parseProbeAge('noise\n42.5')).toBe(42.5);
    expect(parseProbeAge('noise\n1.5e2')).toBe(150);
    expect(parseProbeAge('0')).toBe(0);
  });

  it.each([
    '',
    '\n\n',
    'still warming up',
    'last_done_s_ago: 42.5',
    '-1',
    'NaN',
    'Infinity',
    '1e309',
  ])('rejects invalid age output %j', (output) => {
    expect(parseProbeAge(output)).toBeNull();
  });
});

describe('tailLines', () => {
  it('keeps the last N non-blank lines', () => {
    expect(tailLines('a\nb\n\nc\nd\n', 2)).toBe('c\nd');
  });
});

describe('probe stall episodes', () => {
  it('fresh probe emits nothing', async () => {
    const h = harness();
    await h.manager.registerProbe(probe());
    h.deps.runCommand.mockResolvedValue({ stdout: '30\n', stderr: '', exitCode: 0 });
    await h.tick();
    expect(h.events).toEqual([]);
    const { probes } = await h.manager.statusForTab('tab-1');
    expect(probes[0]).toMatchObject({ lastAgeS: 30, stale: false, consecutiveFailures: 0 });
  });

  it('stall fires once, re-fires after another threshold of silence, resets on fresh', async () => {
    const h = harness();
    await h.manager.registerProbe(probe({ stalenessThresholdS: 900, intervalS: 60 }));

    h.deps.runCommand.mockResolvedValue({ stdout: '1000\n', stderr: '', exitCode: 0 });
    await h.tick();
    expect(h.events.map((e) => e.kind)).toEqual(['stalled']);

    // Same episode, age not yet a full threshold beyond the last alert: silent.
    h.setNow(1_000_000 + 61_000);
    h.deps.runCommand.mockResolvedValue({ stdout: '1500\n', stderr: '', exitCode: 0 });
    await h.tick();
    expect(h.events).toHaveLength(1);

    // A further threshold of silence re-alerts — an ignored stall stays loud.
    h.setNow(1_000_000 + 122_000);
    h.deps.runCommand.mockResolvedValue({ stdout: '1901\n', stderr: '', exitCode: 0 });
    await h.tick();
    expect(h.events).toHaveLength(2);

    // Fresh again closes the episode; the next stall is a new first alert.
    h.setNow(1_000_000 + 183_000);
    h.deps.runCommand.mockResolvedValue({ stdout: '10\n', stderr: '', exitCode: 0 });
    await h.tick();
    h.setNow(1_000_000 + 244_000);
    h.deps.runCommand.mockResolvedValue({ stdout: '950\n', stderr: '', exitCode: 0 });
    await h.tick();
    expect(h.events).toHaveLength(3);
    expect(h.events.every((e) => e.kind === 'stalled')).toBe(true);
  });

  it('respects the probe interval', async () => {
    const h = harness();
    await h.manager.registerProbe(probe({ intervalS: 300 }));
    await h.tick();
    expect(h.deps.runCommand).toHaveBeenCalledTimes(1);
    h.setNow(1_000_000 + 60_000);
    await h.tick();
    expect(h.deps.runCommand).toHaveBeenCalledTimes(1);
    h.setNow(1_000_000 + 301_000);
    await h.tick();
    expect(h.deps.runCommand).toHaveBeenCalledTimes(2);
  });
});

describe('probe failures', () => {
  it('alerts once after the failure threshold and resets on success', async () => {
    const h = harness();
    await h.manager.registerProbe(probe({ intervalS: 60 }));
    h.deps.runCommand.mockResolvedValue({ stdout: '', stderr: 'boom', exitCode: 1 });

    for (let i = 0; i < PROBE_FAILURE_ALERT_THRESHOLD + 1; i++) {
      h.setNow(1_000_000 + i * 61_000);
      await h.tick();
    }
    expect(h.events.map((e) => e.kind)).toEqual(['probe-failed']);
    const failed = h.events[0] as Extract<TLivenessEvent, { kind: 'probe-failed' }>;
    expect(failed.failures).toBe(PROBE_FAILURE_ALERT_THRESHOLD);
    expect(failed.error).toContain('boom');

    // Recovery clears the failure episode.
    h.setNow(2_000_000);
    h.deps.runCommand.mockResolvedValue({ stdout: '5\n', stderr: '', exitCode: 0 });
    await h.tick();
    const { probes } = await h.manager.statusForTab('tab-1');
    expect(probes[0]).toMatchObject({ consecutiveFailures: 0, lastError: null, lastAgeS: 5 });
  });

  it('treats exit-0 non-numeric output as a failure, not as fresh', async () => {
    const h = harness();
    await h.manager.registerProbe(probe({ intervalS: 60 }));
    h.deps.runCommand.mockResolvedValue({ stdout: 'no rows\n', stderr: '', exitCode: 0 });
    for (let i = 0; i < PROBE_FAILURE_ALERT_THRESHOLD; i++) {
      h.setNow(1_000_000 + i * 61_000);
      await h.tick();
    }
    expect(h.events.map((e) => e.kind)).toEqual(['probe-failed']);
  });
});

describe('background jobs', () => {
  it('emits bg-failed once with a strict nonzero exit code and stderr tail, then forgets the pid', async () => {
    const h = harness();
    await h.manager.registerJob(job({ stderrFile: '/tmp/j.err', exitCodeFile: '/tmp/j.exit' }));
    h.deps.isPidAlive.mockReturnValue(false);
    h.deps.readTail.mockImplementation(async (file: string) =>
      file === '/tmp/j.exit' ? '137\n' : 'line1\nline2\nfatal: attest failed\n');

    await h.tick();
    expect(h.events).toHaveLength(1);
    const died = h.events[0] as Extract<TLivenessEvent, { kind: 'bg-failed' }>;
    expect(died.kind).toBe('bg-failed');
    expect(died.exitCode).toBe(137);
    expect(died.stderrTail).toContain('fatal: attest failed');

    // One-shot: the corpse is not renotified on the next tick.
    await h.tick();
    expect(h.events).toHaveLength(1);
    const { backgroundJobs } = await h.manager.statusForTab('tab-1');
    expect(backgroundJobs).toEqual([]);
  });

  it('reports alive jobs in statusForTab and stays silent', async () => {
    const h = harness();
    await h.manager.registerJob(job());
    await h.tick();
    expect(h.events).toEqual([]);
    const { backgroundJobs } = await h.manager.statusForTab('tab-1');
    expect(backgroundJobs[0]).toMatchObject({ pid: 4242, alive: true });
  });

  it('emits bg-completed for exit zero without removing the tab probes', async () => {
    const h = harness();
    await h.manager.registerProbe(probe({ label: 'ongoing' }));
    await h.manager.registerProbe(probe({ label: 'other' }));
    await h.manager.registerJob(job({ exitCodeFile: '/tmp/j.exit' }));
    h.deps.isPidAlive.mockReturnValue(false);
    h.deps.readTail.mockResolvedValue('0\n');

    await h.tick();

    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({ kind: 'bg-completed', exitCode: 0 });
    const { probes, backgroundJobs } = await h.manager.statusForTab('tab-1');
    expect(probes.map((p) => p.label).sort()).toEqual(['ongoing', 'other']);
    expect(backgroundJobs).toEqual([]);
  });

  it.each(['137 trailing', 'exit 137', '1.5', '1e2'])('rejects malformed exit code %j', async (exitOutput) => {
    const h = harness();
    await h.manager.registerJob(job({ exitCodeFile: '/tmp/j.exit' }));
    h.deps.isPidAlive.mockReturnValue(false);
    h.deps.readTail.mockResolvedValue(exitOutput);

    await h.tick();
    expect(h.events).toEqual([]);
    h.setNow(1_000_000 + BACKGROUND_EXIT_FILE_GRACE_MS);
    await h.tick();

    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({ kind: 'bg-exited-unknown' });
  });

  it('rejects an oversized exit file whose truncated tail looks like exit zero', async () => {
    const h = harness();
    const exitOutput = `x${' '.repeat(63)}0`;
    await h.manager.registerJob(job({ exitCodeFile: '/tmp/j.exit' }));
    h.deps.isPidAlive.mockReturnValue(false);
    h.deps.readTail.mockImplementation(async (_file: string, maxBytes: number) => exitOutput.slice(-maxBytes));

    await h.tick();
    expect(h.events).toEqual([]);
    h.setNow(1_000_000 + BACKGROUND_EXIT_FILE_GRACE_MS);
    await h.tick();

    expect(h.deps.readTail).toHaveBeenCalledWith('/tmp/j.exit', 65);
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({ kind: 'bg-exited-unknown' });
  });

  it('allows a bounded grace period for a delayed exit file', async () => {
    const h = harness();
    await h.manager.registerJob(job({ exitCodeFile: '/tmp/j.exit' }));
    h.deps.isPidAlive.mockReturnValue(false);
    h.deps.readTail.mockResolvedValueOnce(null).mockResolvedValueOnce('0\n');

    await h.tick();
    expect(h.events).toEqual([]);
    h.setNow(1_000_000 + BACKGROUND_EXIT_FILE_GRACE_MS - 1);
    await h.tick();

    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({ kind: 'bg-completed', exitCode: 0 });
  });

  it('emits bg-exited-unknown once when exit/stderr files remain missing after grace', async () => {
    const h = harness();
    await h.manager.registerJob(job({ stderrFile: '/tmp/gone.err', exitCodeFile: '/tmp/gone.exit' }));
    h.deps.isPidAlive.mockReturnValue(false);
    h.deps.readTail.mockResolvedValue(null);
    await h.tick();
    expect(h.events).toEqual([]);
    h.setNow(1_000_000 + BACKGROUND_EXIT_FILE_GRACE_MS);
    await h.tick();
    const died = h.events[0] as Extract<TLivenessEvent, { kind: 'bg-exited-unknown' }>;
    expect(died.stderrTail).toBeNull();
    await h.tick();
    expect(h.events).toHaveLength(1);
  });

  it('emits once when overlapping ticks inspect the same dead registration', async () => {
    const h = harness();
    const exitRead = deferred<string | null>();
    const bothReading = deferred<void>();
    let reads = 0;
    await h.manager.registerJob(job({ exitCodeFile: '/tmp/j.exit' }));
    h.deps.isPidAlive.mockReturnValue(false);
    h.deps.readTail.mockImplementation(async () => {
      reads += 1;
      if (reads === 2) bothReading.resolve();
      return exitRead.promise;
    });

    const first = h.tick();
    const second = h.tick();
    await bothReading.promise;
    exitRead.resolve('0\n');
    await Promise.all([first, second]);

    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({ kind: 'bg-completed' });
    expect((await h.manager.statusForTab('tab-1')).backgroundJobs).toEqual([]);
  });

  it('does not delete or report a same-pid registration replaced during an in-flight tick', async () => {
    const h = harness();
    const exitRead = deferred<string | null>();
    const reading = deferred<void>();
    const replacement = job({ label: 'replacement', registeredAt: 1_000_001, exitCodeFile: '/tmp/new.exit' });
    await h.manager.registerJob(job({ label: 'original', exitCodeFile: '/tmp/old.exit' }));
    h.deps.isPidAlive.mockReturnValue(false);
    h.deps.readTail.mockImplementation(async () => {
      reading.resolve();
      return exitRead.promise;
    });

    const staleTick = h.tick();
    await reading.promise;
    await h.manager.registerJob(replacement);
    exitRead.resolve('0\n');
    await staleTick;

    expect(h.events).toEqual([]);
    expect((await h.manager.statusForTab('tab-1')).backgroundJobs).toEqual([
      expect.objectContaining({ pid: 4242, label: 'replacement', registeredAt: 1_000_001 }),
    ]);
  });
});

describe('unregistration', () => {
  it('removeTab drops all of a tab\'s registrations', async () => {
    const h = harness();
    await h.manager.registerProbe(probe());
    await h.manager.registerJob(job());
    h.manager.removeTab('ws-1', 'tab-1');
    await new Promise((r) => setTimeout(r, 0));
    const { probes, backgroundJobs } = await h.manager.statusForTab('tab-1');
    expect(probes).toEqual([]);
    expect(backgroundJobs).toEqual([]);
  });

  it('unregisterProbes by label removes only that probe', async () => {
    const h = harness();
    await h.manager.registerProbe(probe({ label: 'a' }));
    await h.manager.registerProbe(probe({ label: 'b' }));
    await h.manager.unregisterProbes('ws-1', 'tab-1', 'a');
    const { probes } = await h.manager.statusForTab('tab-1');
    expect(probes.map((p) => p.label)).toEqual(['b']);
  });
});
