import { describe, expect, it } from 'vitest';
import {
  GITHUB_AGENT_ACCOUNTS_KEY,
  parseAgentAccounts,
  parseAuthStatusAccounts,
  parseRateLimit,
  readGithubQuotas,
  type IQuotaDeps,
} from '@/lib/github-quota';

// The owner-token guard: rate_limit is read only for the agent accounts; the owner's
// token is never taken.

const NOW = Date.UTC(2026, 10, 18, 8, 0, 0);

const AUTH_STATUS = `github.com
  ✓ Logged in to github.com account agent-bot (keyring)
  - Active account: true
  - Git operations protocol: ssh
  - Token: gho_************************************
  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'

  ✓ Logged in to github.com account mattdone01 (keyring)
  - Active account: false
  - Git operations protocol: ssh
  - Token: gho_************************************
`;

const RATE = (coreRemaining: number) => JSON.stringify({
  resources: {
    core: { limit: 5000, used: 5000 - coreRemaining, remaining: coreRemaining, reset: 1_763_455_200 },
    graphql: { limit: 5000, used: 10, remaining: 4990, reset: 1_763_455_500 },
    search: { limit: 30, used: 0, remaining: 30, reset: 1_763_452_000 },
  },
  rate: { limit: 5000, used: 5000 - coreRemaining, remaining: coreRemaining, reset: 1_763_455_200 },
});

interface ICall { args: string[]; env?: Record<string, string> }

const fakeDeps = (accounts: string | null, replies: Record<string, { ok: boolean; stdout: string; stderr?: string }> = {}) => {
  const calls: ICall[] = [];
  const deps: IQuotaDeps = {
    now: () => NOW,
    agentAccounts: async () => accounts,
    gh: async (args, env) => {
      calls.push({ args, ...(env ? { env } : {}) });
      const key = args.join(' ');
      if (replies[key]) return { stderr: '', ...replies[key] };
      if (key === 'auth status') return { ok: true, stdout: '', stderr: AUTH_STATUS };
      if (key.startsWith('auth token --user ')) return { ok: true, stdout: `gho_token_of_${args[3]}\n`, stderr: '' };
      if (key === 'api rate_limit') return { ok: true, stdout: RATE(4200), stderr: '' };
      return { ok: false, stdout: '', stderr: 'unexpected' };
    },
  };
  return { deps, calls };
};

describe('parsers', () => {
  it('names the key', () => {
    expect(GITHUB_AGENT_ACCOUNTS_KEY).toBe('github.agentAccounts');
  });

  it('reads the logins gh auth status lists', () => {
    expect(parseAuthStatusAccounts(AUTH_STATUS)).toEqual(['agent-bot', 'mattdone01']);
    expect(parseAuthStatusAccounts('You are not logged into any GitHub hosts.')).toEqual([]);
  });

  it('reads the agent accounts key: comma-separated logins, a malformed one dropped', () => {
    expect(parseAgentAccounts(' agent-bot, bot-2 ,,')).toEqual(['agent-bot', 'bot-2']);
    expect(parseAgentAccounts('a b,$(x),ok')).toEqual(['ok']);
    expect(parseAgentAccounts(null)).toEqual([]);
  });

  it('reads core and graphql from rate_limit; anything else is unknown, never full', () => {
    expect(parseRateLimit(RATE(12))).toEqual({
      core: { remaining: 12, limit: 5000, reset: 1_763_455_200 },
      graphql: { remaining: 4990, limit: 5000, reset: 1_763_455_500 },
    });
    expect(parseRateLimit('not json')).toBeNull();
    expect(parseRateLimit('{}')).toBeNull();
    expect(parseRateLimit(JSON.stringify({ resources: { core: { limit: 5000, remaining: 'x', reset: 1 }, graphql: { limit: 1, remaining: 1, reset: 1 } } }))).toBeNull();
    expect(parseRateLimit(JSON.stringify({ resources: { core: { limit: 0, remaining: 0, reset: 1 }, graphql: { limit: 1, remaining: 1, reset: 1 } } }))).toBeNull();
  });
});

describe('readGithubQuotas', () => {
  it('reads only the agent account, with its token in the child env, and never asks for the owner token', async () => {
    const { deps, calls } = fakeDeps('agent-bot');
    const read = await readGithubQuotas(deps);
    expect(calls.map((c) => c.args.join(' '))).toEqual(['auth status', 'auth token --user agent-bot', 'api rate_limit']);
    expect(calls.some((c) => c.args.includes('mattdone01') && c.args[0] === 'auth' && c.args[1] === 'token')).toBe(false);
    expect(calls[2].env).toEqual({ GH_TOKEN: 'gho_token_of_agent-bot' });
    expect(read.accounts).toEqual([
      {
        login: 'agent-bot', role: 'agent', state: 'read', readAt: NOW,
        core: { remaining: 4200, limit: 5000, reset: 1_763_455_200 }, graphql: { remaining: 4990, limit: 5000, reset: 1_763_455_500 },
      },
      { login: 'mattdone01', role: 'owner', state: 'not-read', reason: 'not read (owner account)' },
    ]);
    expect(JSON.stringify(read)).not.toContain('gho_token');
  });

  it('with no key set reads no token at all', async () => {
    const { deps, calls } = fakeDeps(null);
    const read = await readGithubQuotas(deps);
    expect(calls.map((c) => c.args.join(' '))).toEqual(['auth status']);
    expect(read.accounts).toEqual([
      { login: 'agent-bot', role: 'unset', state: 'not-read', reason: 'not read (set github.agentAccounts)' },
      { login: 'mattdone01', role: 'unset', state: 'not-read', reason: 'not read (set github.agentAccounts)' },
    ]);
  });

  it('a rate_limit answer that does not parse is unknown, never full', async () => {
    const { deps } = fakeDeps('agent-bot', { 'api rate_limit': { ok: true, stdout: '<html>' } });
    const [agent] = (await readGithubQuotas(deps)).accounts;
    expect(agent).toEqual({ login: 'agent-bot', role: 'agent', state: 'unknown', reason: 'rate_limit did not parse', readAt: NOW });
  });

  it('a failed token read or a failed rate_limit call is unknown and names the step, never the token', async () => {
    const noToken = fakeDeps('agent-bot', { 'auth token --user agent-bot': { ok: false, stdout: '', stderr: 'no oauth token found' } });
    expect((await readGithubQuotas(noToken.deps)).accounts[0]).toMatchObject({ state: 'unknown', reason: expect.stringContaining('gh auth token') });
    expect(noToken.calls.map((c) => c.args[0] + ' ' + c.args[1])).not.toContain('api rate_limit');
    const failed = fakeDeps('agent-bot', { 'api rate_limit': { ok: false, stdout: '', stderr: 'HTTP 401: Bad credentials' } });
    expect((await readGithubQuotas(failed.deps)).accounts[0]).toMatchObject({ state: 'unknown', reason: expect.stringContaining('HTTP 401') });
  });

  it('an agent account gh auth status does not list is still read; a failed status lists the agents only', async () => {
    const { deps, calls } = fakeDeps('bot-2', { 'auth status': { ok: false, stdout: '', stderr: 'timeout' } });
    const read = await readGithubQuotas(deps);
    expect(read.error).toMatch(/gh auth status/);
    expect(read.accounts.map((a) => [a.login, a.role, a.state])).toEqual([['bot-2', 'agent', 'read']]);
    expect(calls.some((c) => c.args.join(' ') === 'auth token --user mattdone01')).toBe(false);
  });
});
