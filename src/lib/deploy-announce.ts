import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { nanoid } from 'nanoid';
import type { ICaller } from '@/lib/caller';
import { createLogger } from '@/lib/logger';
import type { IEnqueueRequest } from '@/lib/inbox-store';
import type { IInboxItem } from '@/types/inbox';
import type { ILease } from '@/types/lease';
import type {
  IDeployAnnouncement,
  IDeployAnnouncementsState,
  IDeployRecipient,
  IDeployRecipientStatus,
  TDeployErrorCode,
  TDeployRecipientReason,
} from '@/types/deploy';

// `purplemux deploy announce` (story 13, ADR-0017): the one broadcast path. It
// tells every enabled orchestrator tab and every live holder of a tab-bound
// lease that the server restarts, through the inbox's fixed `deploy` line
// (ADR-0012). The reason is stored and shown by `deploy status`; it is never typed.

const log = createLogger('deploy-announce');

export class DeployError extends Error {
  constructor(readonly code: TDeployErrorCode, message: string) {
    super(message);
  }
}

export const DEPLOY_REASON_MAX = 120;
export const DEPLOY_MINUTES_MIN = 1;
export const DEPLOY_MINUTES_MAX = 60;
const DAY = 24 * 60 * 60 * 1000;
/** Announcement records are pruned this long after creation. */
export const DEPLOY_RETENTION_MS = 7 * DAY;
export const DEPLOY_LEASE = 'deploy:purplemux';
const DEPLOY_ID = /^d-[A-Za-z0-9_-]{4,32}$/;
const TAB_ID = /^tab-[A-Za-z0-9_-]{1,32}$/;

export const isDeployId = (value: unknown): value is string => typeof value === 'string' && DEPLOY_ID.test(value);

export const checkMinutes = (raw: unknown): number => {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < DEPLOY_MINUTES_MIN || raw > DEPLOY_MINUTES_MAX) {
    throw new DeployError('deploy-invalid', `inMinutes must be a whole number from ${DEPLOY_MINUTES_MIN} to ${DEPLOY_MINUTES_MAX}, got ${JSON.stringify(raw)}`);
  }
  return raw;
};

/** One readable line; control and format characters are removed, not typed anywhere anyway. */
export const cleanReason = (raw: unknown): string => {
  if (typeof raw !== 'string') throw new DeployError('deploy-invalid', 'reason must be text');
  const clean = raw.replace(/[\p{C}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) throw new DeployError('deploy-invalid', 'reason is required');
  const length = [...clean].length;
  if (length > DEPLOY_REASON_MAX) throw new DeployError('deploy-invalid', `reason is ${length} characters; the limit is ${DEPLOY_REASON_MAX}`);
  return clean;
};

export const checkExceptTabs = (raw: unknown): string[] => {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.some((t) => typeof t !== 'string' || !TAB_ID.test(t))) {
    throw new DeployError('deploy-invalid', 'exceptTabIds must be a list of tab ids (tab-…)');
  }
  return raw as string[];
};

// ─── recipients (pure) ────────────────────────────────────────────────────

export interface IRecipientFacts {
  workspaces: ReadonlyArray<{ id: string; orchestration?: { enabled?: boolean; orchestratorTabId?: string | null } | null }>;
  /** Unexpired leases. */
  leases: readonly ILease[];
  liveTabs: ReadonlyArray<{ workspaceId: string; tabId: string }>;
  uncertainWorkspaceIds: ReadonlySet<string>;
}

/**
 * Every enabled orchestrator tab and every holder of a tab-bound lease, once each, in a stable
 * order. A tab confirmed closed is left out (the inbox would drop its notice); a tab whose
 * workspace layout cannot be read is kept, because it may be open. `except` leaves out the tab
 * running the deploy: it is mid-turn, so a notice to it would never be delivered before the restart.
 */
