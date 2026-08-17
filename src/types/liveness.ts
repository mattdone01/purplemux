// Liveness watch: registered probes and background jobs the watchdog polls so
// that delegated work whose tab looks healthy cannot die silently. Born from a
// 7-hour stall where every watcher watched milestones or idleness — nothing
// watched progress freshness.

export interface ILivenessProbe {
  workspaceId: string;
  tabId: string;
  /** Distinguishes multiple probes on one tab; defaults to "default". */
  label: string;
  /** Shell command; its stdout's last line must contain seconds-since-last-progress. */
  command: string;
  /** Reported age above this is a stall. */
  stalenessThresholdS: number;
  /** Minimum seconds between probe runs. */
  intervalS: number;
  registeredAt: number;
}

export interface IBackgroundJob {
  workspaceId: string;
  tabId: string;
  pid: number;
  label?: string;
  /** File the job's stderr was redirected to; its tail is included in the death notification. */
  stderrFile?: string;
  /** File the launcher writes the exit code to (`cmd; echo $? > file`); read on death. */
  exitCodeFile?: string;
  registeredAt: number;
}

export interface IProbeStatus {
  label: string;
  command: string;
  stalenessThresholdS: number;
  intervalS: number;
  lastRunAt: number | null;
  lastAgeS: number | null;
  stale: boolean;
  consecutiveFailures: number;
  lastError: string | null;
}

export interface IBackgroundJobStatus {
  pid: number;
  label?: string;
  alive: boolean;
  registeredAt: number;
  ageS: number;
}

export type TLivenessEvent =
  | { kind: 'stalled'; probe: ILivenessProbe; ageS: number }
  | { kind: 'probe-failed'; probe: ILivenessProbe; error: string; failures: number }
  | { kind: 'bg-died'; job: IBackgroundJob; exitCode: number | null; stderrTail: string | null };
