// Watches the WORK, not the pane. A tab that is idle-holding while its
// background job is dead looks identical to an idle healthy one — these
// registrations are how the watchdog tells them apart.
import { execFile } from 'child_process';
import fs from 'fs/promises';
import { createLogger } from '@/lib/logger';
import {
  readAllLiveness,
  upsertProbe,
  removeProbes,
  upsertJob,
  removeJobs,
  removeTabEntries,
} from '@/lib/liveness-store';
import type {
  IBackgroundJob,
  IBackgroundJobStatus,
  ILivenessProbe,
  IProbeStatus,
  TLivenessEvent,
} from '@/types/liveness';

const log = createLogger('liveness');

export const PROBE_TIMEOUT_MS = 15_000;
export const PROBE_FAILURE_ALERT_THRESHOLD = 3;
export const STDERR_TAIL_BYTES = 2_048;
export const STDERR_TAIL_LINES = 10;

export interface IProbeRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ILivenessManagerDeps {
  runCommand: (command: string, cwd: string | undefined, timeoutMs: number) => Promise<IProbeRunResult>;
  isPidAlive: (pid: number) => boolean;
  readTail: (file: string, maxBytes: number) => Promise<string | null>;
  resolveCwd: (workspaceId: string) => Promise<string | undefined>;
  now: () => number;
}

/**
 * Seconds-since-last-progress from a probe's stdout: the first number on the
 * last non-empty line. Anything else is a probe defect, reported as a failure
 * rather than silently treated as fresh.
 */
export const parseProbeAge = (stdout: string): number | null => {
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1];
  if (!last) return null;
  const match = /\d+(\.\d+)?/.exec(last);
  if (!match) return null;
  const age = Number(match[0]);
  return Number.isFinite(age) ? age : null;
};

export const tailLines = (raw: string, maxLines: number): string =>
  raw.split('\n').filter((l) => l.trim().length > 0).slice(-maxLines).join('\n');

interface IProbeRuntime {
  lastRunAt: number | null;
  lastAgeS: number | null;
  stale: boolean;
  consecutiveFailures: number;
  lastError: string | null;
  /** Age at the last stalled alert; re-alerts one threshold later so an ignored stall stays loud. */
  lastAlertAgeS: number | null;
  failureAlerted: boolean;
  running: boolean;
}

const freshRuntime = (): IProbeRuntime => ({
  lastRunAt: null,
  lastAgeS: null,
  stale: false,
  consecutiveFailures: 0,
  lastError: null,
  lastAlertAgeS: null,
  failureAlerted: false,
  running: false,
});

const probeKey = (p: Pick<ILivenessProbe, 'workspaceId' | 'tabId' | 'label'>): string =>
  `${p.workspaceId}/${p.tabId}/${p.label}`;
const jobKey = (j: Pick<IBackgroundJob, 'workspaceId' | 'tabId' | 'pid'>): string =>
  `${j.workspaceId}/${j.tabId}/${j.pid}`;

export class LivenessManager {
  private probes = new Map<string, { probe: ILivenessProbe; runtime: IProbeRuntime }>();
  private jobs = new Map<string, IBackgroundJob>();
  private hydrated: Promise<void> | null = null;

  constructor(private deps: ILivenessManagerDeps) {}

  private ensureHydrated(): Promise<void> {
    if (!this.hydrated) {
      this.hydrated = readAllLiveness().then(({ probes, jobs }) => {
        for (const probe of probes) {
          if (!this.probes.has(probeKey(probe))) {
            this.probes.set(probeKey(probe), { probe, runtime: freshRuntime() });
          }
        }
        for (const job of jobs) {
          if (!this.jobs.has(jobKey(job))) this.jobs.set(jobKey(job), job);
        }
      }).catch((err) => {
        log.warn(`hydrate failed: ${err instanceof Error ? err.message : err}`);
      });
    }
    return this.hydrated;
  }

  async registerProbe(probe: ILivenessProbe): Promise<void> {
    await this.ensureHydrated();
    this.probes.set(probeKey(probe), { probe, runtime: freshRuntime() });
    await upsertProbe(probe);
  }

  async unregisterProbes(workspaceId: string, tabId: string, label?: string): Promise<number> {
    await this.ensureHydrated();
    for (const [key, { probe }] of this.probes) {
      if (probe.workspaceId === workspaceId && probe.tabId === tabId && (label === undefined || probe.label === label)) {
        this.probes.delete(key);
      }
    }
    return removeProbes(workspaceId, tabId, label);
  }