export const recipientsOf = (facts: IRecipientFacts, except: ReadonlySet<string>): Array<Omit<IDeployRecipient, 'itemId'>> => {
  const live = new Set(facts.liveTabs.map((t) => `${t.workspaceId}/${t.tabId}`));
  const mayBeOpen = (ws: string, tab: string) => live.has(`${ws}/${tab}`) || facts.uncertainWorkspaceIds.has(ws);
  const byTab = new Map<string, { workspaceId: string; tabId: string; reasons: TDeployRecipientReason[] }>();
  const add = (workspaceId: string, tabId: string, reason: TDeployRecipientReason) => {
    if (except.has(tabId) || !mayBeOpen(workspaceId, tabId)) return;
    const key = `${workspaceId}/${tabId}`;
    const entry = byTab.get(key) ?? { workspaceId, tabId, reasons: [] };
    if (!entry.reasons.includes(reason)) entry.reasons.push(reason);
    byTab.set(key, entry);
  };
  for (const ws of facts.workspaces) {
    const tab = ws.orchestration?.enabled ? ws.orchestration.orchestratorTabId : null;
    if (tab) add(ws.id, tab, 'orchestrator');
  }
  for (const lease of facts.leases) {
    const { workspaceId, tabId, admin } = lease.holder;
    if (lease.survivesTab || admin || !workspaceId || !tabId) continue;
    add(workspaceId, tabId, `lease ${lease.name}`);
  }
  return [...byTab.values()].sort((a, b) => a.workspaceId.localeCompare(b.workspaceId) || a.tabId.localeCompare(b.tabId));
};

// ─── the file store ───────────────────────────────────────────────────────

const g = globalThis as unknown as { __ptDeployAnnounceLock?: Promise<void> };
if (!g.__ptDeployAnnounceLock) g.__ptDeployAnnounceLock = Promise.resolve();

export const announcementsFile = (): string => path.join(os.homedir(), '.purplemux', 'deploy-announcements.json');

const withLock = async <T>(fn: () => Promise<T>): Promise<T> => {
  let release: () => void;
  const next = new Promise<void>((r) => { release = r; });
  const prev = g.__ptDeployAnnounceLock!;
  g.__ptDeployAnnounceLock = next;
  await prev;
  try {
    return await fn();
  } finally {
    release!();
  }
};

const isAnnouncement = (v: unknown): v is IDeployAnnouncement => {
  if (!v || typeof v !== 'object') return false;
  const a = v as Record<string, unknown>;
  return isDeployId(a.id) && typeof a.reason === 'string' && Number.isSafeInteger(a.createdAt)
    && Number.isSafeInteger(a.restartAt) && Array.isArray(a.recipients);
};

/** Absent file = no announcements; a malformed one is refused, never read as empty. */
export const readAnnouncements = async (): Promise<IDeployAnnouncementsState> => {
  const file = announcementsFile();
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { announcements: [] };
    throw err;
  }
  const list = (JSON.parse(raw) as { announcements?: unknown } | null)?.announcements;
  if (!Array.isArray(list) || !list.every(isAnnouncement)) {
    throw new Error(`${file} is malformed; deploy announcements are refused until it is repaired or moved aside`);
  }
  return { announcements: list };
};

const writeAnnouncements = async (state: IDeployAnnouncementsState): Promise<void> => {
  const file = announcementsFile();
  const tmp = `${file}.tmp`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    await fs.writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
};

export const pruneAnnouncements = (state: IDeployAnnouncementsState, now: number): IDeployAnnouncementsState => {
  const keep = state.announcements.filter((a) => now - a.createdAt < DEPLOY_RETENTION_MS);
  return keep.length === state.announcements.length ? state : { announcements: keep };
};

// ─── the service ──────────────────────────────────────────────────────────

