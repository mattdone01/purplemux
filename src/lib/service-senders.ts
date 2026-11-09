import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Workspace-bound service senders (ADR-0044). A service sender is a process with no tab, such as a
// systemd timer, that acts as the tab-less caller of ONE home workspace. Its entry is also its grant:
// it may note exactly one other workspace, `noteTarget`. The owner writes the entry on the server host;
// no HTTP route writes it. The file stores only the SHA-256 of each token, never the token.

export interface IServiceGrant {
  name: string;
  /** The home workspace. The sender acts there as a tab-less workspace caller. */
  workspaceId: string;
  /** The one other workspace this sender may note. */
  noteTarget: string;
}

interface IServiceSenderEntry extends IServiceGrant {
  tokenSha256: string;
}

const NAME = /^[a-z0-9][a-z0-9-]{0,47}$/;
const WORKSPACE_ID = /^ws-[A-Za-z0-9_-]{1,32}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export const serviceSendersFile = (): string => path.join(os.homedir(), '.purplemux', 'service-senders.json');

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

const g = globalThis as unknown as {
  __ptServiceSenders?: { key: string; entries: IServiceSenderEntry[] };
};

const isEntry = (value: unknown): value is IServiceSenderEntry => {
  if (!value || typeof value !== 'object') return false;
  const e = value as Record<string, unknown>;
  return typeof e.name === 'string' && NAME.test(e.name)
    && typeof e.workspaceId === 'string' && WORKSPACE_ID.test(e.workspaceId)
    && typeof e.noteTarget === 'string' && WORKSPACE_ID.test(e.noteTarget)
    && e.noteTarget !== e.workspaceId
    && typeof e.tokenSha256 === 'string' && SHA256_HEX.test(e.tokenSha256);
};

/**
 * The valid entries. Fail closed: a missing, unreadable, unparsable, or group- or world-writable file
 * grants nothing. An invalid entry and every entry that shares a name or a token hash are dropped.
 * The read is cached by mtime and size, so a removed entry stops the sender on its next call.
 */
export const readServiceSenders = (): IServiceSenderEntry[] => {
  const file = serviceSendersFile();
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    g.__ptServiceSenders = undefined;
    return [];
  }
  if ((stat.mode & 0o022) !== 0) return [];
  const key = `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
  if (g.__ptServiceSenders?.key === key) return g.__ptServiceSenders.entries;
  let entries: IServiceSenderEntry[] = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as { senders?: unknown };
    const all = Array.isArray(parsed?.senders) ? parsed.senders.filter(isEntry) : [];
    const count = (field: 'name' | 'tokenSha256', v: string) => all.filter((e) => e[field] === v).length;
    entries = all.filter((e) => count('name', e.name) === 1 && count('tokenSha256', e.tokenSha256) === 1);
  } catch {
    entries = [];
  }
  g.__ptServiceSenders = { key, entries };
  return entries;
};

const grantOf = (e: IServiceSenderEntry): IServiceGrant => ({ name: e.name, workspaceId: e.workspaceId, noteTarget: e.noteTarget });

/** The grant whose token this is, or null. Compares hashes in constant time. */
export const resolveServiceToken = (value: string): IServiceGrant | null => {
  const entries = readServiceSenders();
  if (entries.length === 0) return null;
  const presented = Buffer.from(sha256(value), 'hex');
  const match = entries.find((e) => timingSafeEqual(presented, Buffer.from(e.tokenSha256, 'hex')));
  return match ? grantOf(match) : null;
};

/** True while the registry still grants `name`, bound to `workspaceId`, to note `noteTarget`. */
export const serviceGrantActive = (name: string, workspaceId: string, noteTarget: string): boolean =>
  readServiceSenders().some((e) => e.name === name && e.workspaceId === workspaceId && e.noteTarget === noteTarget);

/**
 * Add or replace the entry `grant.name` and write a fresh token to `tokenFile` (mode 0600). The token
 * goes only to that file, never to the return value or to a log. A new token replaces the old one.
 */
export const grantServiceSender = (grant: IServiceGrant, tokenFile: string): IServiceGrant => {
  if (!NAME.test(grant.name)) throw new Error(`service sender name must match ${NAME.source}`);
  if (!WORKSPACE_ID.test(grant.workspaceId) || !WORKSPACE_ID.test(grant.noteTarget)) {
    throw new Error('workspaceId and noteTarget must be workspace ids');
  }
  if (grant.workspaceId === grant.noteTarget) throw new Error('noteTarget must be another workspace');
  const file = serviceSendersFile();
  let senders: unknown[] = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as { senders?: unknown };
    if (Array.isArray(parsed?.senders)) senders = parsed.senders;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const token = randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
  fs.writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  fs.chmodSync(tokenFile, 0o600);
  const entry: IServiceSenderEntry = {
    name: grant.name, workspaceId: grant.workspaceId, noteTarget: grant.noteTarget, tokenSha256: sha256(token),
  };
  const next = [...senders.filter((s) => !(s && typeof s === 'object' && (s as { name?: unknown }).name === grant.name)), entry];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ senders: next }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return grantOf(entry);
};

/** Remove the entry `name`. True when an entry was removed. */
export const revokeServiceSender = (name: string): boolean => {
  const file = serviceSendersFile();
  let senders: unknown[];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as { senders?: unknown };
    senders = Array.isArray(parsed?.senders) ? parsed.senders : [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
  const next = senders.filter((s) => !(s && typeof s === 'object' && (s as { name?: unknown }).name === name));
  if (next.length === senders.length) return false;
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ senders: next }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return true;
};
