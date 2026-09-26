import type { ICaller } from '@/lib/caller';
import type { IEnqueueRequest } from '@/lib/inbox-store';
import type { TNoteEvent } from '@/lib/inbox-templates';
import { createLogger } from '@/lib/logger';
import {
  NOTE_EXPIRE_MS,
  NOTE_EXPIRE_NOTICE_GRACE_MS,
  NOTE_OPEN_PER_SENDER,
  NOTE_REMIND_MS,
  NOTE_SENDER_NOTICE_MS,
  NoteError,
  OPEN_STATES,
  acked,
  canAck,
  canShow,
  checkBody,
  checkTarget,
  cleanComment,
  cleanSubject,
  createNote,
  expired,
  isEpicSlug,
  isNoteId,
  mutateNotes,
  newNoteId,
  prune,
  reachedComposer,
  readNotesState,
  recipientWorkspace,
  reminded,
  replaceNote,
  requeued,
  routed,
  senderNotified,
  undeliverable,
  viewOf,
} from '@/lib/notes-store';
import type { IInboxItem } from '@/types/inbox';
import type { INote, INotesState, INoteView } from '@/types/note';

// Notes routed to the epic's owner (ADR-0013). The recipient is resolved at
// delivery time: the live holder of `epic:<slug>`, or a workspace's enabled
// orchestrator. Only the inbox's fixed line is typed; the body is pulled.

const log = createLogger('notes');

export interface INotesDeps {
  now: () => number;
  newId: () => string;
  mutate: typeof mutateNotes;
  read: () => Promise<INotesState>;
  /** The tab holding `epic:<slug>` while that tab is live; null when nobody live holds it. */
  epicHolder: (slug: string) => Promise<{ workspaceId: string; tabId: string } | null>;
  /** True when `caller` itself holds `epic:<slug>`. */
  holdsEpic: (caller: ICaller, slug: string) => Promise<boolean>;
  /** The workspace's orchestrator tab while orchestration is on (liveness is checked by the caller); else null. */
  orchestratorOf: (workspaceId: string) => Promise<string | null>;
  workspaceExists: (workspaceId: string) => Promise<boolean>;
  /** Every live tab, and the workspaces whose layout could not be read (their tabs are unknown, not closed). */
  liveTabs: () => Promise<ILiveTabs>;
  enqueue: (req: IEnqueueRequest<'note'>) => Promise<{ item: IInboxItem }>;
  /** Drop a notice still waiting in the inbox (queued or held); a delivered one is left alone. */
  withdraw: (itemId: string, reason: string) => Promise<void>;
  inboxItems: () => Promise<IInboxItem[]>;
}

export interface ILiveTabs {
  tabs: ReadonlyArray<{ workspaceId: string; tabId: string }>;
  uncertainWorkspaceIds: ReadonlySet<string>;
}

type TTabState = 'live' | 'closed' | 'unknown';

/**
 * The reads one pass shares: the notes' own inbox and live-tab reads happen once each, and each epic
 * holder and orchestrator is resolved once. An epic holder's lease view reads the live tabs on its
 * own, so it may lag the pass's snapshot by a moment; the next pass settles any difference.
 */
interface IReads {
  epicHolder: (slug: string) => Promise<{ workspaceId: string; tabId: string } | null>;
  /** The workspace's orchestrator tab while it is live; else null. */
  orchestratorOf: (workspaceId: string) => Promise<string | null>;
  tabState: (workspaceId: string, tabId: string) => Promise<TTabState>;
  inboxItem: (id: string) => Promise<IInboxItem | null>;
}

export interface ISendInput {
  toEpic?: unknown;
  toWorkspace?: unknown;
  subject?: unknown;
  body?: unknown;
  fromEpic?: unknown;
}

export interface IListFilter {
  open?: boolean;
  toMe?: boolean;
  fromMe?: boolean;
  epic?: string | null;
}

/**
 * `--to-me` is the tab the note was routed to, not the workspace: every epic of the portfolio
 * shares one workspace, and every tab reads its notes at turn start (review round 1). A note not
 * yet routed is no tab's; the lease-acquire tick routes it to the new holder. A token with no tab
 * reads its workspace.
 */
