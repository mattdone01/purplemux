import path from 'path';
import { GLOBAL_SESSION_SCOPE } from '@/lib/session-key';
import { listWorkspaceGrokHomes } from '@/lib/grok-home';
import { listWorkspaceClaudeHomes, listWorkspaceSummaries } from '@/lib/workspace-home';

export interface ISessionScope {
  /** `global` or the workspace id — what a search hit reports and what `workspaceId=` selects. */
  id: string;
  name: string;
  /** null for the unscoped `~/.claude` home; this is the sessionKey's middle segment. */
  workspaceId: string | null;
  directories: string[];
}

export const globalScope = (): ISessionScope => ({
  id: GLOBAL_SESSION_SCOPE,
  name: GLOBAL_SESSION_SCOPE,
  workspaceId: null,
  directories: [],
});

/**
 * Every scope a session may belong to: the unscoped home plus one per workspace.
 */
export const listSessionScopes = async (): Promise<ISessionScope[]> => {
  const byId = new Map<string, ISessionScope>();

  for (const summary of await listWorkspaceSummaries()) {
    byId.set(summary.id, {
      id: summary.id,
      name: summary.name,
      workspaceId: summary.id,
      directories: summary.directories,
    });
  }

  // A home left behind by a deleted workspace still holds transcripts, so it is
  // listed under its own id rather than dropped.
  const orphanHomes = [...await listWorkspaceClaudeHomes(), ...await listWorkspaceGrokHomes()];
  for (const home of orphanHomes) {
    const id = path.basename(path.dirname(home));
    if (byId.has(id)) continue;
    byId.set(id, { id, name: id, workspaceId: id, directories: [] });
  }

  return [globalScope(), ...byId.values()];
};

/** True when `cwd` is `directory` itself or anything under it. */
export const isWithinDirectory = (directory: string, cwd: string): boolean => {
  const relative = path.relative(path.resolve(directory), path.resolve(cwd));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

/**
 * The workspace that owns a working directory. A session started in a
 * SUBDIRECTORY of a workspace root belongs to that workspace — exact string
 * equality would have left it unattributed — and the deepest matching directory
 * wins, so nested roots resolve to one answer whatever order they are listed in.
 */
export const scopeForCwd = (scopes: ISessionScope[], cwd: string | null | undefined): ISessionScope | null => {
  if (!cwd) return null;

  let best: ISessionScope | null = null;
  let bestDepth = -1;
  for (const scope of scopes) {
    for (const directory of scope.directories) {
      if (!isWithinDirectory(directory, cwd)) continue;
      const depth = path.resolve(directory).length;
      if (depth > bestDepth) {
        best = scope;
        bestDepth = depth;
      }
    }
  }
  return best;
};

export interface ISessionScopeInput {
  provider: string;
  scopes: ISessionScope[];
  /**
   * The workspace a caller already knows owns the session. Claude and grok both
   * key their stores per home, so the home names the workspace; a caller
   * holding a grok home converts it with `workspaceIdForGrokHome` first.
   */
  workspaceId?: string | null;
  /** The directory the session was started in — Codex keys its rollouts by cwd. */
  cwd?: string | null;
}

/**
 * The ONE derivation of a sessionKey's workspace segment.
 *
 * The live socket, `/api/timeline/search` and `/api/timeline/sessions-v2` all
 * call this, so one session cannot end up with two keys depending on which route
 * produced it — the phone stores per key, and two keys mean the same session
 * twice on device.
 *
 * - **claude** keys by claude-home and **grok** by `GROK_HOME`; either home IS
 *   the workspace, so both read `workspaceId` and neither consults the cwd. A
 *   grok session under `~/.grok` — an ad-hoc tab — is global.
 * - **codex** keys its rollouts by cwd, so the owning workspace is the one that
 *   lists a directory containing it.
 */
export const sessionScopeFor = ({ provider, scopes, workspaceId, cwd }: ISessionScopeInput): ISessionScope => {
  if (provider === 'claude' || provider === 'grok') {
    if (!workspaceId) return globalScope();
    return scopes.find((scope) => scope.id === workspaceId)
      ?? { id: workspaceId, name: workspaceId, workspaceId, directories: [] };
  }

  return scopeForCwd(scopes, cwd) ?? globalScope();
};
