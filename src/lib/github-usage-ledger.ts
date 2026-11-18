// Every `gh` call the server makes, per owner tab (engineering#810). The tab calls the gh shim logs use the same
// vocabulary (`gh-shim.ts` builds its allow-list from GH_COMMAND_WORDS), so both sources add up per owner.

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;
const MINUTE_MS = 60_000;

export type TGhKind = 'rest' | 'graphql';
export type TGhCallSource = 'server' | 'tab';

/**
 * The gh commands whose second word is recorded, and the subcommand names recorded for each. Any other word is
 * written as `?`: a word outside this list can be a path, a number or a token. `api` and the commands with no
 * subcommand list are handled apart.
 */
export const GH_COMMAND_WORDS: Readonly<Record<string, readonly string[]>> = {
  pr: ['checks', 'view', 'list', 'status', 'diff', 'create', 'merge', 'comment', 'edit', 'close', 'reopen', 'ready', 'review', 'checkout', 'update-branch', 'lock', 'unlock', 'revert'],
  run: ['view', 'watch', 'list', 'rerun', 'cancel', 'download', 'delete'],
  issue: ['view', 'list', 'status', 'create', 'comment', 'edit', 'close', 'reopen', 'delete', 'develop', 'lock', 'unlock', 'pin', 'unpin', 'transfer'],
  repo: ['view', 'list', 'clone', 'create', 'fork', 'sync', 'edit', 'delete', 'archive', 'unarchive', 'rename', 'set-default', 'deploy-key', 'autolink', 'gitignore', 'license'],
  workflow: ['run', 'list', 'view', 'enable', 'disable'],
  release: ['view', 'list', 'create', 'download', 'upload', 'delete', 'delete-asset', 'edit', 'verify', 'verify-asset'],
  auth: ['status', 'token', 'login', 'logout', 'switch', 'refresh', 'setup-git'],
  search: ['issues', 'prs', 'repos', 'code', 'commits'],
  label: ['list', 'create', 'edit', 'delete', 'clone'],
  secret: ['list', 'set', 'delete'],
  variable: ['list', 'set', 'get', 'delete'],
  cache: ['list', 'delete'],
  ruleset: ['list', 'view', 'check'],
  gist: ['list', 'view', 'create', 'edit', 'delete', 'clone', 'rename'],
  project: ['list', 'view', 'create', 'edit', 'delete', 'item-list', 'item-add', 'item-edit', 'field-list'],
  attestation: ['verify', 'download'],
  extension: ['list', 'install', 'upgrade', 'remove', 'exec', 'browse', 'search', 'create'],
  config: ['get', 'set', 'list', 'clear-cache'],
  alias: ['list', 'set', 'delete', 'import'],
};

/** Known gh commands that take no subcommand: word 2 is `-` when absent, else `?`. */
export const GH_PLAIN_COMMANDS: readonly string[] = ['status', 'browse', 'completion', 'version', 'help'];

/**
 * The subcommands gh serves through GraphQL, which spend the GraphQL budget, not the REST (core) one. Every other
 * call, `gh api <path>` and an unknown word included, counts as REST.
 */
const GRAPHQL_COMMANDS = new Set([
  'pr checks', 'pr view', 'pr list', 'pr status', 'pr create', 'pr merge', 'pr comment', 'pr edit', 'pr close', 'pr reopen',
  'pr ready', 'pr review', 'issue view', 'issue list', 'issue status', 'issue create', 'issue comment', 'issue edit',
  'issue close', 'issue reopen', 'repo view',
]);

export interface IGhCallWords {
  kind: TGhKind;
  w1: string;
  w2: string;
}

export const kindOfWords = (w1: string, w2: string): TGhKind => {
  if (w1 === 'api') return w2 === 'graphql' ? 'graphql' : 'rest';
  return GRAPHQL_COMMANDS.has(`${w1} ${w2}`) ? 'graphql' : 'rest';
};

/** The two words a call is recorded as, and its kind. An api call records its kind, never its path. */
export const classifyGhArgs = (args: readonly string[]): IGhCallWords => {
  const [first, second] = args;
  if (first === 'api') {
    const w2 = args.slice(1).includes('graphql') ? 'graphql' : 'rest';
    return { kind: w2, w1: 'api', w2 };
  }
  if (first !== undefined && Object.prototype.hasOwnProperty.call(GH_COMMAND_WORDS, first)) {
    const w2 = second === undefined ? '-' : GH_COMMAND_WORDS[first].includes(second) ? second : '?';
    return { kind: kindOfWords(first, w2), w1: first, w2 };
  }
  if (first !== undefined && GH_PLAIN_COMMANDS.includes(first)) return { kind: 'rest', w1: first, w2: second === undefined ? '-' : '?' };
  return { kind: 'rest', w1: '?', w2: '?' };
};

export interface IGhOwner {
  workspaceId: string;
  tabId: string;
}

const NO_OWNER: IGhOwner = { workspaceId: '-', tabId: '-' };

/** A watch's owner, `<workspaceId>/<tabId>` (watch-manager), as the ledger keys it. */
export const ownerOfWatch = (owner: string): IGhOwner => {
  const slash = owner.indexOf('/');
  if (slash <= 0 || slash === owner.length - 1) return NO_OWNER;
  return { workspaceId: owner.slice(0, slash), tabId: owner.slice(slash + 1) };
};

/** Calls of one owner, kind and subcommand in one minute: the unit both sources are counted in. */
export interface IGhCallCount extends IGhOwner, IGhCallWords {
  source: TGhCallSource;
  /** The start of the minute, in ms. */
  at: number;
  count: number;
}

const SEP = '\u0000';

export const minuteOf = (ms: number): number => Math.floor(ms / MINUTE_MS) * MINUTE_MS;

/**
 * The server's own calls, in memory, one bucket per minute, 24 hours back (R3: a restart starts it again; the tab
 * logs survive it).
 */
export class GhCallLedger {
  private readonly buckets = new Map<number, Map<string, number>>();

  constructor(readonly startedAt: number) {}

  record(owner: IGhOwner | null, args: readonly string[], now: number): void {
    const { workspaceId, tabId } = owner ?? NO_OWNER;
    const { kind, w1, w2 } = classifyGhArgs(args);
    const minute = minuteOf(now);
    const bucket = this.buckets.get(minute) ?? new Map<string, number>();
    const key = [workspaceId, tabId, kind, w1, w2].join(SEP);
    bucket.set(key, (bucket.get(key) ?? 0) + 1);
    this.buckets.set(minute, bucket);
    this.prune(now);
  }

  /** Every count from `from` (inclusive, by minute) to `now`. */
  counts(from: number, now: number): IGhCallCount[] {
    this.prune(now);
    const out: IGhCallCount[] = [];
    for (const [at, bucket] of this.buckets) {
      if (at < minuteOf(from)) continue;
      for (const [key, count] of bucket) {
        const [workspaceId, tabId, kind, w1, w2] = key.split(SEP);
        out.push({ source: 'server', workspaceId, tabId, kind: kind as TGhKind, w1, w2, at, count });
      }
    }
    return out;
  }

  private prune(now: number): void {
    for (const at of this.buckets.keys()) if (at <= now - DAY_MS) this.buckets.delete(at);
  }
}

const g = globalThis as unknown as { __ptGhCallLedger?: GhCallLedger };

/** The one ledger of this process: the custom server and the API routes share it. */
export const serverGhLedger = (): GhCallLedger => {
  if (!g.__ptGhCallLedger) g.__ptGhCallLedger = new GhCallLedger(Date.now());
  return g.__ptGhCallLedger;
};
