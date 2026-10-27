import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { activeOwnerGrant, canSubmitGrant, describeGrantFailure, grantBadgeOf, grantErrorKey, ownerBadgeOf } from '@/lib/grant-view';
import { createGrantRequest } from '@/lib/grants-client';
import type { IGrant } from '@/types/grant';

// ADR-0029 / story 05: the owner grant on the web face — its own badge, the
// dialog's submit rule, the refusal label and the request body.

const NOW = Date.parse('2026-10-26T14:00:00Z');
const grant = (over: Partial<IGrant>): IGrant => ({
  id: 'g-1', capability: 'drive', grantee: { workspaceId: 'ws-1', tabId: 'tab-a' }, workspaces: ['ws-2'], reason: 'r',
  createdAt: NOW - 1, createdBy: 'human', expiresAt: NOW + 3_600_000, revokedAt: null, revokedBy: null, revokeReason: null, expiryNotedAt: null,
  ...over,
});
const owner = (over: Partial<IGrant> = {}) => grant({ id: 'g-own1', capability: 'owner', grantee: { workspaceId: 'ws-1', tabId: 'tab-o' }, workspaces: ['*'], ...over });

describe('owner grant view helpers', () => {
  it('ownerBadgeOf marks only the grantee tab of an active owner grant', () => {
    expect(ownerBadgeOf([owner()], 'ws-1', 'tab-o', NOW)).toEqual({ expiresAt: NOW + 3_600_000 });
    expect(ownerBadgeOf([owner()], 'ws-1', 'tab-a', NOW)).toBeNull();
    expect(ownerBadgeOf([owner({ revokedAt: NOW - 1 })], 'ws-1', 'tab-o', NOW)).toBeNull();
    expect(ownerBadgeOf([owner({ expiresAt: NOW })], 'ws-1', 'tab-o', NOW)).toBeNull();
    expect(ownerBadgeOf([grant({ grantee: { workspaceId: 'ws-1', tabId: 'tab-o' } })], 'ws-1', 'tab-o', NOW)).toBeNull();
  });

  it('grantBadgeOf never counts "*" as a workspace: an owner-only tab has no read badge', () => {
    expect(grantBadgeOf([owner()], 'ws-1', 'tab-o', NOW)).toBeNull();
    expect(grantBadgeOf([owner(), grant({ grantee: { workspaceId: 'ws-1', tabId: 'tab-o' } })], 'ws-1', 'tab-o', NOW))
      .toEqual({ count: 1, workspaces: ['ws-2'], expiresAt: NOW + 3_600_000 });
  });

  it('activeOwnerGrant finds the one active owner grant', () => {
    expect(activeOwnerGrant([grant({}), owner()], NOW)?.id).toBe('g-own1');
    expect(activeOwnerGrant([grant({}), owner({ revokedAt: NOW - 1 })], NOW)).toBeNull();
  });

  it('canSubmitGrant: an owner grant needs no workspace; a read grant still does', () => {
    const form = { workspaces: [], reason: 'owner session', password: 'pw' };
    expect(canSubmitGrant({ identity: 'launch' }, { ...form, capability: 'owner' }, false)).toBe(true);
    expect(canSubmitGrant({ identity: 'launch' }, { ...form, capability: 'drive' }, false)).toBe(false);
    expect(canSubmitGrant({ identity: 'hook' }, { ...form, capability: 'owner' }, false)).toBe(false);
    expect(canSubmitGrant({ identity: 'launch' }, { ...form, capability: 'owner', password: '' }, false)).toBe(false);
  });

  it('labels grant-owner-active with its own key and keeps the served reason', () => {
    expect(grantErrorKey(409, 'grant-owner-active')).toBe('errorOwnerActive');
    expect(grantErrorKey(409, 'grant-tab-unverified')).toBe('errorUnverified');
    expect(describeGrantFailure({ status: 409, code: 'grant-owner-active', reason: 'owner grant g-own1 is active' }, (k) => k))
      .toBe('errorOwnerActive: owner grant g-own1 is active');
  });
});

describe('owner grant request', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends capability owner and no workspaces', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 201, json: async () => ({ grant: owner() }) }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await createGrantRequest({ capability: 'owner', granteeWorkspaceId: 'ws-1', granteeTabId: 'tab-o', reason: 'r', expiresInHours: 24, password: 'pw' });
    expect(r).toEqual({ ok: true, value: owner() });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/grants');
    expect(JSON.parse(String(init.body))).toEqual({ capability: 'owner', granteeWorkspaceId: 'ws-1', granteeTabId: 'tab-o', reason: 'r', expiresInHours: 24, password: 'pw' });
  });
});

describe('grants messages', () => {
  it('every locale carries every key of the English grants messages', () => {
    const dir = path.resolve('messages');
    const keys = Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'en', 'grants.json'), 'utf-8'))).sort();
    for (const locale of fs.readdirSync(dir)) {
      const own = Object.keys(JSON.parse(fs.readFileSync(path.join(dir, locale, 'grants.json'), 'utf-8'))).sort();
      expect({ locale, keys: own }).toEqual({ locale, keys });
    }
  });
});
