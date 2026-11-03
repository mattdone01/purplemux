import { FINDER_LOOKBACK_MS, FINDER_WAKES_WINDOW_MS, deriveConstraint } from '@/lib/constraint';
import { createLogger } from '@/lib/logger';
import type { IFinderLedgerInput, IFinderPoolInput, IFinderResult, IFinderSpendInput } from '@/types/constraint';
import type { IFlowRecord } from '@/types/flow';

// The finder's tick (ADR-0034, the ADR-0032 pattern): every 60 s, per process, derive each
// workspace's constraint and cache it. A tick over 5 s logs its duration; the next is skipped while
// one runs. Each input is read on its own: a failed read is an unknown input, never a skipped tick.

const log = createLogger('constraint-finder');

export const FINDER_TICK_MS = 60_000;
export const FINDER_SLOW_TICK_MS = 5_000;
export const FINDER_SLOW_WORKSPACE_MS = 1_000;
/** An answer older than two ticks is stale: the tick that should have replaced it did not run. */
export const FINDER_STALE_MS = 2 * FINDER_TICK_MS;

/** One spend read for every workspace: the index state, the first UTC day's start, and each workspace's totals. */
export interface IFinderSpendAll {
  index: IFinderSpendInput['index'];
  since: number;
  byWorkspace: Map<string, Pick<IFinderSpendInput, 'costUsd' | 'cacheReadTokens'>>;
}

export interface IFinderDeps {
  workspaces: () => Promise<Array<{ id: string }>>;
  /** Throws when the ledger cannot be read. */
  ledger: (workspaceId: string, now: number) => Promise<IFinderLedgerInput>;
  flow: (workspaceId: string) => Promise<IFlowRecord | null>;
  /** Read once per tick, not once per workspace. */
  spend: (now: number) => Promise<IFinderSpendAll | null>;
  /** No pool scheduler yet (ADR-HFL-09, story 17): null is an unknown pool. */
  pool: () => Promise<IFinderPoolInput | null>;
}

interface IFinderTimer {
  timer: ReturnType<typeof setInterval> | null;
  running: Promise<void> | null;
}

const g = globalThis as unknown as {
  __ptConstraintCache?: Map<string, IFinderResult>;
  __ptConstraintTick?: IFinderTimer;
  __ptConstraintInflight?: Map<string, Promise<IFinderResult>>;
};
if (!g.__ptConstraintCache) g.__ptConstraintCache = new Map();
if (!g.__ptConstraintTick) g.__ptConstraintTick = { timer: null, running: null };
if (!g.__ptConstraintInflight) g.__ptConstraintInflight = new Map();

const cache = (): Map<string, IFinderResult> => g.__ptConstraintCache!;

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const orNull = async <T>(read: () => Promise<T | null>, what: string, workspaceId: string): Promise<T | null> => {
  try {
    return await read();
  } catch (err) {
    log.warn({ workspaceId }, `constraint finder: ${what} unreadable (${errorText(err)})`);
    return null;
  }
};

/** A workspace with no row in a ready spend view spent nothing in its days. */
export const spendFor = (all: IFinderSpendAll | null, workspaceId: string): IFinderSpendInput | null =>
  all ? { index: all.index, since: all.since, ...(all.byWorkspace.get(workspaceId) ?? { costUsd: 0, cacheReadTokens: 0 }) } : null;

interface IShared {
  spend: IFinderSpendAll | null;
  pool: IFinderPoolInput | null;
}

const readShared = async (deps: IFinderDeps, now: number): Promise<IShared> => {
  const [spend, pool] = await Promise.all([orNull(() => deps.spend(now), 'spend', 'all'), orNull(() => deps.pool(), 'pool', 'all')]);
  return { spend, pool };
};

/** Derive one workspace's answer from fresh reads and cache it; a derive over 1 s logs its duration. */
const deriveForWorkspace = async (
  deps: IFinderDeps, workspaceId: string, now: number, shared: IShared, clock: () => number,
): Promise<IFinderResult> => {
  const started = clock();
  const [ledger, flow] = await Promise.all([
    orNull(() => deps.ledger(workspaceId, now), 'ledger', workspaceId),
    orNull(() => deps.flow(workspaceId), 'flow', workspaceId),
  ]);
  const result = deriveConstraint(ledger, flow, spendFor(shared.spend, workspaceId), shared.pool, now);
  cache().set(workspaceId, result);
  const durationMs = clock() - started;
  if (durationMs > FINDER_SLOW_WORKSPACE_MS) log.warn({ workspaceId, durationMs }, `constraint finder: ${workspaceId} took ${durationMs} ms`);
  return result;
};

