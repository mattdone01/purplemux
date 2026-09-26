import { execFile } from 'child_process';
import { z } from 'zod';
import { createLogger } from '@/lib/logger';
import type { IHostSignalsValue, THostSignals } from '@/types/coordination';

// Host signals (story 20): the JSON printed by the optional `hostSignalCommand`
// in ~/.purplemux/config.json, run every 5 minutes with a 10 s timeout and
// validated against the schema pinned in architecture.md ("Host-signal JSON").
// A failing command shows its error, never zeros; a result older than 15
// minutes is marked stale. Story 21 writes the NomuPay script that fills it.

const log = createLogger('host-signals');

export const HOST_SIGNALS_INTERVAL_MS = 5 * 60 * 1000;
export const HOST_SIGNALS_TIMEOUT_MS = 10 * 1000;
export const HOST_SIGNALS_STALE_MS = 15 * 60 * 1000;
const OUTPUT_MAX_BYTES = 256 * 1024;

/** Unknown keys are ignored; a missing required key is a validation error. */
export const HOST_SIGNALS_SCHEMA = z.object({
  schemaVersion: z.literal(1),
  stampedAt: z.number().finite(),
  gateSlots: z.object({
    total: z.number().int().nonnegative(),
    held: z.number().int().nonnegative(),
    holders: z.array(z.object({ pid: z.number().int(), log: z.string() })),
  }),
  worktrees: z.array(z.object({ repo: z.string(), count: z.number().int().nonnegative(), byEpic: z.record(z.string(), z.number()) })),
  tmpInodesPct: z.number().finite(),
});

export const parseHostSignals = (stdout: string): { ok: true; value: IHostSignalsValue } | { ok: false; error: string } => {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch (err) {
    return { ok: false, error: `not JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  const parsed = HOST_SIGNALS_SCHEMA.safeParse(raw);
  if (parsed.success) return { ok: true, value: parsed.data as IHostSignalsValue };
  const issue = parsed.error.issues[0];
  return { ok: false, error: `invalid: ${issue.path.join('.') || '(root)'} — ${issue.message}` };
};

interface IRunnerState {
  last: { ok: true; value: IHostSignalsValue; ranAt: number } | { ok: false; error: string; ranAt: number } | null;
  configured: boolean;
  timer: ReturnType<typeof setInterval> | null;
}

const g = globalThis as unknown as { __ptHostSignals?: IRunnerState };
const state = (): IRunnerState => {
  if (!g.__ptHostSignals) g.__ptHostSignals = { last: null, configured: false, timer: null };
  return g.__ptHostSignals;
};

/** The view the route serves: not configured, pending, or the last result with its stamp and staleness. */
export const hostSignalsView = (now: number): THostSignals => {
  const s = state();
  if (!s.configured) return { state: 'not-configured' };
  if (!s.last) return { state: 'pending' };
  const stale = now - s.last.ranAt > HOST_SIGNALS_STALE_MS;
  return s.last.ok
    ? { state: 'ok', value: s.last.value, ranAt: s.last.ranAt, stale }
    : { state: 'error', error: s.last.error, ranAt: s.last.ranAt, stale };
};

export interface IHostSignalsDeps {
  now: () => number;
  command: () => Promise<string | null>;
  run: (command: string) => Promise<{ stdout: string } | { error: string }>;
}

export const defaultHostSignalsDeps = (): IHostSignalsDeps => ({
  now: () => Date.now(),
  command: async () => {
    const { getConfig } = await import('@/lib/config-store');
    const cmd = (await getConfig()).hostSignalCommand;
    return typeof cmd === 'string' && cmd.trim() ? cmd.trim() : null;
  },
  run: (command) => new Promise((resolve) => {
    execFile('/bin/sh', ['-c', command], { timeout: HOST_SIGNALS_TIMEOUT_MS, maxBuffer: OUTPUT_MAX_BYTES }, (err, stdout, stderr) => {
      if (err) {
        const why = (err as NodeJS.ErrnoException & { killed?: boolean }).killed ? `timed out after ${HOST_SIGNALS_TIMEOUT_MS / 1000} s` : err.message;
        resolve({ error: `${why}${stderr ? ` — ${String(stderr).trim().split('\n')[0].slice(0, 200)}` : ''}` });
        return;
      }
      resolve({ stdout: String(stdout) });
    });
  }),
});

/** One run: re-reads the config each time, so a new or removed command takes effect at the next run. */
export const runHostSignalsOnce = async (deps: IHostSignalsDeps = defaultHostSignalsDeps()): Promise<void> => {
  const s = state();
  const command = await deps.command().catch(() => null);
  s.configured = command !== null;
  if (!command) {
    s.last = null;
    return;
  }
  const ranAt = deps.now();
  const out = await deps.run(command);
  if ('error' in out) {
    s.last = { ok: false, error: `command failed: ${out.error}`, ranAt };
    log.warn(`host signal command failed: ${out.error}`);
    return;
  }
  const parsed = parseHostSignals(out.stdout);
  s.last = parsed.ok ? { ok: true, value: parsed.value, ranAt } : { ok: false, error: parsed.error, ranAt };
};

export const startHostSignals = (): void => {
  const s = state();
  if (s.timer) return;
  const tick = () => runHostSignalsOnce().catch((err) => log.warn(`host signal run failed: ${err instanceof Error ? err.message : err}`));
  void tick();
  s.timer = setInterval(tick, HOST_SIGNALS_INTERVAL_MS);
  s.timer.unref?.();
};

export const stopHostSignals = (): void => {
  const s = state();
  if (s.timer) clearInterval(s.timer);
  s.timer = null;
};

/** Tests only. */
export const resetHostSignals = (): void => {
  stopHostSignals();
  g.__ptHostSignals = undefined;
};
