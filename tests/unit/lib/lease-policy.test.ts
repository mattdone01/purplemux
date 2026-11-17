import { describe, expect, it } from 'vitest';
import {
  LEASE_KINDS,
  LeasePolicyError,
  OTHER_KIND,
  parseLeaseKind,
  parseLeaseName,
  resolveEpic,
  resolveNote,
  resolveTtl,
} from '@/lib/lease-policy';
import type { ILeaseHolder } from '@/types/lease';

const tab: ILeaseHolder = { workspaceId: 'ws-1', tabId: 'tab-a', tabName: 'A', verified: true, admin: false };
const admin: ILeaseHolder = { workspaceId: null, tabId: null, tabName: null, verified: false, admin: true };
const M = 60;
const H = 3600;
const D = 86400;

describe('lease kind policy table (architecture.md "Lease kinds")', () => {
  it('pins every kind exactly', () => {
    const table = Object.fromEntries(Object.entries(LEASE_KINDS).map(([k, p]) => [k, [p.defaultTtlSeconds, p.maxTtlSeconds, p.survivesTab, p.requiresEpic, p.orchestratorOnly]]));
    expect(table).toEqual({
      merge: [45 * M, 3 * H, false, false, false],
      'dev-deploy': [45 * M, 3 * H, false, false, false],
      'dev-write': [60 * M, 8 * H, false, false, false],
      deploy: [30 * M, 2 * H, false, false, true],
      epic: [null, 7 * D, false, false, false],
      pool: [60 * M, D, false, false, false],
      'pool-queue': [2 * M, D, false, false, false],
      'pool-cancel': [10 * M, 10 * M, false, false, false],
      num: [14 * D, 30 * D, true, true, false],
      held: [15 * M, 15 * M, false, false, false],
    });
    expect([OTHER_KIND.defaultTtlSeconds, OTHER_KIND.maxTtlSeconds, OTHER_KIND.survivesTab]).toEqual([30 * M, D, false]);
  });
});

describe('parseLeaseName', () => {
  it('lower-cases so two spellings are one lease', () => {
    expect(parseLeaseName('merge:Acme/acme-ledger-api')).toEqual({ name: 'merge:acme/acme-ledger-api', kind: 'merge', resource: 'acme/acme-ledger-api' });
  });

  it.each([
    ['', 'does not match'],
    ['merge', 'does not match'],
    ['m:x/y', 'does not match'],
    ['1merge:x/y', 'does not match'],
    ['merge:x y', 'does not match'],
    ['merge:acme', 'must be <owner>/<repo>'],
    ['dev-deploy:a/b/c', 'must be <owner>/<repo>'],
    ['num:acme/acme-ledger-api:adr', 'must be <owner>/<repo>:<adr|migration>:<nnnn>'],
    ['num:acme/acme-ledger-api:rfc:0001', 'must be <owner>/<repo>:<adr|migration>:<nnnn>'],
    ['epic:a/b', 'must be an epic slug'],
    [`epic:${'a'.repeat(101)}`, 'must be an epic slug'],
    ['pool:host-b-lan/review-1', 'must be <host>/<gate|build|mutation|browser|test-service|tab>-<n>'],
    ['pool:host-b-lan/gate-1000', 'must be <host>/<gate|build|mutation|browser|test-service|tab>-<n>'],
    // NR-5b: the shared browser and one run's gate slot, nothing else.
    ['held:host-a', 'must be <host>/browser-9333 or <host>/gate-<k>.<runid>'],
    ['held:host-a/browser-9400', 'must be <host>/browser-9333 or <host>/gate-<k>.<runid>'],
    ['held:host-a/gate-1', 'must be <host>/browser-9333 or <host>/gate-<k>.<runid>'],
    ['held:host-a/gate-1.', 'must be <host>/browser-9333 or <host>/gate-<k>.<runid>'],
    ['held:host-a/gate-1.-run', 'must be <host>/browser-9333 or <host>/gate-<k>.<runid>'],
    ['held:host-a/gate-1000.run1', 'must be <host>/browser-9333 or <host>/gate-<k>.<runid>'],
    ['held:host-a/gate-1.run.2', 'must be <host>/browser-9333 or <host>/gate-<k>.<runid>'],
    [`held:host-a/gate-1.${'r'.repeat(65)}`, 'must be <host>/browser-9333 or <host>/gate-<k>.<runid>'],
    ['held:host-a/tab-1', 'must be <host>/browser-9333 or <host>/gate-<k>.<runid>'],
    ['held:host-a/gate-1.run1/x', 'must be <host>/browser-9333 or <host>/gate-<k>.<runid>'],
  ])('refuses %j with a named rule', (raw, message) => {
    expect(() => parseLeaseName(raw)).toThrow(LeasePolicyError);
    expect(() => parseLeaseName(raw)).toThrow(message);
  });

  it('accepts every kind in its resource form', () => {
    for (const name of ['merge:acme/acme-ledger-api', 'dev-deploy:acme/acme-ledger-ui', 'dev-write:dev', 'deploy:purplemux',
      'epic:purplemux-portfolio-coordination', 'num:acme/acme-ledger-api:adr:0373', 'num:acme/acme-ledger-event-consumer:migration:415', 'pool:host-b-lan/gate-1', 'pool:host-a/tab-12', 'smoke:anything/goes#1',
      'held:host-a/browser-9333', 'held:host-b-lan/gate-3.20261117t0700-4821', `held:host-a/gate-12.${'r'.repeat(64)}`]) {
      expect(parseLeaseName(name).name).toBe(name);
    }
  });

  it('refuses a non-string', () => {
    expect(() => parseLeaseName(undefined)).toThrow('name is required');
  });

  it('lower-cases a held run id, so two spellings are one record', () => {
    expect(parseLeaseName('held:Host-A/gate-2.Run-7')).toEqual({ name: 'held:host-a/gate-2.run-7', kind: 'held', resource: 'host-a/gate-2.run-7' });
  });
});

