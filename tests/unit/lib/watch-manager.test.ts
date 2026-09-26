import { beforeEach, describe, expect, it } from 'vitest';
import type { ICaller } from '@/lib/caller';
import type { IEnqueueRequest } from '@/lib/inbox-store';
import { renderInboxLine } from '@/lib/inbox-templates';
import { WatchManager, classifyGhError, settleChecks, type IWatchDeps, type TGhResult } from '@/lib/watch-manager';
import { WATCH_DEFAULT_TTL_S, WATCH_GITHUB_CAP, WATCH_TAB_CAP, WatchError, checkSpec } from '@/lib/watch-store';
import type { IInboxItem } from '@/types/inbox';
import type { IWatchesState } from '@/types/watch';

const T0 = Date.UTC(2026, 8, 26, 12, 0, 0);
const MIN = 60_000;
const SHA_A = 'aaaaaaaa11111111aaaaaaaa11111111aaaaaaaa';
const SHA_B = 'bbbbbbbb22222222bbbbbbbb22222222bbbbbbbb';

const caller = (workspaceId: string | null, tabId: string | null, admin = false): ICaller =>
  ({ scope: {}, workspaceId, tabId, tabName: tabId, verified: true, admin } as unknown as ICaller);
const B = caller('ws-b', 'tab-b');
const ADMIN = caller(null, null, true);

/** A fake gh keyed by the api path; each answer is a queue, the last one repeats. */
class Fakes {
  now = T0;
  state: IWatchesState = { watches: [] };
  sent: Array<IEnqueueRequest<'watch'> & { line: string }> = [];
  gh = new Map<string, TGhResult[]>();
  ghCalls: string[][] = [];
  freeLeases = new Set<string>();
  live = new Set(['ws-a/tab-a', 'ws-b/tab-b']);
  uncertain = new Set<string>();
  private seq = 0;

  answer(pathPart: string, ...results: TGhResult[]) {
    this.gh.set(pathPart, results);
  }

  pull(merged: boolean, state: string, head: string): TGhResult {
    return { ok: true, stdout: JSON.stringify({ merged, state, head: { sha: head } }) };
  }

  deps(): IWatchDeps {
    return {
      now: () => this.now,
      newId: () => `w-test${++this.seq}`,
      runGh: async (args) => {
        this.ghCalls.push(args);
        const key = [...this.gh.keys()].find((k) => args.some((a) => a.includes(k)));
        if (!key) return { ok: false, code: 'other', message: `no fake for ${args.join(' ')}` };
        const queue = this.gh.get(key)!;
        return queue.length > 1 ? queue.shift()! : queue[0];
      },
      leaseFree: async (name) => this.freeLeases.has(name),
      liveTabs: async () => ({
        tabs: [...this.live].map((k) => ({ workspaceId: k.split('/')[0], tabId: k.split('/')[1] })),
        uncertainWorkspaceIds: new Set(this.uncertain),
      }),
      enqueue: async (req) => {
        this.sent.push({ ...req, line: renderInboxLine('watch', req.fields).line });
        return { item: { id: `i-${this.sent.length}` } as IInboxItem };
      },
      read: async () => this.state,
      mutate: async (fn) => {
        const { state, value } = await fn(this.state);
        this.state = state;
        return value;
      },
    };
  }
}

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'none';
  } catch (err) {
    return err instanceof WatchError ? err.code : `not a WatchError: ${String(err)}`;
  }
};

