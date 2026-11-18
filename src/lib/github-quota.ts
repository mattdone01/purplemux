// The GitHub quota per account (engineering#810, the lead's guard on item 3): `gh api rate_limit` is read only for the
// agent accounts that fleet config `github.agentAccounts` names, each with its own token in the child env. The token
// of any other account `gh auth status` lists is never read: that account is shown as "not read (owner account)".

export const GITHUB_AGENT_ACCOUNTS_KEY = 'github.agentAccounts';
export const QUOTA_READ_MS = 5 * 60_000;

export const NOT_READ_OWNER = 'not read (owner account)';
export const NOT_READ_UNSET = `not read (set ${GITHUB_AGENT_ACCOUNTS_KEY})`;

export interface IRateWindow {
  remaining: number;
  limit: number;
  /** GitHub's reset, epoch seconds. */
  reset: number;
}

export type TAccountQuota =
  | { login: string; role: 'agent'; state: 'read'; core: IRateWindow; graphql: IRateWindow; readAt: number }
  | { login: string; role: 'agent'; state: 'unknown'; reason: string; readAt: number }
  | { login: string; role: 'owner' | 'unset'; state: 'not-read'; reason: string };

export interface IQuotaRead {
  at: number;
  accounts: TAccountQuota[];
  /** `gh auth status` failed: only the agent accounts are listed. */
  error: string | null;
}

export interface IGhRun {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export interface IQuotaDeps {
  now: () => number;
  /** The raw `github.agentAccounts` value; null when unset. */
  agentAccounts: () => Promise<string | null>;
  /** One gh call; `env` is added to the child's environment and is never logged. */
  gh: (args: string[], env?: Record<string, string>) => Promise<IGhRun>;
}

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export const parseAgentAccounts = (raw: string | null): string[] =>
  [...new Set((raw ?? '').split(',').map((s) => s.trim()).filter((s) => LOGIN.test(s)))];

/** The logins `gh auth status` lists for github.com, in its order. */
export const parseAuthStatusAccounts = (text: string): string[] => {
  const logins: string[] = [];
  for (const m of text.matchAll(/Logged in to github\.com account ([A-Za-z0-9-]+)/g)) if (!logins.includes(m[1])) logins.push(m[1]);
  return logins;
};

const windowOf = (raw: unknown): IRateWindow | null => {
  const w = raw as { remaining?: unknown; limit?: unknown; reset?: unknown } | null;
  const nums = [w?.remaining, w?.limit, w?.reset];
  if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0)) return null;
  const [remaining, limit, reset] = nums as number[];
  if (limit <= 0 || remaining > limit) return null;
  return { remaining, limit, reset };
};

/** Core and GraphQL from a `rate_limit` body; null for anything else, so a bad answer is unknown, never full. */
export const parseRateLimit = (stdout: string): { core: IRateWindow; graphql: IRateWindow } | null => {
  let body: unknown;
  try {
    body = JSON.parse(stdout);
  } catch {
    return null;
  }
  const resources = (body as { resources?: { core?: unknown; graphql?: unknown } } | null)?.resources;
  const core = windowOf(resources?.core);
  const graphql = windowOf(resources?.graphql);
  return core && graphql ? { core, graphql } : null;
};

const firstLine = (text: string): string => text.trim().split('\n')[0]?.slice(0, 200) ?? '';

const readAgent = async (deps: IQuotaDeps, login: string): Promise<TAccountQuota> => {
  const unknown = (reason: string): TAccountQuota => ({ login, role: 'agent', state: 'unknown', reason, readAt: deps.now() });
  const token = await deps.gh(['auth', 'token', '--user', login]);
  const value = token.stdout.trim();
  if (!token.ok || !value || /\s/.test(value)) return unknown(`gh auth token --user ${login} failed: ${firstLine(token.stderr) || 'no token'}`);
  const rate = await deps.gh(['api', 'rate_limit'], { GH_TOKEN: value });
  if (!rate.ok) return unknown(`gh api rate_limit failed: ${firstLine(rate.stderr) || 'no answer'}`);
  const parsed = parseRateLimit(rate.stdout);
  if (!parsed) return unknown('rate_limit did not parse');
  return { login, role: 'agent', state: 'read', ...parsed, readAt: deps.now() };
};

export const readGithubQuotas = async (deps: IQuotaDeps): Promise<IQuotaRead> => {
  const status = await deps.gh(['auth', 'status']);
  const listed = parseAuthStatusAccounts(`${status.stdout}\n${status.stderr}`);
  const error = listed.length || status.ok ? null : `gh auth status failed: ${firstLine(status.stderr) || 'no answer'}`;
  const agents = parseAgentAccounts(await deps.agentAccounts());
  const accounts: TAccountQuota[] = [];
  for (const login of [...agents, ...listed.filter((l) => !agents.includes(l))]) {
    if (agents.includes(login)) accounts.push(await readAgent(deps, login));
    else accounts.push({ login, role: agents.length ? 'owner' : 'unset', state: 'not-read', reason: agents.length ? NOT_READ_OWNER : NOT_READ_UNSET });
  }
  return { at: deps.now(), accounts, error };
};