const isToMe = (n: INote, caller: ICaller): boolean => {
  if (!caller.tabId) return recipientWorkspace(n) === caller.workspaceId;
  return n.deliveredTo !== null && n.deliveredTo.workspaceId === caller.workspaceId && n.deliveredTo.tabId === caller.tabId;
};

export class NotesService {
  constructor(private readonly deps: INotesDeps) {}

  // ─── routing ────────────────────────────────────────────────────────────

  private async recipientOf(note: INote, r: IReads): Promise<{ workspaceId: string; tabId: string } | null> {
    if (note.to.epic) return r.epicHolder(note.to.epic);
    if (note.to.workspaceId) {
      const tabId = await r.orchestratorOf(note.to.workspaceId);
      return tabId ? { workspaceId: note.to.workspaceId, tabId } : null;
    }
    return null;
  }

  private notice(note: INote, to: { workspaceId: string; tabId: string }, event: TNoteEvent): IEnqueueRequest<'note'> {
    return {
      kind: 'note',
      targetWorkspaceId: to.workspaceId,
      targetTabId: to.tabId,
      dedupeKey: `note:${note.id}:${event}:${to.tabId}`,
      fields: { noteId: note.id, fromWorkspaceId: note.from.workspaceId, fromTabId: note.from.tabId, sentAt: note.createdAt, event },
    };
  }

  /** Route a queued or undeliverable note: enqueue its line for the live recipient, or mark it undeliverable. */
  private async route(note: INote, now: number, r: IReads): Promise<INote> {
    const to = await this.recipientOf(note, r);
    if (!to) return undeliverable(note, now);
    const { item } = await this.deps.enqueue(this.notice(note, to, 'delivered'));
    return routed(note, to, item.id, now);
  }

  /**
   * One notice to the sender's tab when it is live. True when the notice is settled: sent, or the
   * sender has no tab or its tab is confirmed closed. An unknown tab state settles nothing.
   */
  private async noticeSender(note: INote, event: 'unacked' | 'expired', r: IReads): Promise<boolean> {
    const { workspaceId, tabId } = note.from;
    if (!workspaceId || !tabId) return true;
    const state = await r.tabState(workspaceId, tabId);
    if (state === 'live') await this.deps.enqueue(this.notice(note, { workspaceId, tabId }, event));
    return state !== 'unknown';
  }

  /**
   * The routed tab can no longer act on the note: it is confirmed closed (an epic lease dies with
   * its tab), or the recipient role moved to another live tab — a different holder of the epic, or
   * a different orchestrator of the workspace (review round 3). Unknown liveness is not gone.
   */
  private async recipientGone(note: INote, r: IReads): Promise<boolean> {
    const to = note.deliveredTo;
    if (!to) return false;
    if ((await r.tabState(to.workspaceId, to.tabId)) === 'closed') return true;
    const now = await this.recipientOf(note, r);
    return !!now && (now.workspaceId !== to.workspaceId || now.tabId !== to.tabId);
  }