  async registerJob(job: IBackgroundJob): Promise<void> {
    await this.ensureHydrated();
    this.jobs.set(jobKey(job), job);
    await upsertJob(job);
  }

  async unregisterJobs(workspaceId: string, tabId: string, pid?: number): Promise<number> {
    await this.ensureHydrated();
    for (const [key, job] of this.jobs) {
      if (job.workspaceId === workspaceId && job.tabId === tabId && (pid === undefined || job.pid === pid)) {
        this.jobs.delete(key);
      }
    }
    return removeJobs(workspaceId, tabId, pid);
  }

  removeTab(workspaceId: string, tabId: string): void {
    void this.ensureHydrated().then(() => {
      let had = false;
      for (const [key, { probe }] of this.probes) {
        if (probe.workspaceId === workspaceId && probe.tabId === tabId) {
          this.probes.delete(key);
          had = true;
        }
      }
      for (const [key, job] of this.jobs) {
        if (job.workspaceId === workspaceId && job.tabId === tabId) {
          this.jobs.delete(key);
          had = true;
        }
      }
      if (had) removeTabEntries(workspaceId, tabId).catch(() => {});
    });
  }

  async statusForTab(tabId: string): Promise<{ probes: IProbeStatus[]; backgroundJobs: IBackgroundJobStatus[] }> {
    await this.ensureHydrated();
    const now = this.deps.now();
    const probes: IProbeStatus[] = [];
    for (const { probe, runtime } of this.probes.values()) {
      if (probe.tabId !== tabId) continue;
      probes.push({
        label: probe.label,
        command: probe.command,
        stalenessThresholdS: probe.stalenessThresholdS,
        intervalS: probe.intervalS,
        lastRunAt: runtime.lastRunAt,
        lastAgeS: runtime.lastAgeS,
        stale: runtime.stale,
        consecutiveFailures: runtime.consecutiveFailures,
        lastError: runtime.lastError,
      });
    }
    const backgroundJobs: IBackgroundJobStatus[] = [];
    for (const job of this.jobs.values()) {
      if (job.tabId !== tabId) continue;
      backgroundJobs.push({
        pid: job.pid,
        label: job.label,
        alive: this.deps.isPidAlive(job.pid),
        registeredAt: job.registeredAt,
        ageS: Math.max(0, Math.round((now - job.registeredAt) / 1000)),
      });
    }
    return { probes, backgroundJobs };
  }

  /** One pass over every registration; emits at most one event per stall/death/failure episode. */
  async tick(emit: (event: TLivenessEvent) => void): Promise<void> {
    await this.ensureHydrated();
    await this.checkJobs(emit);
    await this.checkProbes(emit);
  }

  private async checkJobs(emit: (event: TLivenessEvent) => void): Promise<void> {
    for (const [key, job] of [...this.jobs]) {
      if (this.deps.isPidAlive(job.pid)) continue;

      let exitCode: number | null = null;
      if (job.exitCodeFile) {
        const raw = await this.deps.readTail(job.exitCodeFile, 64);
        const match = raw ? /-?\d+/.exec(raw.trim()) : null;
        if (match) exitCode = Number(match[0]);
      }
      let stderrTail: string | null = null;
      if (job.stderrFile) {
        const raw = await this.deps.readTail(job.stderrFile, STDERR_TAIL_BYTES);
        if (raw && raw.trim()) stderrTail = tailLines(raw, STDERR_TAIL_LINES);
      }

      // A dead pid is a one-shot fact: deregister before emitting so a slow
      // orchestrator cannot be renotified about the same corpse every poll.
      this.jobs.delete(key);
      removeJobs(job.workspaceId, job.tabId, job.pid).catch(() => {});
      log.info({ tabId: job.tabId, pid: job.pid, exitCode }, 'background job died');
      emit({ kind: 'bg-died', job, exitCode, stderrTail });
    }
  }

