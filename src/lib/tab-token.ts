import { randomBytes, timingSafeEqual } from 'crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import { createLogger } from '@/lib/logger';
import { emitTabClosed, onTabClosed, readLiveTabs, type ILiveTab } from '@/lib/tab-lifecycle';

const log = createLogger('tab-token');

export interface ITabTokenRecord {
  token: string;
  workspaceId: string;
  sessionName: string;
  createdAt: string;
}

export type TTabTokens = Record<string, ITabTokenRecord>;

export interface ITabIdentity {
  workspaceId: string;
  tabId: string;
}

export interface IResolvedTabToken {
  tabId: string;
  record: ITabTokenRecord;
}

export interface ITabTokenSweepPlan {
  keep: TTabTokens;
  removed: { tabId: string; record: ITabTokenRecord }[];
  rebound: { fromTabId: string; toTabId: string; record: ITabTokenRecord }[];
  /**
   * Kept although no layout names the tab: its session still runs (the next
   * cross-check adopts it under this id), or its workspace's layout could not
   * be read, so its tabs are unknown rather than gone.
   */
  detached: { tabId: string; record: ITabTokenRecord }[];
}

const g = globalThis as unknown as {
  __ptTabTokens?: TTabTokens;
  __ptTabTokenLock?: Promise<void>;
  __ptTabTokenRevokeInstalled?: boolean;
};
if (!g.__ptTabTokenLock) g.__ptTabTokenLock = Promise.resolve();

const tokensFile = (): string => path.join(os.homedir(), '.purplemux', 'tab-tokens.json');

const withLock = async <T>(fn: () => Promise<T>): Promise<T> => {
  let release: () => void;
  const next = new Promise<void>((r) => {
    release = r;
  });
  const prev = g.__ptTabTokenLock!;
  g.__ptTabTokenLock = next;
  await prev;
  try {
    return await fn();
  } finally {
    release!();
  }
};

const isRecord = (value: unknown): value is ITabTokenRecord => {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return typeof r.token === 'string' && typeof r.workspaceId === 'string'
    && typeof r.sessionName === 'string' && typeof r.createdAt === 'string';
};

/** An unreadable file is moved aside, never overwritten: its tokens are the only record of which tab they name. */
const moveAside = (file: string, err: unknown): void => {
  const aside = `${file}.unreadable-${Date.now()}`;
  try {
    fs.renameSync(file, aside);
    log.warn(`tab-tokens.json unreadable, moved to ${aside}, starting empty: ${err instanceof Error ? err.message : err}`);
  } catch (renameErr) {
    log.warn(`tab-tokens.json unreadable and could not be moved aside, starting empty: ${renameErr instanceof Error ? renameErr.message : renameErr}`);
  }
};

const readTokens = (): TTabTokens => {
  if (g.__ptTabTokens) return g.__ptTabTokens;
  const parsed: TTabTokens = {};
  const file = tokensFile();
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
    for (const [tabId, value] of Object.entries(raw)) {
      if (isRecord(value)) parsed[tabId] = value;
    }
  } catch (err) {
    if (err instanceof SyntaxError) moveAside(file, err);
    else if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn(`tab-tokens.json could not be read, serving empty this run: ${err instanceof Error ? err.message : err}`);
    }
  }
  g.__ptTabTokens = parsed;
  return parsed;
};

/**
 * Writes the in-memory map as it stands when the lock is taken, so the last
 * writer always persists the latest state. Resolves false when the write failed.
 */
const persist = (): Promise<boolean> =>
  withLock(async () => {
    const file = tokensFile();
    const tmp = `${file}.tmp`;
    try {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(tmp, JSON.stringify(readTokens(), null, 2), { mode: 0o600 });
      await fsp.rename(tmp, file);
      return true;
    } catch (err) {
      await fsp.unlink(tmp).catch(() => {});
      log.warn(`tab-tokens.json write failed: ${err instanceof Error ? err.message : err}`);
      return false;
    }
  });

/**
 * The token a session of `identity.tabId` carries. A session recreated for an
 * existing tab (boot cross-check, auto-resume, restart) keeps the tab's token.
 *
 * A new token that cannot be saved is withdrawn and this throws: a token that
 * lives only in memory stops resolving at the next restart, and the CLI
 * presents it before `PMUX_TOKEN`, so the tab would lose its workspace scope too.
 */
export const ensureTabToken = async (identity: ITabIdentity, sessionName: string): Promise<string> => {
  const tokens = readTokens();
  const existing = tokens[identity.tabId];
  if (existing && existing.workspaceId === identity.workspaceId) {
    if (existing.sessionName === sessionName) return existing.token;
    existing.sessionName = sessionName;
    await persist();
    return existing.token;
  }
  const minted: ITabTokenRecord = {
    token: randomBytes(32).toString('hex'),
    workspaceId: identity.workspaceId,
    sessionName,
    createdAt: new Date().toISOString(),
  };
  tokens[identity.tabId] = minted;
  if (!(await persist())) {
    if (tokens[identity.tabId] === minted) delete tokens[identity.tabId];
    throw new Error(`tab token for ${identity.tabId} could not be saved`);
  }
  return minted.token;
};

export const getTabTokenRecord = (tabId: string): ITabTokenRecord | null => readTokens()[tabId] ?? null;

/** The tab id whose token was minted for this exact session of this workspace — an orphan's own id at adoption. */
export const findTabIdBySession = (workspaceId: string, sessionName: string): string | null => {
  for (const [tabId, record] of Object.entries(readTokens())) {
    if (record.workspaceId === workspaceId && record.sessionName === sessionName) return tabId;
  }
  return null;
};