  /**
   * Advance one note by the clock and the inbox. Each side effect is recorded as soon as it is
   * done, so a later failure in the same pass never repeats an earlier notice (review round 1).
   */
  private async advance(note: INote, now: number, r: IReads): Promise<INote> {
    if (OPEN_STATES.has(note.state) && now - note.createdAt >= NOTE_EXPIRE_MS) {
      // The one expiry notice waits while the sender's liveness is unknown, for at most a day.
      const settled = await this.noticeSender(note, 'expired', r);
      if (!settled && now - note.createdAt < NOTE_EXPIRE_MS + NOTE_EXPIRE_NOTICE_GRACE_MS) return note;
      return expired(note, now);
    }
    if (note.state === 'queued' || note.state === 'undeliverable') return this.route(note, now, r);
    if (note.state !== 'delivered') return note;

    const item = note.inboxItemId ? await r.inboxItem(note.inboxItemId) : null;
    // Re-route only when the line never reached the recipient: an explicit drop (its tab closed),
    // or an item gone before it was delivered. The inbox prunes a DELIVERED item after 7 days;
    // that is not a drop, and re-routing it would deliver the note again.
    if (item?.state === 'dropped' || (!item && note.deliveredAt === null)) return this.route(requeued(note, now), now, r);
    // A line that reached a tab which is now closed, or an epic that changed hands, goes to the
    // current owner: `--to-me` is the routed tab, so nobody else would see it (review round 2).
    if (await this.recipientGone(note, r)) {
      // The old tab may still be open with the line waiting: take the line back first, so it is not
      // typed there after the note has moved (review round 3). A failed withdrawal defers the move.
      if (item && (item.state === 'queued' || item.state === 'held')) await this.deps.withdraw(item.id, 'note-rerouted');
      return this.route(requeued(note, now), now, r);
    }
    let next = note;
    if (item?.state === 'delivered' && next.deliveredAt === null) next = reachedComposer(next, item.deliveredAt ?? now);
    // The recipient's reminder counts from the line reaching its composer: a busy recipient is not
    // reminded of a line it has not seen. recipientGone() above leaves only a live or unknown tab;
    // an unknown one is tried again next pass, never marked as reminded.
    if (next.deliveredTo && next.deliveredAt !== null && next.remindedAt === null && now - next.deliveredAt >= NOTE_REMIND_MS) {
      // Not live here means unknown: the reminder waits, and the sender's clock below still runs
      // (review round 3: an unreadable recipient must not hold back the sender's escalation).
      let sent = false;
      try {
        if ((await r.tabState(next.deliveredTo.workspaceId, next.deliveredTo.tabId)) === 'live') {
          await this.deps.enqueue(this.notice(next, next.deliveredTo, 'reminder'));
          sent = true;
        }
      } catch (err) {
        log.warn(`note ${note.id} reminder not sent: ${err instanceof Error ? err.message : err}`);
        return next;
      }
      if (sent) next = reminded(next, now);
    }
    // The sender's notice counts from the first routing, once per note: it is the escalation for a
    // recipient that never reads the line, so it must not wait for the line to be read.
    if (next.senderNotifiedAt === null && next.routedAt !== null && now - next.routedAt >= NOTE_SENDER_NOTICE_MS) {
      try {
        if (!(await this.noticeSender(next, 'unacked', r))) return next;
      } catch (err) {
        log.warn(`note ${note.id} sender notice not sent: ${err instanceof Error ? err.message : err}`);
        return next;
      }
      next = senderNotified(next, now);
    }
    return next;
  }

  /** One pass's reads: the inbox and the live tabs are read once, each epic holder and orchestrator once. */
  private reads(): IReads {
    const d = this.deps;
    let live: Promise<ILiveTabs> | null = null;
    let inbox: Promise<Map<string, IInboxItem>> | null = null;
    const holders = new Map<string, Promise<{ workspaceId: string; tabId: string } | null>>();
    const orchestrators = new Map<string, Promise<string | null>>();
    const tabState = async (workspaceId: string, tabId: string): Promise<TTabState> => {
      live ??= d.liveTabs();
      const snapshot = await live;
      if (snapshot.tabs.some((t) => t.workspaceId === workspaceId && t.tabId === tabId)) return 'live';
      return snapshot.uncertainWorkspaceIds.has(workspaceId) ? 'unknown' : 'closed';
    };
    return {
      epicHolder: (slug) => {
        if (!holders.has(slug)) holders.set(slug, d.epicHolder(slug));
        return holders.get(slug)!;
      },
      orchestratorOf: (workspaceId) => {
        if (!orchestrators.has(workspaceId)) {
          orchestrators.set(workspaceId, (async () => {
            const tabId = await d.orchestratorOf(workspaceId);
            return tabId && (await tabState(workspaceId, tabId)) === 'live' ? tabId : null;
          })());
        }
        return orchestrators.get(workspaceId)!;
      },
      tabState,
      inboxItem: async (id) => {
        inbox ??= d.inboxItems().then((items) => new Map(items.map((i) => [i.id, i])));
        return (await inbox).get(id) ?? null;
      },
    };
  }

  private ticking: Promise<void> | null = null;
  private again: string | undefined | null = null;

  /**
   * Every note once: route, re-route, remind, expire, prune. `onlyEpic` limits routing to one epic.
   * One tick at a time: a tick asked for while one runs runs once more afterwards, never in parallel.
   */
  async tick(onlyEpic?: string): Promise<void> {
    if (this.ticking) {
      this.again = this.again === null ? onlyEpic : undefined;
      return this.ticking;
    }
    this.ticking = (async () => {
      try {
        let scope: string | undefined | null = onlyEpic;
        while (scope !== null) {
          this.again = null;
          await this.tickOnce(scope);
          scope = this.again;
        }
      } finally {
        this.ticking = null;
      }
    })();
    return this.ticking;
  }

