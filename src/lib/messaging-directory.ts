// The messaging directory (ADR-0050, S1): one entry per Claude tab, the session's own messaging socket path as its
// status hook reported it. In server memory only: a restart empties it, and seats register again at their next
// generic hook event. The server never connects to a socket; it hands the path to a caller the lookup admits.

export const SOCKET_PATH = /^\/[A-Za-z0-9._/-]{1,106}\.sock$/;
const PERMISSION_MODE = /^[A-Za-z]{1,32}$/;

export interface IAddressEntry {
  tabId: string;
  workspaceId: string;
  socketPath: string;
  /** `uds:<path>`: the SendMessage address. */
  address: string;
  /** The tab's agent session when it registered; a different one later makes the entry stale. */
  agentSessionId: string | null;
  /** The tab's ssh host (ADR-0022); null for this host. */
  host: string | null;
  /** As the hook input named it, e.g. `bypassPermissions` or `default`; `unknown` when it named none. */
  permissionMode: string;
  registeredAt: number;
  lastSeenAt: number;
}

export interface IAddressRegistration {
  tabId: string;
  workspaceId: string;
  socketPath: string;
  agentSessionId: string | null;
  host: string | null;
  permissionMode: string | null;
}

const g = globalThis as unknown as { __ptMessagingDirectory?: Map<string, IAddressEntry>; __ptMessagingDirectoryStarted?: boolean };
const directory = (): Map<string, IAddressEntry> => (g.__ptMessagingDirectory ??= new Map());
const keyOf = (workspaceId: string, tabId: string): string => `${workspaceId}/${tabId}`;

/**
 * Store or refresh a tab's address. A path off the grammar stores nothing. The same path and session refresh
 * `lastSeenAt` (and the mode, when one is named); anything else replaces the entry.
 */
export const registerAddress = (reg: IAddressRegistration, now: number = Date.now()): IAddressEntry | null => {
  if (!SOCKET_PATH.test(reg.socketPath)) return null;
  const mode = reg.permissionMode !== null && PERMISSION_MODE.test(reg.permissionMode) ? reg.permissionMode : null;
  const known = directory().get(keyOf(reg.workspaceId, reg.tabId));
  const entry: IAddressEntry = known && known.socketPath === reg.socketPath && known.agentSessionId === reg.agentSessionId
    ? { ...known, host: reg.host, permissionMode: mode ?? known.permissionMode, lastSeenAt: now }
    : {
      tabId: reg.tabId,
      workspaceId: reg.workspaceId,
      socketPath: reg.socketPath,
      address: `uds:${reg.socketPath}`,
      agentSessionId: reg.agentSessionId,
      host: reg.host,
      permissionMode: mode ?? 'unknown',
      registeredAt: now,
      lastSeenAt: now,
    };
  directory().set(keyOf(reg.workspaceId, reg.tabId), entry);
  return entry;
};

export const addressOf = (workspaceId: string, tabId: string): IAddressEntry | null => directory().get(keyOf(workspaceId, tabId)) ?? null;

export const clearAddress = (workspaceId: string, tabId: string): boolean => directory().delete(keyOf(workspaceId, tabId));

/** A server restart, for tests: the directory starts empty. */
export const resetMessagingDirectory = (): void => {
  directory().clear();
};

/** The pid in a `<pid>.sock` path, or null when the name carries none. */
export const socketPid = (socketPath: string): number | null => {
  const m = /\/(\d{1,10})\.sock$/.exec(socketPath);
  return m ? Number(m[1]) : null;
};

/** A closed tab loses its entry. Installed once per process; the other clear rules run where their events happen. */
export const startMessagingDirectory = async (): Promise<void> => {
  if (g.__ptMessagingDirectoryStarted) return;
  g.__ptMessagingDirectoryStarted = true;
  const { onTabClosed } = await import('@/lib/tab-lifecycle');
  onTabClosed(({ workspaceId, tabId }) => {
    clearAddress(workspaceId, tabId);
  });
};
