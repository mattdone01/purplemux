export const GLOBAL_SESSION_SCOPE = 'global';

export interface ISessionKeyParts {
  provider: string;
  /** Owning workspace, or null for a session that runs unscoped against ~/.claude. */
  workspaceId: string | null;
  sessionId: string;
}

/**
 * Addresses one agent session as `<provider>:<global|wsId>:<sessionId>`.
 *
 * The key is what a client sends instead of a filesystem path: the server
 * resolves it back to a transcript, so no `jsonlPath` ever leaves the machine.
 */
export const buildSessionKey = ({ provider, workspaceId, sessionId }: ISessionKeyParts): string =>
  `${provider}:${workspaceId ?? GLOBAL_SESSION_SCOPE}:${sessionId}`;

export const parseSessionKey = (key: string): ISessionKeyParts | null => {
  const firstSep = key.indexOf(':');
  if (firstSep <= 0) return null;
  const secondSep = key.indexOf(':', firstSep + 1);
  if (secondSep <= firstSep + 1) return null;

  const provider = key.slice(0, firstSep);
  const scope = key.slice(firstSep + 1, secondSep);
  const sessionId = key.slice(secondSep + 1);
  if (!sessionId) return null;

  return {
    provider,
    workspaceId: scope === GLOBAL_SESSION_SCOPE ? null : scope,
    sessionId,
  };
};