/** One tick over every workspace; a closed workspace's answer leaves the cache. */
export const runConstraintTick = async (deps: IFinderDeps, now: number, clock: () => number = Date.now): Promise<number> => {
  const workspaces = await deps.workspaces();
  const ids = new Set(workspaces.map((w) => w.id));
  for (const key of cache().keys()) if (!ids.has(key)) cache().delete(key);
  const shared = await readShared(deps, now);
  for (const { id } of workspaces) await deriveForWorkspace(deps, id, now, shared, clock);
  return workspaces.length;
};

const realDeps = (): IFinderDeps => ({
  workspaces: async () => (await (await import('@/lib/workspace-store')).getWorkspaces()).workspaces,
  ledger: async (workspaceId, now) => (await import('@/lib/ledger-store')).getLedgerStore()
    .finderSnapshot(workspaceId, { since: now - FINDER_LOOKBACK_MS, wakesSince: now - FINDER_WAKES_WINDOW_MS }, now),
  flow: async (workspaceId) => (await import('@/lib/flow-store')).readFlow(workspaceId),
  spend: async (now) => {
    const { getSpendView } = await import('@/lib/spend/spend-service');
    const { addUtcDays, utcDay } = await import('@/lib/spend/spend-model');
    const from = addUtcDays(utcDay(now), -6);
    const view = await getSpendView({ workspaceId: 'all', from, to: utcDay(now), by: 'workspace' }, now);
    return {
      index: view.index,
      since: Date.parse(`${from}T00:00:00Z`),
      byWorkspace: new Map(view.rows.map((row) => [row.key, { costUsd: row.costUsd, cacheReadTokens: row.cacheReadTokens }])),
    };
  },
  pool: async () => null,
});

/** One scheduled tick: skipped while the previous one still runs, logged when it takes longer than 5 s. */
export const runScheduledConstraintTick = async (deps: IFinderDeps = realDeps(), clock: () => number = Date.now): Promise<number | null> => {
  const tick = g.__ptConstraintTick!;
  if (tick.running) {
    log.warn('constraint finder tick skipped: the previous tick still runs');
    return null;
  }
  const started = clock();
  let count: number | null = null;
  const run = runConstraintTick(deps, started, clock).then((n) => {
    count = n;
  }, (err) => {
    log.warn(`constraint finder tick failed: ${errorText(err)}`);
  });
  tick.running = run;
  try {
    await run;
  } finally {
    tick.running = null;
    const durationMs = clock() - started;
    if (durationMs > FINDER_SLOW_TICK_MS) log.warn({ durationMs }, `constraint finder tick took ${durationMs} ms`);
  }
  return count;
};

/**
 * The cached answer for a workspace. Before the first tick has reached it (just after a start, or a
 * workspace created since), it is derived now and cached; concurrent reads share that one derive.
 */
export const readFinderResult = async (
  workspaceId: string, now: number, deps: IFinderDeps = realDeps(), clock: () => number = Date.now,
): Promise<IFinderResult> => {
  const cached = cache().get(workspaceId);
  if (cached) return cached;
  const inflight = g.__ptConstraintInflight!;
  const running = inflight.get(workspaceId);
  if (running) return running;
  const derive = readShared(deps, now)
    .then((shared) => deriveForWorkspace(deps, workspaceId, now, shared, clock))
    .finally(() => inflight.delete(workspaceId));
  inflight.set(workspaceId, derive);
  return derive;
};

/** Every cached answer, for the flag tick (source `ledger`). */
export const cachedFinderResults = (): ReadonlyMap<string, IFinderResult> => cache();

/** Start the 60 s tick once per process; a read before the first tick derives its workspace on demand. */
export const startConstraintFinder = (options: { intervalMs?: number; deps?: IFinderDeps } = {}): void => {
  const tick = g.__ptConstraintTick!;
  if (tick.timer) return;
  const deps = options.deps ?? realDeps();
  tick.timer = setInterval(() => {
    void runScheduledConstraintTick(deps);
  }, options.intervalMs ?? FINDER_TICK_MS);
  tick.timer.unref?.();
};

/** Stop the tick and wait for one in flight (`shutdownWs`). */
export const stopConstraintFinder = async (): Promise<void> => {
  const tick = g.__ptConstraintTick!;
  if (tick.timer) clearInterval(tick.timer);
  tick.timer = null;
  await tick.running?.catch(() => undefined);
};

/** Tests only. */
export const resetConstraintFinderForTests = (): void => {
  cache().clear();
  g.__ptConstraintInflight!.clear();
};