/**
 * Every token of a deleted workspace, including tabs that never reached its
 * layout. Layout tabs were revoked by their own tab-closed event already, so
 * each id revoked here gets its one event now.
 */
export const revokeWorkspaceTabTokens = async (workspaceId: string): Promise<string[]> => {
  const tokens = readTokens();
  const revoked = Object.keys(tokens).filter((tabId) => tokens[tabId].workspaceId === workspaceId);
  if (revoked.length === 0) return revoked;
  const records = revoked.map((tabId) => [tabId, tokens[tabId]] as const);
  for (const tabId of revoked) delete tokens[tabId];
  await persist();
  for (const [tabId, record] of records) {
    emitTabClosed({ workspaceId, tabId, sessionName: record.sessionName, reason: 'workspace-deleted' });
  }
  return revoked;
};

export const revokeTabToken = async (tabId: string): Promise<boolean> => {
  const tokens = readTokens();
  if (!tokens[tabId]) return false;
  delete tokens[tabId];
  await persist();
  return true;
};

const matches = (a: string, b: string): boolean =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export const resolveTabToken = (value: string | null | undefined): IResolvedTabToken | null => {
  if (!value) return null;
  for (const [tabId, record] of Object.entries(readTokens())) {
    if (matches(value, record.token)) return { tabId, record };
  }
  return null;
};

/**
 * Pure: which records survive a boot. A record whose tab is live stays. A
 * record whose session was adopted under a new tab id (an orphan picked up by
 * the boot cross-check) moves to that id — the match is on the exact session
 * name, never on a parse of it. A record whose session still runs in tmux
 * stays: a shell holds it, and a layout reset must not cost that shell its
 * scope. Everything else names a tab that is gone.
 */
export const planTabTokenSweep = (
  tokens: TTabTokens,
  liveTabs: readonly ILiveTab[],
  runningSessions: ReadonlySet<string> = new Set(),
  uncertainWorkspaceIds: ReadonlySet<string> = new Set(),
): ITabTokenSweepPlan => {
  const liveById = new Map(liveTabs.map((t) => [t.tabId, t]));
  const liveBySession = new Map(liveTabs.map((t) => [`${t.workspaceId}\u0000${t.sessionName}`, t]));
  const keep: TTabTokens = {};
  const removed: ITabTokenSweepPlan['removed'] = [];
  const rebound: ITabTokenSweepPlan['rebound'] = [];
  const detached: ITabTokenSweepPlan['detached'] = [];

  for (const [tabId, record] of Object.entries(tokens)) {
    const live = liveById.get(tabId);
    if (live && live.workspaceId === record.workspaceId) {
      keep[tabId] = record;
      continue;
    }
    const adopted = liveBySession.get(`${record.workspaceId}\u0000${record.sessionName}`);
    if (adopted && !tokens[adopted.tabId] && !keep[adopted.tabId]) {
      keep[adopted.tabId] = record;
      rebound.push({ fromTabId: tabId, toTabId: adopted.tabId, record });
      continue;
    }
    if ((runningSessions.has(record.sessionName) || uncertainWorkspaceIds.has(record.workspaceId)) && !keep[tabId]) {
      keep[tabId] = record;
      detached.push({ tabId, record });
      continue;
    }
    removed.push({ tabId, record });
  }
  return { keep, removed, rebound, detached };
};

/** Drop the records of tabs that vanished while the server was down; one tab-closed event each. */
export const sweepTabTokens = async (
  liveTabs: readonly ILiveTab[],
  runningSessions: ReadonlySet<string> = new Set(),
  uncertainWorkspaceIds: ReadonlySet<string> = new Set(),
): Promise<ITabTokenSweepPlan> => {
  const plan = planTabTokenSweep(readTokens(), liveTabs, runningSessions, uncertainWorkspaceIds);
  for (const { tabId, record } of plan.detached) {
    log.warn(`tab token kept although no readable layout names its tab: ${tabId} (${record.workspaceId}, ${record.sessionName})`);
  }
  if (plan.removed.length === 0 && plan.rebound.length === 0) return plan;

  g.__ptTabTokens = plan.keep;
  await persist();
  for (const { fromTabId, toTabId, record } of plan.rebound) {
    log.info(`tab token rebound to adopted tab: ${fromTabId} -> ${toTabId} (${record.sessionName})`);
  }
  for (const { tabId, record } of plan.removed) {
    log.info(`tab token removed at boot, tab no longer exists: ${tabId} (${record.workspaceId}, ${record.sessionName})`);
    emitTabClosed({ workspaceId: record.workspaceId, tabId, sessionName: record.sessionName, reason: 'boot-sweep' });
  }
  return plan;
};

/** A closed tab's token stops resolving at the moment of the close. Idempotent. */
export const installTabTokenRevocation = (): void => {
  if (g.__ptTabTokenRevokeInstalled) return;
  g.__ptTabTokenRevokeInstalled = true;
  onTabClosed(({ tabId }) => {
    revokeTabToken(tabId).catch((err) => {
      log.warn(`tab token revoke failed for ${tabId}: ${err instanceof Error ? err.message : err}`);
    });
  });
};

/** Boot: after the workspace store's cross-check, so adopted orphans are already in the layouts. */
export const initTabTokens = async (): Promise<void> => {
  installTabTokenRevocation();
  const { listSessions } = await import('@/lib/tmux');
  const [live, sessions] = await Promise.all([readLiveTabs(), listSessions()]);
  await sweepTabTokens(live.tabs, new Set(sessions), live.uncertainWorkspaceIds);
};
