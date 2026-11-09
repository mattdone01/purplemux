import type { TStrictRuntimeObservation } from '@/lib/process-utils';

/**
 * The process proofs of remote agent panes (ADR-0022 §19, vel-D61), bounded so a slow host never holds the
 * status poll. The poll never awaits a proof: it reads the answer an earlier proof left, and asks for the next
 * ones, which run in the background. Per host at most `perHostCap` proofs run at once, the least recently proven
 * tabs first; hosts run in parallel.
 *
 * - `present` is kept for `ttlMs` under its key (the session, the pane and its foreground command): a new key
 *   proves again.
 * - `absent` is read once: the transition it causes happens at the next read, and a relaunch never meets it.
 * - `unknown` (ssh failed or timed out) is never kept, and that host's proofs back off `backoffMs`.
 */

export type TRemoteProofWant = 'claude' | 'codex' | 'grok';

export interface IRemoteProofRequest {
  tabId: string;
  host: string;
  sessionName: string;
  want: TRemoteProofWant;
  /** Changes when the session, its pane or the pane's foreground command changes. */
  key: string;
}

export interface IRemoteProofDeps {
  observe: (sessionName: string, want: TRemoteProofWant) => Promise<TStrictRuntimeObservation>;
  now: () => number;
  onUnknown?: (req: IRemoteProofRequest, reason: string) => void;
}

export const REMOTE_PROOF_TTL_MS = 60_000;
export const REMOTE_PROOF_BACKOFF_MS = 30_000;
export const REMOTE_PROOF_PER_HOST_CAP = 4;

interface IResult {
  key: string;
  state: 'present' | 'absent';
  at: number;
}

export class RemoteProofScheduler {
  private readonly results = new Map<string, IResult>();
  private readonly inFlight = new Map<string, string>();
  private readonly lastAsked = new Map<string, number>();
  private readonly hostBackoff = new Map<string, number>();
  private pending: Promise<void> = Promise.resolve();

  constructor(
    private readonly deps: IRemoteProofDeps,
    private readonly opts: { ttlMs: number; backoffMs: number; perHostCap: number } = {
      ttlMs: REMOTE_PROOF_TTL_MS,
      backoffMs: REMOTE_PROOF_BACKOFF_MS,
      perHostCap: REMOTE_PROOF_PER_HOST_CAP,
    },
  ) {}

  /** The answer for this key, without waiting: true, false (consumed), or null when no proof answered yet. */
  read(req: IRemoteProofRequest): boolean | null {
    const result = this.results.get(req.tabId);
    if (!result) return null;
    if (result.key !== req.key || this.deps.now() - result.at >= this.opts.ttlMs) {
      this.results.delete(req.tabId);
      return null;
    }
    if (result.state === 'present') return true;
    this.results.delete(req.tabId);
    return false;
  }

  /**
   * Start the proofs these requests need, within each host's cap and outside its backoff. Never awaited by the
   * poll; the returned promise settles when the proofs started here end (tests and `settled`).
   */
  schedule(requests: readonly IRemoteProofRequest[]): Promise<void> {
    const now = this.deps.now();
    const byHost = new Map<string, IRemoteProofRequest[]>();
    for (const req of requests) {
      if (this.inFlight.has(req.tabId) || (this.hostBackoff.get(req.host) ?? 0) > now) continue;
      const kept = this.results.get(req.tabId);
      if (kept && kept.key === req.key && now - kept.at < this.opts.ttlMs) continue;
      byHost.set(req.host, [...(byHost.get(req.host) ?? []), req]);
    }
    const started: Promise<void>[] = [];
    for (const [host, reqs] of byHost) {
      const running = [...this.inFlight.values()].filter((h) => h === host).length;
      const room = Math.max(0, this.opts.perHostCap - running);
      const chosen = [...reqs].sort((a, b) => (this.lastAsked.get(a.tabId) ?? 0) - (this.lastAsked.get(b.tabId) ?? 0)).slice(0, room);
      for (const req of chosen) started.push(this.run(req));
    }
    const batch = Promise.all(started).then(() => {});
    this.pending = Promise.all([this.pending, batch]).then(() => {});
    return batch;
  }

  /** One proof awaited by its caller (an off-poll read), through the same cache and backoff, outside the cap. */
  async prove(req: IRemoteProofRequest): Promise<boolean | null> {
    const cached = this.read(req);
    if (cached !== null) return cached;
    if (this.inFlight.has(req.tabId) || (this.hostBackoff.get(req.host) ?? 0) > this.deps.now()) return null;
    await this.run(req);
    return this.read(req);
  }

  /** Every proof started so far has ended. */
  settled(): Promise<void> {
    return this.pending;
  }

  forget(tabId: string): void {
    this.results.delete(tabId);
    this.lastAsked.delete(tabId);
  }

  private async run(req: IRemoteProofRequest): Promise<void> {
    this.inFlight.set(req.tabId, req.host);
    this.lastAsked.set(req.tabId, this.deps.now());
    try {
      const observed = await this.deps.observe(req.sessionName, req.want).catch((err: unknown): TStrictRuntimeObservation => ({
        state: 'unknown', reason: err instanceof Error ? err.message : String(err),
      }));
      if (observed.state === 'unknown') {
        this.results.delete(req.tabId);
        this.hostBackoff.set(req.host, this.deps.now() + this.opts.backoffMs);
        this.deps.onUnknown?.(req, observed.reason);
        return;
      }
      this.results.set(req.tabId, { key: req.key, state: observed.state, at: this.deps.now() });
    } finally {
      this.inFlight.delete(req.tabId);
    }
  }
}
