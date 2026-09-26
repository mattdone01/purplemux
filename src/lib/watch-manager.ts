import { execFile } from 'child_process';
import type { ICaller } from '@/lib/caller';
import type { IEnqueueRequest } from '@/lib/inbox-store';
import type { IWatchFields } from '@/lib/inbox-templates';
import { createLogger } from '@/lib/logger';
import {
  WATCH_FAILURES_BEFORE_NOTICE,
  WatchError,
  checkCaps,
  checkSpec,
  createWatch,
  isDue,
  isWatchId,
  mutateWatches,
  newWatchId,
  parsePr,
  parseRef,
  readWatches,
  type IWatchSpec,
} from '@/lib/watch-store';
import type { IInboxItem } from '@/types/inbox';
import type { IWatch, IWatchesState, IWatchView, TWatchFailure } from '@/types/watch';

// Evaluates harness watches (ADR-0015) and reports each outcome to the owner tab
// through the inbox. GitHub reads use the server's own `gh` (reads need no
// identity pin); a lease watch reads the local lease store.

const log = createLogger('watches');

export const WATCH_TICK_MS = 15_000;
export const GH_TIMEOUT_MS = 20_000;

export type TGhResult = { ok: true; stdout: string } | { ok: false; code: TWatchFailure; message: string };

export interface IWatchDeps {
  now: () => number;
  newId: () => string;
  runGh: (args: string[]) => Promise<TGhResult>;
  /** True when nobody holds the lease, or its holder is not live. */
  leaseFree: (name: string) => Promise<boolean>;
  /** Live tabs, and the workspaces whose layout could not be read (their tabs are unknown, not closed). */
  liveTabs: () => Promise<{ tabs: ReadonlyArray<{ workspaceId: string; tabId: string }>; uncertainWorkspaceIds: ReadonlySet<string> }>;
  enqueue: (req: IEnqueueRequest<'watch'>) => Promise<{ item: IInboxItem }>;
  read: () => Promise<IWatchesState>;
  mutate: typeof mutateWatches;
}

type TOutcome =
  | { type: 'fire'; fields: Omit<IWatchFields, 'watchId' | 'target'> }
  | { type: 'wait' }
  | { type: 'fail'; code: TWatchFailure; message: string };

/** Classify a failed `gh` run into a server token; the raw text is kept for `watch list` only. */
export const classifyGhError = (err: NodeJS.ErrnoException & { killed?: boolean; signal?: string | null }, stderr: string): TWatchFailure => {
  if (err.code === 'ENOENT') return 'gh-missing';
  if (err.killed || err.signal === 'SIGTERM') return 'timeout';
  if (/HTTP 404/.test(stderr)) return 'http-404';
  if (/HTTP 401|gh auth login|authentication/i.test(stderr)) return 'auth';
  if (/HTTP 403/.test(stderr)) return 'http-403';
  return 'other';
};

export const runGhDefault = (args: string[]): Promise<TGhResult> =>
  new Promise((resolve) => {
    execFile('gh', args, { timeout: GH_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1' } }, (err, stdout, stderr) => {
      if (!err) return resolve({ ok: true, stdout });
      const message = `${String(stderr || err.message).trim().split('\n')[0]}`.slice(0, 300);
      resolve({ ok: false, code: classifyGhError(err as never, String(stderr ?? '')), message });
    });
  });

const GREEN = new Set(['success', 'neutral', 'skipped']);

/** Settled when at least one check or status exists and none is still running or pending. */
export const settleChecks = (runs: string, statuses: string): { settled: boolean; green: number; red: number } => {
  let green = 0;
  let red = 0;
  let total = 0;
  let pending = false;
  for (const line of runs.split('\n').filter(Boolean)) {
    const [status, conclusion = ''] = line.split('\t');
    total++;
    if (status !== 'completed') pending = true;
    else if (GREEN.has(conclusion)) green++;
    else red++;
  }
  for (const state of statuses.split('\n').filter(Boolean)) {
    total++;
    if (state === 'pending') pending = true;
    else if (state === 'success') green++;
    else red++;
  }
  return { settled: total > 0 && !pending, green, red };
};