  private async tickOnce(onlyEpic?: string): Promise<void> {
    const now = this.deps.now();
    const r = this.reads();
    await this.deps.mutate(async (state) => {
      let next = state;
      for (const note of state.notes) {
        if (onlyEpic !== undefined && note.to.epic !== onlyEpic) continue;
        let advanced: INote;
        try {
          advanced = await this.advance(note, now, r);
        } catch (err) {
          log.warn(`note ${note.id} could not advance: ${err instanceof Error ? err.message : err}`);
          continue;
        }
        if (advanced !== note) next = replaceNote(next, advanced);
      }
      next = prune(next, now);
      return { state: next, value: undefined };
    });
  }

  // ─── the CLI operations ─────────────────────────────────────────────────

  async send(caller: ICaller, input: ISendInput): Promise<INoteView> {
    const to = checkTarget(input.toEpic, input.toWorkspace);
    const subject = cleanSubject(input.subject);
    const body = checkBody(input.body);
    let epic: string | null = null;
    if (input.fromEpic !== undefined && input.fromEpic !== null && input.fromEpic !== '') {
      if (!isEpicSlug(input.fromEpic) || !(await this.deps.holdsEpic(caller, input.fromEpic))) {
        throw new NoteError('forbidden', `fromEpic is accepted only from the holder of epic:${String(input.fromEpic)}`);
      }
      epic = input.fromEpic;
    }
    if (to.workspaceId && !(await this.deps.workspaceExists(to.workspaceId))) {
      throw new NoteError('note-target-missing', `no workspace ${to.workspaceId}`);
    }
    const now = this.deps.now();
    const note = createNote(
      {
        from: { workspaceId: caller.admin ? null : caller.workspaceId, tabId: caller.admin ? null : caller.tabId, verified: caller.verified, epic },
        to,
        subject,
        body,
      },
      now,
      this.deps.newId(),
    );
    return this.deps.mutate(async (state) => {
      const mine = state.notes.filter((n) => OPEN_STATES.has(n.state)
        && n.from.workspaceId === note.from.workspaceId && n.from.tabId === note.from.tabId).length;
      if (mine >= NOTE_OPEN_PER_SENDER) {
        throw new NoteError('note-cap', `this sender already has ${mine} open notes (the limit is ${NOTE_OPEN_PER_SENDER}); wait for acks or expiry`);
      }
      const sent = await this.route(note, now, this.reads());
      return { state: { notes: [...state.notes, sent] }, value: viewOf(sent) };
    });
  }

  async show(caller: ICaller, id: unknown): Promise<{ note: INoteView; body: string }> {
    const note = await this.find(id);
    if (!canShow(note, caller)) throw new NoteError('forbidden', `note ${note.id} belongs to other workspaces`);
    return { note: viewOf(note), body: note.body };
  }

  async ack(caller: ICaller, id: unknown, comment: unknown): Promise<INoteView> {
    const clean = cleanComment(comment);
    return this.deps.mutate((state) => {
      const note = state.notes.find((n) => n.id === id);
      if (!isNoteId(id) || !note) throw new NoteError('note-not-found', `no note ${String(id)}`);
      if (!canAck(note, caller)) throw new NoteError('forbidden', `only the recipient workspace acks note ${note.id}`);
      if (note.state === 'acked') return { state, value: viewOf(note) };
      if (note.state !== 'delivered') throw new NoteError('forbidden', `note ${note.id} is ${note.state}, not delivered`);
      const done = acked(note, { workspaceId: caller.workspaceId!, tabId: caller.tabId }, clean, this.deps.now());
      return { state: replaceNote(state, done), value: viewOf(done) };
    });
  }

  async list(caller: ICaller, filter: IListFilter): Promise<INoteView[]> {
    const { notes } = await this.deps.read();
    return notes
      .filter((n) => canShow(n, caller))
      .filter((n) => !filter.open || OPEN_STATES.has(n.state))
      .filter((n) => !filter.fromMe || (!caller.admin && n.from.workspaceId === caller.workspaceId))
      .filter((n) => !filter.toMe || caller.admin || isToMe(n, caller))
      .filter((n) => !filter.epic || n.to.epic === filter.epic || n.from.epic === filter.epic)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(viewOf);
  }