export interface IDeployDeps {
  now: () => number;
  newId: () => string;
  facts: () => Promise<IRecipientFacts>;
  /** True when `caller` holds the `deploy:purplemux` lease. */
  holdsDeployLease: (caller: ICaller) => Promise<boolean>;
  enqueue: (req: IEnqueueRequest<'deploy'>) => Promise<{ item: IInboxItem }>;
  /** Take back a notice still waiting (queued or held); true when it was still waiting. */
  withdraw: (itemId: string, reason: string) => Promise<boolean>;
  inboxItems: () => Promise<IInboxItem[]>;
  cliStateOf: (tabId: string) => string | null;
  read: typeof readAnnouncements;
  mutate: <T>(fn: (state: IDeployAnnouncementsState) => Promise<{ state: IDeployAnnouncementsState; value: T }>) => Promise<T>;
}

export const mutateAnnouncements: IDeployDeps['mutate'] = (fn) =>
  withLock(async () => {
    const before = await readAnnouncements();
    const { state, value } = await fn(before);
    if (state !== before) await writeAnnouncements(state);
    return value;
  });

export interface IAnnounceInput {
  inMinutes?: unknown;
  reason?: unknown;
  exceptTabIds?: unknown;
}

export class DeployAnnouncer {
  constructor(private readonly deps: IDeployDeps) {}

  private async requireAnnouncer(caller: ICaller): Promise<void> {
    if (caller.admin || (await this.deps.holdsDeployLease(caller))) return;
    throw new DeployError('forbidden', `deploy announce needs the admin token or the ${DEPLOY_LEASE} lease`);
  }

  async announce(caller: ICaller, input: IAnnounceInput): Promise<IDeployAnnouncement> {
    const inMinutes = checkMinutes(input.inMinutes);
    const reason = cleanReason(input.reason);
    const except = new Set(checkExceptTabs(input.exceptTabIds));
    await this.requireAnnouncer(caller);
    if (caller.tabId) except.add(caller.tabId);
    const now = this.deps.now();
    const id = this.deps.newId();
    const restartAt = now + inMinutes * 60_000;
    const targets = recipientsOf(await this.deps.facts(), except);
    const by = { workspaceId: caller.admin ? null : caller.workspaceId, tabId: caller.admin ? null : caller.tabId, admin: caller.admin };
    // Under the announcements lock: the store is read (a malformed one refused) before any notice
    // goes out, and the record is written before the lock is released. Should an enqueue or the
    // write fail, every notice already queued is taken back, so no tab is told about a restart
    // whose `deploy status` would answer 404 (review round 1).
    const queued: string[] = [];
    try {
      return await this.deps.mutate(async (state) => {
        const recipients: IDeployRecipient[] = [];
        for (const t of targets) {
          const { item } = await this.deps.enqueue({
            kind: 'deploy',
            targetWorkspaceId: t.workspaceId,
            targetTabId: t.tabId,
            dedupeKey: `deploy-${id}`,
            fields: { deployId: id, restartAt, inMinutes },
          });
          queued.push(item.id);
          recipients.push({ ...t, itemId: item.id });
        }
        const announcement: IDeployAnnouncement = { id, reason, inMinutes, createdAt: now, restartAt, by, recipients };
        return { state: { announcements: [...pruneAnnouncements(state, now).announcements, announcement] }, value: announcement };
      });
    } catch (err) {
      const failed: string[] = [];
      await Promise.all(queued.map((itemId) => this.deps.withdraw(itemId, 'deploy-announce-failed').catch((e) => {
        failed.push(`${itemId} (${e instanceof Error ? e.message : e})`);
        return false;
      })));
      // An inbox that refused the enqueue may refuse the withdrawal too: name what stays queued.
      if (failed.length) log.error(`deploy ${id} failed; these notices could not be withdrawn: ${failed.join(', ')}`);
      throw err;
    }
  }