const SHA = /^[0-9a-f]{7,40}$/;

export class WatchManager {
  constructor(private readonly deps: IWatchDeps) {}

  // ─── reads ──────────────────────────────────────────────────────────────

  private async gh(args: string[]): Promise<TGhResult> {
    return this.deps.runGh(args);
  }

  private async pull(target: string): Promise<{ ok: true; merged: boolean; state: string; head: string } | Extract<TGhResult, { ok: false }>> {
    const pr = parsePr(target)!;
    const r = await this.gh(['api', `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`]);
    if (!r.ok) return r;
    try {
      const body = JSON.parse(r.stdout) as { merged?: unknown; state?: unknown; head?: { sha?: unknown } };
      const head = body.head?.sha;
      if (typeof head !== 'string' || !SHA.test(head)) return { ok: false, code: 'other', message: 'the pull request has no head sha' };
      return { ok: true, merged: body.merged === true, state: String(body.state), head };
    } catch {
      return { ok: false, code: 'other', message: 'gh api returned a body that is not JSON' };
    }
  }

  private async refSha(target: string): Promise<{ ok: true; sha: string } | Extract<TGhResult, { ok: false }>> {
    const ref = parseRef(target)!;
    const r = await this.gh(['api', `repos/${ref.owner}/${ref.repo}/commits/${encodeURIComponent(ref.ref)}`, '--jq', '.sha']);
    if (!r.ok) return r;
    const sha = r.stdout.trim();
    return SHA.test(sha) ? { ok: true, sha } : { ok: false, code: 'other', message: 'gh api returned no commit sha' };
  }

  private async evaluate(w: IWatch): Promise<TOutcome> {
    if (w.kind === 'lease') return (await this.deps.leaseFree(w.target)) ? { type: 'fire', fields: { notice: 'free' } } : { type: 'wait' };
    if (w.kind === 'ref') {
      const r = await this.refSha(w.target);
      if (!r.ok) return { type: 'fail', code: r.code, message: r.message };
      return r.sha !== w.baseline ? { type: 'fire', fields: { notice: 'moved', fromSha: w.baseline!, sha: r.sha } } : { type: 'wait' };
    }
    const p = await this.pull(w.target);
    if (!p.ok) return { type: 'fail', code: p.code, message: p.message };
    if (w.until === 'merged') return p.merged ? { type: 'fire', fields: { notice: 'merged', sha: p.head } } : { type: 'wait' };
    if (w.until === 'closed') {
      if (p.state !== 'closed') return { type: 'wait' };
      return { type: 'fire', fields: { notice: p.merged ? 'merged' : 'closed', sha: p.head } };
    }
    if (w.until === 'head-moved') {
      return p.head !== w.baseline ? { type: 'fire', fields: { notice: 'head-moved', fromSha: w.baseline!, sha: p.head } } : { type: 'wait' };
    }
    const pr = parsePr(w.target)!;
    const base = `repos/${pr.owner}/${pr.repo}/commits/${p.head}`;
    const runs = await this.gh(['api', '--paginate', `${base}/check-runs?per_page=100`, '--jq', '.check_runs[] | [.status, (.conclusion // "")] | @tsv']);
    if (!runs.ok) return { type: 'fail', code: runs.code, message: runs.message };
    const statuses = await this.gh(['api', `${base}/status`, '--jq', '.statuses[] | .state']);
    if (!statuses.ok) return { type: 'fail', code: statuses.code, message: statuses.message };
    const c = settleChecks(runs.stdout, statuses.stdout);
    return c.settled ? { type: 'fire', fields: { notice: 'checks-settled', sha: p.head, green: c.green, red: c.red } } : { type: 'wait' };
  }