  private async find(id: unknown): Promise<INote> {
    const note = isNoteId(id) ? (await this.deps.read()).notes.find((n) => n.id === id) : undefined;
    if (!note) throw new NoteError('note-not-found', `no note ${String(id)}`);
    return note;
  }
}

// ─── the server's instance ────────────────────────────────────────────────

export const NOTES_TICK_MS = 15_000;

const defaultDeps = async (): Promise<INotesDeps> => {
  const [leaseStore, leaseHttp, workspaceStore, tabLifecycle, inboxStore] = await Promise.all([
    import('@/lib/lease-store'),
    import('@/lib/lease-http'),
    import('@/lib/workspace-store'),
    import('@/lib/tab-lifecycle'),
    import('@/lib/inbox-store'),
  ]);
  const epicLease = async (slug: string) => {
    const now = Date.now();
    const { state } = leaseStore.pruneExpired(await leaseStore.readLeaseState(), now);
    return state.leases.find((l) => l.name === `epic:${slug}`) ?? null;
  };
  return {
    now: () => Date.now(),
    newId: newNoteId,
    mutate: mutateNotes,
    read: readNotesState,
    epicHolder: async (slug) => {
      const lease = await epicLease(slug);
      if (!lease?.holder.tabId || !lease.holder.workspaceId) return null;
      const view = await leaseHttp.viewOf(lease);
      return view.holderState === 'live' ? { workspaceId: lease.holder.workspaceId, tabId: lease.holder.tabId } : null;
    },
    holdsEpic: async (caller, slug) => {
      const lease = await epicLease(slug);
      return !!lease && leaseStore.sameHolder(lease.holder, leaseStore.holderFromCaller(caller));
    },
    orchestratorOf: async (workspaceId) => {
      const orchestration = (await workspaceStore.getWorkspaceById(workspaceId))?.orchestration;
      return (orchestration?.enabled ? orchestration.orchestratorTabId : null) ?? null;
    },
    workspaceExists: async (workspaceId) => !!(await workspaceStore.getWorkspaceById(workspaceId)),
    liveTabs: tabLifecycle.readLiveTabs,
    enqueue: inboxStore.enqueueNotice,
    withdraw: inboxStore.withdrawNotice,
    inboxItems: async () => (await inboxStore.readInboxState()).items,
  };
};

interface INotesRuntime {
  service: NotesService | null;
  timer: ReturnType<typeof setInterval> | null;
  unsubscribe: (() => void) | null;
}

const g = globalThis as unknown as { __ptNotesRuntime?: INotesRuntime; __ptNotesService?: NotesService };

/** The service the CLI routes use; the runtime ticks the same one. */
export const getNotesService = async (): Promise<NotesService> => {
  if (!g.__ptNotesService) g.__ptNotesService = new NotesService(await defaultDeps());
  return g.__ptNotesService;
};

export const startNotes = async (): Promise<void> => {
  if (g.__ptNotesRuntime) return;
  const runtime: INotesRuntime = { service: null, timer: null, unsubscribe: null };
  g.__ptNotesRuntime = runtime;
  const service = await getNotesService();
  const { onLeaseAcquired } = await import('@/lib/lease-store');
  if (g.__ptNotesRuntime !== runtime) return;
  runtime.service = service;
  const tick = (onlyEpic?: string) => {
    service.tick(onlyEpic).catch((err) => log.warn(`notes tick failed: ${err instanceof Error ? err.message : err}`));
  };
  // Claiming an epic routes the notes that waited for its owner now, not on the next tick.
  runtime.unsubscribe = onLeaseAcquired((lease, outcome) => {
    if (lease.kind === 'epic' && outcome === 'acquired') tick(lease.resource);
  });
  const timer = setInterval(() => tick(), NOTES_TICK_MS);
  timer.unref?.();
  runtime.timer = timer;
  tick();
};

export const stopNotes = async (): Promise<void> => {
  const runtime = g.__ptNotesRuntime;
  if (!runtime) return;
  g.__ptNotesRuntime = undefined;
  if (runtime.timer) clearInterval(runtime.timer);
  runtime.unsubscribe?.();
};