  /**
   * The announcement is over (the deploy finished, rolled back or was refused): notices still
   * waiting are taken back, so no tab is told about a restart that has already happened. The
   * admin token or the deploy lease holder, as for announce.
   */
  async withdraw(caller: ICaller, id: unknown): Promise<{ id: string; withdrawn: number }> {
    if (!isDeployId(id)) throw new DeployError('deploy-not-found', `no deploy announcement ${String(id)}`);
    await this.requireAnnouncer(caller);
    const found = pruneAnnouncements(await this.deps.read(), this.deps.now()).announcements.find((a) => a.id === id);
    if (!found) throw new DeployError('deploy-not-found', `no deploy announcement ${id}`);
    const results = await Promise.all(found.recipients.map((r) => this.deps.withdraw(r.itemId, 'deploy-over')));
    return { id, withdrawn: results.filter(Boolean).length };
  }

  /**
   * The notice tells each recipient to run `deploy status`, so a recipient's workspace may read
   * it, as may the announcer's workspace, the admin token and the deploy lease holder.
   */
  async status(caller: ICaller, id: unknown): Promise<Omit<IDeployAnnouncement, 'recipients'> & { recipients: IDeployRecipientStatus[] }> {
    if (!isDeployId(id)) throw new DeployError('deploy-not-found', `no deploy announcement ${String(id)}`);
    const now = this.deps.now();
    const found = pruneAnnouncements(await this.deps.read(), now).announcements.find((a) => a.id === id);
    if (!found) throw new DeployError('deploy-not-found', `no deploy announcement ${id}`);
    const mayRead = caller.admin
      || (caller.workspaceId !== null
        && (found.by.workspaceId === caller.workspaceId || found.recipients.some((r) => r.workspaceId === caller.workspaceId)))
      || (await this.deps.holdsDeployLease(caller));
    if (!mayRead) throw new DeployError('forbidden', `deploy ${id} is readable by its recipients, its announcer, the ${DEPLOY_LEASE} holder or admin`);
    const items = new Map((await this.deps.inboxItems()).map((i) => [i.id, i]));
    return {
      ...found,
      recipients: found.recipients.map((r) => ({
        ...r,
        state: (items.get(r.itemId)?.state ?? 'pruned') as IDeployRecipientStatus['state'],
        cliState: this.deps.cliStateOf(r.tabId),
      })),
    };
  }
}

export const newDeployId = (): string => `d-${nanoid(10)}`;

const defaultDeps = async (): Promise<IDeployDeps> => {
  const [leaseStore, workspaceStore, tabLifecycle, inboxStore, { getStatusManager }] = await Promise.all([
    import('@/lib/lease-store'),
    import('@/lib/workspace-store'),
    import('@/lib/tab-lifecycle'),
    import('@/lib/inbox-store'),
    import('@/lib/status-manager'),
  ]);
  const leases = async () => leaseStore.pruneExpired(await leaseStore.readLeaseState(), Date.now()).state.leases;
  return {
    now: () => Date.now(),
    newId: newDeployId,
    facts: async () => {
      const [{ workspaces }, current, live] = await Promise.all([workspaceStore.getWorkspaces(), leases(), tabLifecycle.readLiveTabs()]);
      return { workspaces, leases: current, liveTabs: live.tabs, uncertainWorkspaceIds: live.uncertainWorkspaceIds };
    },
    holdsDeployLease: async (caller) => {
      const lease = (await leases()).find((l) => l.name === DEPLOY_LEASE);
      return !!lease && leaseStore.sameHolder(lease.holder, leaseStore.holderFromCaller(caller));
    },
    enqueue: inboxStore.enqueueNotice,
    withdraw: inboxStore.withdrawNotice,
    inboxItems: async () => (await inboxStore.readInboxState()).items,
    cliStateOf: (tabId) => getStatusManager().getAllForClient()[tabId]?.cliState ?? null,
    read: readAnnouncements,
    mutate: mutateAnnouncements,
  };
};

const gs = globalThis as unknown as { __ptDeployAnnouncer?: DeployAnnouncer };

export const getDeployAnnouncer = async (): Promise<DeployAnnouncer> => {
  if (!gs.__ptDeployAnnouncer) gs.__ptDeployAnnouncer = new DeployAnnouncer(await defaultDeps());
  return gs.__ptDeployAnnouncer;
};