  // ─── the tick ───────────────────────────────────────────────────────────

  private notice(w: IWatch, fields: Omit<IWatchFields, 'watchId' | 'target'>): IEnqueueRequest<'watch'> {
    return {
      kind: 'watch',
      targetWorkspaceId: w.workspaceId,
      targetTabId: w.tabId,
      dedupeKey: `watch:${w.id}:${fields.notice}`,
      fields: { watchId: w.id, target: w.target, ...fields },
    };
  }

  private ticking: Promise<void> | null = null;
  private again: string | undefined | null = null;

  /**
   * Every due watch once: expire, evaluate, report. `onlyLease` evaluates the lease watches on one
   * name (a release event). One pass at a time; a pass asked for meanwhile runs once afterwards.
   */
  async tick(onlyLease?: string): Promise<void> {
    if (this.ticking) {
      this.again = this.again === null ? onlyLease : undefined;
      return this.ticking;
    }
    this.ticking = (async () => {
      try {
        let scope: string | undefined | null = onlyLease;
        while (scope !== null) {
          this.again = null;
          await this.pass(scope);
          scope = this.again;
        }
      } finally {
        this.ticking = null;
      }
    })();
    return this.ticking;
  }

  private async pass(onlyLease?: string): Promise<void> {
    const now = this.deps.now();
    const { watches } = await this.deps.read();
    const outcomes = new Map<string, TOutcome | 'expired'>();
    // Evaluated outside the lock: a GitHub read may take its full timeout.
    for (const w of watches) {
      if (onlyLease !== undefined && !(w.kind === 'lease' && w.target === onlyLease)) continue;
      if (now >= w.expiresAt) {
        outcomes.set(w.id, 'expired');
        continue;
      }
      if (!isDue(w, now)) continue;
      try {
        outcomes.set(w.id, await this.evaluate(w));
      } catch (err) {
        outcomes.set(w.id, { type: 'fail', code: 'other', message: err instanceof Error ? err.message : String(err) });
      }
    }
    if (!outcomes.size) return;
    await this.deps.mutate(async (state) => {
      let next = state.watches;
      for (const [id, outcome] of outcomes) {
        const w = next.find((x) => x.id === id);
        if (!w) continue; // cleared or removed with its tab meanwhile
        try {
          next = await this.apply(next, w, outcome, now);
        } catch (err) {
          log.warn(`watch ${id} could not be reported: ${err instanceof Error ? err.message : err}`);
        }
      }
      return { state: next === state.watches ? state : { watches: next }, value: undefined };
    });
  }

  private async apply(list: IWatch[], w: IWatch, outcome: TOutcome | 'expired', now: number): Promise<IWatch[]> {
    const without = () => list.filter((x) => x.id !== w.id);
    const replace = (x: IWatch) => list.map((y) => (y.id === w.id ? x : y));
    if (outcome === 'expired') {
      await this.deps.enqueue(this.notice(w, { notice: 'expired', until: w.until }));
      return without();
    }
    if (outcome.type === 'fire') {
      await this.deps.enqueue(this.notice(w, outcome.fields));
      return without();
    }
    if (outcome.type === 'wait') {
      return replace({ ...w, lastCheckedAt: now, failures: 0, failingNotified: false, lastError: w.kind === 'lease' ? w.lastError : null });
    }
    const failures = w.failures + 1;
    let failingNotified = w.failingNotified;
    // One failing notice per run of failures: a broken watch is never silence, never a stream.
    if (failures >= WATCH_FAILURES_BEFORE_NOTICE && !failingNotified) {
      await this.deps.enqueue(this.notice(w, { notice: 'failing', code: outcome.code }));
      failingNotified = true;
    }
    return replace({ ...w, lastCheckedAt: now, failures, failingNotified, lastError: { code: outcome.code, message: outcome.message, at: now } });
  }

  // ─── tab lifecycle ──────────────────────────────────────────────────────