describe('parseLeaseKind', () => {
  it('lower-cases a kind and checks it alone', () => {
    expect(parseLeaseKind('held')).toBe('held');
    expect(parseLeaseKind(' HELD ')).toBe('held');
  });

  it.each(['', 'h', 'held:x', '1held', 'held kind', 'h'.repeat(33), undefined, 7])('refuses %j, naming the grammar', (raw) => {
    expect(() => parseLeaseKind(raw)).toThrow(LeasePolicyError);
    expect(() => parseLeaseKind(raw)).toThrow('does not match');
  });
});

describe('resolveTtl', () => {
  it('takes the kind default when none is given', () => {
    expect(resolveTtl('held', undefined, tab)).toBe(15 * M);
    expect(resolveTtl('merge', undefined, tab)).toBe(45 * M);
    expect(resolveTtl('num', undefined, tab)).toBe(14 * D);
    expect(resolveTtl('smoke', undefined, tab)).toBe(30 * M);
    expect(resolveTtl('epic', undefined, tab)).toBeNull();
  });

  it('refuses a TTL over the kind maximum, naming the rule', () => {
    expect(() => resolveTtl('merge', 5 * H, tab)).toThrow('merge leases allow at most 3h, got 5h');
    expect(() => resolveTtl('smoke', 25 * H, tab)).toThrow('allow at most 1d');
  });

  it('allows no expiry only for a kind without a default, and only for a tab holder', () => {
    expect(resolveTtl('epic', null, tab)).toBeNull();
    expect(() => resolveTtl('merge', null, tab)).toThrow('merge leases must expire');
    expect(() => resolveTtl('epic', null, admin)).toThrow('an admin holder must give a TTL');
    expect(() => resolveTtl('epic', undefined, admin)).toThrow('an admin holder must give a TTL');
    expect(() => resolveTtl('epic', undefined, { ...tab, tabId: null })).toThrow('a tabless holder must give a TTL');
    expect(resolveTtl('epic', 3600, admin)).toBe(3600);
  });

  it('refuses a TTL that is not a positive whole number', () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) expect(() => resolveTtl('merge', bad, tab)).toThrow('positive whole number');
  });
});

describe('resolveEpic / resolveNote', () => {
  it('requires an epic for num, naming the rule', () => {
    expect(() => resolveEpic('num', undefined)).toThrow('num leases require an epic');
    expect(() => resolveEpic('num', '')).toThrow('num leases require an epic');
    expect(resolveEpic('num', 'P4')).toBe('p4');
    expect(resolveEpic('merge', undefined)).toBeNull();
    expect(() => resolveEpic('merge', 'bad slug')).toThrow('does not match');
  });

  it('flattens control characters and bounds the note', () => {
    expect(resolveNote('a\nb\u0007c')).toBe('a b c');
    expect(resolveNote('')).toBeNull();
    expect(() => resolveNote('x'.repeat(501))).toThrow('at most 500');
  });
});