describe('harness watches (ADR-0015)', () => {
  let f: Fakes;
  let m: WatchManager;
  beforeEach(() => {
    f = new Fakes();
    m = new WatchManager(f.deps());
  });

  const tickAt = async (minutes: number) => {
    f.now += minutes * MIN;
    await m.tick();
  };

  it('merged false then true: exactly one notice reaches the owner tab and the watch is gone', async () => {
    f.answer('/pulls/517', f.pull(false, 'open', SHA_A), f.pull(false, 'open', SHA_A), f.pull(true, 'closed', SHA_A));
    const w = await m.create(B, { kind: 'pr', target: 'NomuPay/treasury-ui#517', until: 'merged' });
    expect(w).toMatchObject({ baseline: SHA_A, workspaceId: 'ws-b', tabId: 'tab-b', intervalS: 120 });
    await m.tick();
    expect(f.sent).toEqual([]);
    await tickAt(1); // not due yet: no GitHub read
    expect(f.ghCalls).toHaveLength(2);
    await tickAt(2);
    expect(f.sent.map((s) => [s.targetWorkspaceId, s.targetTabId, s.line])).toEqual([
      ['ws-b', 'tab-b', `[purplemux watch ${w.id}] NomuPay/treasury-ui#517 is MERGED (aaaaaaaa) — watch cleared`],
    ]);
    expect(f.state.watches).toEqual([]);
    await tickAt(5);
    expect(f.sent).toHaveLength(1);
  });

  it('closed reports MERGED when it merged and CLOSED when it did not', async () => {
    f.answer('/pulls/1', f.pull(false, 'open', SHA_A), f.pull(false, 'closed', SHA_A));
    await m.create(B, { kind: 'pr', target: 'o/r#1', until: 'closed' });
    await m.tick();
    expect(f.sent[0].line).toContain('o/r#1 is CLOSED without a merge (aaaaaaaa)');
  });

  it('head-moved carries the old and the new sha', async () => {
    f.answer('/pulls/9', f.pull(false, 'open', SHA_A), f.pull(false, 'open', SHA_A), f.pull(false, 'open', SHA_B));
    await m.create(B, { kind: 'pr', target: 'o/r#9', until: 'head-moved' });
    await m.tick();
    await tickAt(2);
    expect(f.sent.map((s) => s.line)).toEqual([expect.stringContaining('o/r#9 head moved aaaaaaaa -> bbbbbbbb — watch cleared')]);
  });

  it('checks-settled: no notice while a check is pending; one with green/red counts once it completes', async () => {
    f.answer('/pulls/5', f.pull(false, 'open', SHA_A));
    f.answer('/check-runs', { ok: true, stdout: 'completed\tsuccess\nin_progress\t\n' }, { ok: true, stdout: 'completed\tsuccess\ncompleted\tfailure\ncompleted\tskipped\n' });
    f.answer('/status', { ok: true, stdout: 'success\n' });
    await m.create(B, { kind: 'pr', target: 'o/r#5', until: 'checks-settled' });
    await m.tick();
    expect(f.sent).toEqual([]);
    await tickAt(2);
    expect(f.sent.map((s) => s.line)).toEqual([expect.stringContaining('o/r#5 checks settled at aaaaaaaa: 3 green, 1 red — watch cleared')]);
  });

  it('ref moved reports both shas', async () => {
    f.answer('/commits/feature%2Fx', { ok: true, stdout: `${SHA_A}\n` }, { ok: true, stdout: `${SHA_B}\n` });
    await m.create(B, { kind: 'ref', target: 'o/r@feature/x', until: 'moved' });
    await m.tick();
    expect(f.sent[0].line).toContain('o/r@feature/x moved aaaaaaaa -> bbbbbbbb');
  });

  it('a lease watch fires on the release event of its own lease, and not on another lease', async () => {
    await m.create(B, { kind: 'lease', target: 'merge:x/y', until: 'free' });
    await m.tick('merge:p/q');
    f.freeLeases.add('merge:p/q');
    await m.tick('merge:p/q');
    expect(f.sent).toEqual([]);
    f.freeLeases.add('merge:x/y');
    await m.tick('merge:x/y');
    expect(f.sent.map((s) => s.line)).toEqual([expect.stringContaining('merge:x/y is free — watch cleared')]);
    expect(f.ghCalls).toEqual([]);
  });

  it('three failures in a row send one failing notice with a server token; none again until it recovers and fails again', async () => {
    f.answer('/pulls/7', f.pull(false, 'open', SHA_A));
    const w = await m.create(B, { kind: 'pr', target: 'o/r#7', until: 'merged' });
    f.answer('/pulls/7', { ok: false, code: 'http-403', message: 'HTTP 403: API rate limit exceeded for user ID 1 <script>' });
    for (let i = 0; i < 5; i++) await tickAt(2);
    expect(f.sent.map((s) => s.line)).toEqual([`[purplemux watch ${w.id}] o/r#7 is failing: http-403 — purplemux watch list shows the error; still trying until it expires`]);
    expect(f.state.watches[0]).toMatchObject({ failures: 5, lastError: { code: 'http-403', message: expect.stringContaining('rate limit') } });
    f.answer('/pulls/7', f.pull(false, 'open', SHA_A));
    await tickAt(2);
    expect(f.state.watches[0]).toMatchObject({ failures: 0, failingNotified: false, lastError: null });
    f.answer('/pulls/7', { ok: false, code: 'timeout', message: 'timed out' });
    for (let i = 0; i < 3; i++) await tickAt(2);
    expect(f.sent.map((s) => s.fields.code)).toEqual(['http-403', 'timeout']);
  });

  it('expires with one notice naming what it waited for', async () => {
    f.answer('/pulls/3', f.pull(false, 'open', SHA_A));
    const w = await m.create(B, { kind: 'pr', target: 'o/r#3', until: 'merged', ttlSeconds: 3600 });
    f.now = w.expiresAt;
    await m.tick();
    expect(f.sent.map((s) => s.line)).toEqual([`[purplemux watch ${w.id}] o/r#3 expired without merged — watch cleared`]);
    expect(f.state.watches).toEqual([]);
    expect(w.expiresAt - w.createdAt).toBe(3600_000);
    expect((await m.create(B, { kind: 'lease', target: 'merge:a/b', until: 'free' })).expiresAt - f.now).toBe(WATCH_DEFAULT_TTL_S * 1000);
  });

  it('the owner tab closing removes its watches; the boot pass drops watches of tabs confirmed gone', async () => {
    await m.create(B, { kind: 'lease', target: 'merge:x/y', until: 'free' });
    await m.create(caller('ws-a', 'tab-a'), { kind: 'lease', target: 'merge:x/y', until: 'free' });
    expect(await m.removeTab('ws-b', 'tab-b')).toBe(1);
    expect(f.state.watches.map((w) => w.tabId)).toEqual(['tab-a']);
    await m.create(caller('ws-c', 'tab-c'), { kind: 'lease', target: 'merge:x/y', until: 'free' });
    await m.create(caller('ws-d', 'tab-d'), { kind: 'lease', target: 'merge:x/y', until: 'free' });
    f.uncertain.add('ws-d');
    expect(await m.hydrate()).toBe(1);
    expect(f.state.watches.map((w) => w.tabId)).toEqual(['tab-a', 'tab-d']);
  });

  it(`refuses the ${WATCH_GITHUB_CAP + 1}st GitHub watch on the host (watch-cap) but not a lease watch`, async () => {
    f.answer('/pulls/', f.pull(false, 'open', SHA_A));
    for (let i = 0; i < WATCH_GITHUB_CAP; i++) {
      await m.create(caller(`ws-${i % 3}`, `tab-${i}`), { kind: 'pr', target: `o/r#${i + 1}`, until: 'merged' });
    }
    const calls = f.ghCalls.length;
    expect(await code(m.create(B, { kind: 'pr', target: 'o/r#999', until: 'merged' }))).toBe('watch-cap');
    expect(f.ghCalls).toHaveLength(calls); // refused before the GitHub read
    expect(await code(m.create(B, { kind: 'lease', target: 'merge:x/y', until: 'free' }))).toBe('none');
  });

  it(`refuses a tab's ${WATCH_TAB_CAP + 1}st watch`, async () => {
    for (let i = 0; i < WATCH_TAB_CAP; i++) await m.create(B, { kind: 'lease', target: `merge:x/y${i}`, until: 'free' });
    expect(await code(m.create(B, { kind: 'lease', target: 'merge:x/z', until: 'free' }))).toBe('watch-cap');
  });

  it('creation: a missing PR is watch-invalid, an unreadable gh is gh-unavailable, and only a tab owns a watch', async () => {
    f.answer('/pulls/404', { ok: false, code: 'http-404', message: 'HTTP 404: Not Found' });
    f.answer('/pulls/500', { ok: false, code: 'gh-missing', message: 'spawn gh ENOENT' });
    expect(await code(m.create(B, { kind: 'pr', target: 'o/r#404', until: 'merged' }))).toBe('watch-invalid');
    expect(await code(m.create(B, { kind: 'pr', target: 'o/r#500', until: 'merged' }))).toBe('gh-unavailable');
    expect(await code(m.create(ADMIN, { kind: 'lease', target: 'merge:x/y', until: 'free' }))).toBe('caller-unresolved');
    expect(await code(m.create(caller('ws-b', null), { kind: 'lease', target: 'merge:x/y', until: 'free' }))).toBe('caller-unresolved');
    expect(f.state.watches).toEqual([]);
  });

  it('list is the caller\'s workspace with owner liveness; clear is the owner tab or admin', async () => {
    const mine = await m.create(B, { kind: 'lease', target: 'merge:x/y', until: 'free', label: 'wait for\nlanding' });
    await m.create(caller('ws-a', 'tab-a'), { kind: 'lease', target: 'merge:x/y', until: 'free' });
    f.live.delete('ws-b/tab-b');
    const listed = await m.list(caller('ws-b', 'tab-other'), null);
    expect(listed.map((w) => [w.id, w.owner, w.label])).toEqual([[mine.id, 'closed', 'wait for landing']]);
    expect(await code(m.list(caller('ws-b', 'tab-other'), 'ws-a'))).toBe('forbidden');
    expect((await m.list(ADMIN, null)).length).toBe(2);
    expect(await code(m.clear(caller('ws-b', 'tab-other'), mine.id))).toBe('forbidden');
    expect(await code(m.clear(B, mine.id))).toBe('none');
    expect(await code(m.clear(B, mine.id))).toBe('watch-not-found');
    expect(await code(m.clear(B, '../x'))).toBe('watch-not-found');
  });

  it('a watch cleared while its GitHub read is in flight is not reported', async () => {
    const w = await (async () => {
      f.answer('/pulls/8', f.pull(false, 'open', SHA_A));
      return m.create(B, { kind: 'pr', target: 'o/r#8', until: 'merged' });
    })();
    const deps = f.deps();
    const racing = new WatchManager({
      ...deps,
      runGh: async (_args) => {
        await m.clear(B, w.id);
        return f.pull(true, 'closed', SHA_A);
      },
    });
    await racing.tick();
    expect(f.sent).toEqual([]);
    expect(f.state.watches).toEqual([]);
  });

  it('never runs two passes at once; a pass asked for meanwhile runs once afterwards', async () => {
    let reads = 0;
    let running = 0;
    let most = 0;
    const deps = f.deps();
    const slow = new WatchManager({
      ...deps,
      read: async () => {
        reads++;
        running++;
        most = Math.max(most, running);
        await new Promise((r) => setTimeout(r, 20));
        running--;
        return deps.read();
      },
    });
    await Promise.all([slow.tick(), slow.tick('merge:x/y'), slow.tick()]);
    expect(most).toBe(1);
    expect(reads).toBe(2);
  });
});