  async removeTab(workspaceId: string, tabId: string): Promise<number> {
    return this.deps.mutate(async (state) => {
      const keep = state.watches.filter((w) => !(w.workspaceId === workspaceId && w.tabId === tabId));
      return { state: keep.length === state.watches.length ? state : { watches: keep }, value: state.watches.length - keep.length };
    });
  }

  /** Boot: drop the watches of tabs confirmed gone while the server was down; an unreadable workspace keeps its own. */
  async hydrate(): Promise<number> {
    const live = await this.deps.liveTabs();
    const open = new Set(live.tabs.map((t) => `${t.workspaceId}/${t.tabId}`));
    return this.deps.mutate(async (state) => {
      const keep = state.watches.filter((w) => open.has(`${w.workspaceId}/${w.tabId}`) || live.uncertainWorkspaceIds.has(w.workspaceId));
      return { state: keep.length === state.watches.length ? state : { watches: keep }, value: state.watches.length - keep.length };
    });
  }

  // ─── the API ────────────────────────────────────────────────────────────

  private async baseline(spec: IWatchSpec): Promise<string | null> {
    if (spec.kind === 'lease') return null;
    const r = spec.kind === 'pr' ? await this.pull(spec.target) : await this.refSha(spec.target);
    if (r.ok) return 'head' in r ? r.head : r.sha;
    if (r.code === 'http-404') throw new WatchError('watch-invalid', `${spec.target} does not exist or is not visible to the server's gh`);
    throw new WatchError('gh-unavailable', `gh could not read ${spec.target} (${r.code}): ${r.message}`);
  }

  async create(caller: ICaller, input: Record<string, unknown>): Promise<IWatch> {
    if (caller.admin || !caller.workspaceId || !caller.tabId) {
      throw new WatchError('caller-unresolved', 'a watch belongs to a tab: call from the tab that will receive its notice');
    }
    const spec = checkSpec(input);
    const owner = { workspaceId: caller.workspaceId, tabId: caller.tabId };
    // A cheap cap check before the GitHub read, then the binding one under the lock.
    checkCaps(await this.deps.read(), spec, owner);
    const baseline = await this.baseline(spec);
    const watch = createWatch(spec, owner, baseline, this.deps.now(), this.deps.newId());
    await this.deps.mutate(async (state) => {
      checkCaps(state, spec, owner);
      return { state: { watches: [...state.watches, watch] }, value: undefined };
    });
    return watch;
  }

  async list(caller: ICaller, workspaceId: string | null): Promise<IWatchView[]> {
    const ws = workspaceId ?? caller.workspaceId;
    if (!caller.admin && (!ws || ws !== caller.workspaceId)) throw new WatchError('forbidden', 'a workspace token reads its own workspace\'s watches');
    const [{ watches }, live] = await Promise.all([this.deps.read(), this.deps.liveTabs()]);
    const open = new Set(live.tabs.map((t) => `${t.workspaceId}/${t.tabId}`));
    const now = this.deps.now();
    return watches
      .filter((w) => ws === null || w.workspaceId === ws)
      .map((w) => ({
        ...w,
        ageSeconds: Math.max(0, Math.floor((now - w.createdAt) / 1000)),
        expiresInSeconds: Math.max(0, Math.floor((w.expiresAt - now) / 1000)),
        owner: open.has(`${w.workspaceId}/${w.tabId}`) ? 'live' as const : live.uncertainWorkspaceIds.has(w.workspaceId) ? 'unknown' as const : 'closed' as const,
      }));
  }

