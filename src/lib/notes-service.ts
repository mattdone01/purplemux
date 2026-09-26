import type { ICaller } from '@/lib/caller';
import type { IEnqueueRequest } from '@/lib/inbox-store';
import type { TNoteEvent } from '@/lib/inbox-templates';
import { createLogger } from '@/lib/logger';
import {
  NOTE_EXPIRE_MS,
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
  /** The workspace's orchestrator tab while orchestration is on and the tab is live; else null. */
  orchestratorOf: (workspaceId: string) => Promise<string | null>;
  workspaceExists: (workspaceId: string) => Promise<boolean>;
  tabLive: (workspaceId: string, tabId: string) => Promise<boolean>;
  enqueue: (req: IEnqueueRequest<'note'>) => Promise<{ item: IInboxItem }>;
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

export class NotesService {
  constructor(private readonly deps: INotesDeps) {}

  // ─── routing ────────────────────────────────────────────────────────────

  private async recipientOf(note: INote): Promise<{ workspaceId: string; tabId: string } | null> {
    if (note.to.epic) return this.deps.epicHolder(note.to.epic);
    if (note.to.workspaceId) {
      const tabId = await this.deps.orchestratorOf(note.to.workspaceId);
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
  private async route(note: INote, now: number): Promise<INote> {
    const to = await this.recipientOf(note);
    if (!to) return undeliverable(note, now);
    const { item } = await this.deps.enqueue(this.notice(note, to, 'delivered'));
    return routed(note, to, item.id, now);
  }

  /** One notice to the sender's tab, when it is still live. */
  private async noticeSender(note: INote, event: 'unacked' | 'expired'): Promise<void> {
    const { workspaceId, tabId } = note.from;
    if (!workspaceId || !tabId || !(await this.deps.tabLive(workspaceId, tabId))) return;
    await this.deps.enqueue(this.notice(note, { workspaceId, tabId }, event));
  }

  /** Advance one note by the clock and the inbox. */
  private async advance(note: INote, now: number): Promise<INote> {
    if (OPEN_STATES.has(note.state) && now - note.createdAt >= NOTE_EXPIRE_MS) {
      await this.noticeSender(note, 'expired');
      return expired(note, now);
    }
    if (note.state === 'queued' || note.state === 'undeliverable') return this.route(note, now);
    if (note.state !== 'delivered') return note;

    const item = note.inboxItemId ? await this.deps.inboxItem(note.inboxItemId) : null;
    // The recipient tab closed before the line reached it: the owner may be someone else now.
    if (!item || item.state === 'dropped') return this.route(requeued(note, now), now);
    let next = note;
    if (item.state === 'delivered' && next.deliveredAt === null) next = reachedComposer(next, item.deliveredAt ?? now);
    if (next.deliveredAt === null || !next.deliveredTo) return next;
    const since = now - next.deliveredAt;
    if (next.remindedAt === null && since >= NOTE_REMIND_MS) {
      await this.deps.enqueue(this.notice(next, next.deliveredTo, 'reminder'));
      next = reminded(next, now);
    }
    if (next.senderNotifiedAt === null && since >= NOTE_SENDER_NOTICE_MS) {
      await this.noticeSender(next, 'unacked');
      next = senderNotified(next, now);
    }
    return next;
  }

  /** Every note once: route, re-route, remind, expire, prune. `onlyEpic` limits routing to one epic. */
  async tick(onlyEpic?: string): Promise<void> {
    const now = this.deps.now();
    await this.deps.mutate(async (state) => {
      let next = state;
      for (const note of state.notes) {
        if (onlyEpic !== undefined && note.to.epic !== onlyEpic) continue;
        let advanced: INote;
        try {
          advanced = await this.advance(note, now);
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
      const sent = await this.route(note, now);
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
    const epicHeld = filter.toMe && !caller.admin ? await this.heldEpics(caller, notes) : new Set<string>();
    return notes
      .filter((n) => canShow(n, caller))
      .filter((n) => !filter.open || OPEN_STATES.has(n.state))
      .filter((n) => !filter.fromMe || (!caller.admin && n.from.workspaceId === caller.workspaceId))
      .filter((n) => !filter.toMe || caller.admin
        || recipientWorkspace(n) === caller.workspaceId
        || (n.to.epic !== null && epicHeld.has(n.to.epic)))
      .filter((n) => !filter.epic || n.to.epic === filter.epic || n.from.epic === filter.epic)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(viewOf);
  }

  private async heldEpics(caller: ICaller, notes: INote[]): Promise<Set<string>> {
    const slugs = [...new Set(notes.map((n) => n.to.epic).filter((s): s is string => !!s))];
    const held = await Promise.all(slugs.map(async (s) => ((await this.deps.holdsEpic(caller, s)) ? s : null)));
    return new Set(held.filter((s): s is string => !!s));
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
  const tabLive = async (workspaceId: string, tabId: string) => {
    const snapshot = await tabLifecycle.readLiveTabs();
    return snapshot.tabs.some((t) => t.workspaceId === workspaceId && t.tabId === tabId);
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
      const tabId = orchestration?.enabled ? orchestration.orchestratorTabId : null;
      return tabId && (await tabLive(workspaceId, tabId)) ? tabId : null;
    },
    workspaceExists: async (workspaceId) => !!(await workspaceStore.getWorkspaceById(workspaceId)),
    tabLive,
    enqueue: inboxStore.enqueueNotice,
    inboxItem: async (id) => (await inboxStore.readInboxState()).items.find((i) => i.id === id) ?? null,
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
