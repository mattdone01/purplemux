// Browser-safe: the watchdog's duplicate-nudge filter (L49).
//
// Measured 27 Sep: two identical resilience-gate nudges reached the orchestrator
// together (~11:12Z), and the live log shows the same (tab, kind, target) twice
// within 60 s fifty times in one day. Each duplicate costs the recipient a paid
// turn and says nothing new. A nudge is a duplicate only when it reports the SAME
// episode again: the source tab, the recipient, the class and the episode that
// triggered it (the hook event's seq, a job's pid, a probe's reading) all match
// one sent within the window. The text is not the key (review r1 finding 3): a
// second permission prompt, or the same end line from a new stop, is a new
// episode with the same text, and it always goes out.

import type { TOrchestrationNudgeKind } from '@/types/status';

export const NUDGE_DEDUPE_WINDOW_MS = 60_000;

export interface INudgeIdentity {
  sourceTabId: string;
  recipientTabId: string;
  kind: TOrchestrationNudgeKind;
  /** What triggered it: `seq:<n>` for a hook event or transition, `pid:<n>` for a job, and so on. */
  episode: string;
}

const keyOf = (n: INudgeIdentity): string =>
  JSON.stringify([n.sourceTabId, n.recipientTabId, n.kind, n.episode]);

export class NudgeDeduper {
  private sentAt = new Map<string, number>();
  private droppedCount = 0;

  constructor(private readonly windowMs = NUDGE_DEDUPE_WINDOW_MS) {}

  /**
   * True when the nudge may go out, and records it; false for a duplicate of
   * one admitted less than the window ago, which is counted. The window runs
   * from the first send, so a steady repeat goes out once per window.
   */
  admit(nudge: INudgeIdentity, now: number): boolean {
    this.prune(now);
    const key = keyOf(nudge);
    const at = this.sentAt.get(key);
    if (at !== undefined && now - at < this.windowMs) {
      this.droppedCount += 1;
      return false;
    }
    this.sentAt.set(key, now);
    return true;
  }

  /** Nudges dropped as duplicates since this filter was made. */
  get dropped(): number {
    return this.droppedCount;
  }

  private prune(now: number): void {
    for (const [key, at] of this.sentAt) {
      if (now - at >= this.windowMs) this.sentAt.delete(key);
    }
  }
}