  /** The owner tab, or admin. */
  async clear(caller: ICaller, id: unknown): Promise<IWatch> {
    if (!isWatchId(id)) throw new WatchError('watch-not-found', `no watch ${String(id)}`);
    return this.deps.mutate(async (state) => {
      const w = state.watches.find((x) => x.id === id);
      if (!w) throw new WatchError('watch-not-found', `no watch ${id}`);
      if (!caller.admin && !(caller.workspaceId === w.workspaceId && caller.tabId === w.tabId)) {
        throw new WatchError('forbidden', `watch ${id} belongs to ${w.workspaceId}/${w.tabId}; only that tab or admin clears it`);
      }
      return { state: { watches: state.watches.filter((x) => x !== w) }, value: w };
    });
  }
}

// ─── runtime ──────────────────────────────────────────────────────────────

const defaultDeps = async (): Promise<IWatchDeps> => {
  const [leaseStore, leaseHttp, tabLifecycle, inboxStore] = await Promise.all([
    import('@/lib/lease-store'),
    import('@/lib/lease-http'),
    import('@/lib/tab-lifecycle'),
    import('@/lib/inbox-store'),
  ]);
  return {
    now: () => Date.now(),
    newId: newWatchId,
    runGh: runGhDefault,
    leaseFree: async (name) => {
      const lease = leaseStore.pruneExpired(await leaseStore.readLeaseState(), Date.now()).state.leases.find((l) => l.name === name);
      if (!lease) return true;
      return (await leaseHttp.viewOf(lease)).holderState !== 'live';
    },
    liveTabs: tabLifecycle.readLiveTabs,
    enqueue: inboxStore.enqueueNotice,
    read: readWatches,
    mutate: mutateWatches,
  };
};

interface IWatchRuntime {
  timer: ReturnType<typeof setInterval> | null;
  unsubscribe: Array<() => void>;
}

const g = globalThis as unknown as { __ptWatchRuntime?: IWatchRuntime; __ptWatchManager?: WatchManager };

export const getWatchManager = async (): Promise<WatchManager> => {
  if (!g.__ptWatchManager) g.__ptWatchManager = new WatchManager(await defaultDeps());
  return g.__ptWatchManager;
};

/**
 * Its own timer, not a slot in StatusManager.poll: a GitHub read may take 20 s, and the status
 * poll awaits each step, so 60 watches there would stall tab status for minutes.
 */
export const startWatches = async (): Promise<void> => {
  if (g.__ptWatchRuntime) return;
  const runtime: IWatchRuntime = { timer: null, unsubscribe: [] };
  g.__ptWatchRuntime = runtime;
  const manager = await getWatchManager();
  const [{ onLeaseReleased }, { onTabClosed }] = await Promise.all([import('@/lib/lease-store'), import('@/lib/tab-lifecycle')]);
  if (g.__ptWatchRuntime !== runtime) return;
  const tick = (onlyLease?: string) => {
    manager.tick(onlyLease).catch((err) => log.warn(`watch tick failed: ${err instanceof Error ? err.message : err}`));
  };
  runtime.unsubscribe.push(onLeaseReleased((lease) => tick(lease.name)));
  runtime.unsubscribe.push(onTabClosed(({ workspaceId, tabId }) => {
    manager.removeTab(workspaceId, tabId).then((n) => {
      if (n) log.info({ tabId, removed: n }, 'watches removed with their tab');
    }).catch((err) => log.warn(`watch removal failed for ${tabId}: ${err instanceof Error ? err.message : err}`));
  }));
  await manager.hydrate().then((n) => {
    if (n) log.info({ removed: n }, 'watch boot pass: owner tabs closed while down');
  }).catch((err) => log.warn(`watch boot pass skipped: ${err instanceof Error ? err.message : err}`));
  if (g.__ptWatchRuntime !== runtime) return;
  const timer = setInterval(() => tick(), WATCH_TICK_MS);
  timer.unref?.();
  runtime.timer = timer;
  tick();
};

export const stopWatches = async (): Promise<void> => {
  const runtime = g.__ptWatchRuntime;
  if (!runtime) return;
  g.__ptWatchRuntime = undefined;
  if (runtime.timer) clearInterval(runtime.timer);
  for (const off of runtime.unsubscribe) off();
};