describe('watch spec and GitHub parsing', () => {
  it.each([
    [{ kind: 'pr', target: 'o/r', until: 'merged' }],
    [{ kind: 'pr', target: 'o/r#1', until: 'moved' }],
    [{ kind: 'ref', target: 'o/r@a..b', until: 'moved' }],
    [{ kind: 'ref', target: 'o/r@x y', until: 'moved' }],
    [{ kind: 'lease', target: 'not a lease', until: 'free' }],
    [{ kind: 'lease', target: 'merge:x/y', until: 'merged' }],
    [{ kind: 'pr', target: 'o/r#1', until: 'merged', intervalS: 30 }],
    [{ kind: 'pr', target: 'o/r#1', until: 'merged', ttlSeconds: 8 * 86400 }],
    [{ kind: 'pr', target: 'o/r#1', until: 'merged', label: 'x'.repeat(81) }],
    [{ kind: 'shell', target: 'x', until: 'done' }],
  ])('refuses %j (watch-invalid)', (input) => {
    expect(() => checkSpec(input)).toThrow(WatchError);
  });

  it('counts checks: settled needs at least one and none pending', () => {
    expect(settleChecks('', '')).toEqual({ settled: false, green: 0, red: 0 });
    expect(settleChecks('completed\tsuccess\n', 'pending\n').settled).toBe(false);
    expect(settleChecks('completed\tneutral\ncompleted\ttimed_out\ncompleted\tcancelled\n', 'success\nerror\n'))
      .toEqual({ settled: true, green: 2, red: 3 });
  });

  it('classifies a gh failure into a token, never its text', () => {
    const e = (over: Record<string, unknown>) => Object.assign(new Error('x'), over) as never;
    expect(classifyGhError(e({ code: 'ENOENT' }), '')).toBe('gh-missing');
    expect(classifyGhError(e({ killed: true }), '')).toBe('timeout');
    expect(classifyGhError(e({}), 'gh: Not Found (HTTP 404)')).toBe('http-404');
    expect(classifyGhError(e({}), 'HTTP 403: rate limit')).toBe('http-403');
    expect(classifyGhError(e({}), 'To get started with GitHub CLI, please run:  gh auth login')).toBe('auth');
    expect(classifyGhError(e({}), 'something else')).toBe('other');
  });
});