  private async checkProbes(emit: (event: TLivenessEvent) => void): Promise<void> {
    const now = this.deps.now();
    const due = [...this.probes.values()].filter(({ probe, runtime }) =>
      !runtime.running && (runtime.lastRunAt === null || now - runtime.lastRunAt >= probe.intervalS * 1000));

    await Promise.all(due.map(async ({ probe, runtime }) => {
      runtime.running = true;
      try {
        const cwd = await this.deps.resolveCwd(probe.workspaceId);
        const result = await this.deps.runCommand(probe.command, cwd, PROBE_TIMEOUT_MS);
        runtime.lastRunAt = this.deps.now();

        const age = result.exitCode === 0 ? parseProbeAge(result.stdout) : null;
        if (age === null) {
          const reason = result.exitCode !== 0
            ? `exit ${result.exitCode}: ${tailLines(result.stderr || result.stdout, 3).slice(0, 300) || '(no output)'}`
            : `no numeric age in output: ${tailLines(result.stdout, 1).slice(0, 200) || '(empty)'}`;
          this.recordProbeFailure(probe, runtime, reason, emit);
          return;
        }

        runtime.consecutiveFailures = 0;
        runtime.failureAlerted = false;
        runtime.lastError = null;
        runtime.lastAgeS = age;
        runtime.stale = age > probe.stalenessThresholdS;

        if (!runtime.stale) {
          runtime.lastAlertAgeS = null;
          return;
        }
        // First alert of the episode, then again every further threshold-width
        // of silence — an ignored stall must not fade into the backlog.
        if (runtime.lastAlertAgeS === null || age >= runtime.lastAlertAgeS + probe.stalenessThresholdS) {
          runtime.lastAlertAgeS = age;
          log.info({ tabId: probe.tabId, label: probe.label, ageS: age }, 'probe reports stall');
          emit({ kind: 'stalled', probe, ageS: age });
        }
      } catch (err) {
        runtime.lastRunAt = this.deps.now();
        this.recordProbeFailure(probe, runtime, err instanceof Error ? err.message : String(err), emit);
      } finally {
        runtime.running = false;
      }
    }));
  }

  private recordProbeFailure(
    probe: ILivenessProbe,
    runtime: IProbeRuntime,
    error: string,
    emit: (event: TLivenessEvent) => void,
  ): void {
    runtime.consecutiveFailures += 1;
    runtime.lastError = error;
    if (runtime.consecutiveFailures >= PROBE_FAILURE_ALERT_THRESHOLD && !runtime.failureAlerted) {
      runtime.failureAlerted = true;
      log.warn({ tabId: probe.tabId, label: probe.label, failures: runtime.consecutiveFailures, error }, 'probe failing');
      emit({ kind: 'probe-failed', probe, error, failures: runtime.consecutiveFailures });
    }
  }
}

const runCommandReal = (command: string, cwd: string | undefined, timeoutMs: number): Promise<IProbeRunResult> =>
  new Promise((resolve) => {
    execFile('/bin/sh', ['-c', command], { cwd, timeout: timeoutMs, maxBuffer: 256 * 1024 }, (err, stdout, stderr) => {
      if (!err) {
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '', exitCode: 0 });
        return;
      }
      const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
      const exitCode = typeof e.code === 'number' ? e.code : 1;
      const extra = e.killed
        ? ` (killed${e.signal ? ` by ${e.signal}` : ''} — probe timeout after ${timeoutMs}ms?)`
        : typeof e.code === 'string' ? ` (${e.code})` : '';
      resolve({ stdout: stdout ?? '', stderr: `${stderr ?? ''}${extra}`, exitCode });
    });
  });

const isPidAliveReal = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the pid exists but belongs to someone else — still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

const readTailReal = async (file: string, maxBytes: number): Promise<string | null> => {
  try {
    const handle = await fs.open(file, 'r');
    try {
      const { size } = await handle.stat();
      const start = Math.max(0, size - maxBytes);
      const length = size - start;
      if (length === 0) return '';
      const buf = Buffer.alloc(length);
      await handle.read(buf, 0, length, start);
      return buf.toString('utf-8');
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
};

const g = globalThis as unknown as { __ptLivenessManager?: LivenessManager };

export const getLivenessManager = (): LivenessManager => {
  if (!g.__ptLivenessManager) {
    g.__ptLivenessManager = new LivenessManager({
      runCommand: runCommandReal,
      isPidAlive: isPidAliveReal,
      readTail: readTailReal,
      resolveCwd: async (workspaceId) => {
        const { getWorkspaceByIdCached } = await import('@/lib/workspace-store');
        const ws = await getWorkspaceByIdCached(workspaceId);
        return ws?.directories[0];
      },
      now: () => Date.now(),
    });
  }
  return g.__ptLivenessManager;
};
