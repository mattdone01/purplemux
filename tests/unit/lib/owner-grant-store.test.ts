import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ITabClosedEvent } from '@/lib/tab-lifecycle';
import type { IGrant } from '@/types/grant';

// ADR-0029 §1 / ruling R3: owner grants live in owner-grants.json — same record
// shape, own cache, own lock. Each file fails closed on its own, and the drive
// file keeps the exact shape an older release parses.

const lifecycle = vi.hoisted(() => ({
  live: [] as Array<{ workspaceId: string; tabId: string }>,
  listener: null as ((e: ITabClosedEvent) => void) | null,
}));
const audit = vi.hoisted(() => vi.fn(async (_e: Record<string, unknown>) => {}));

vi.mock('@/lib/tab-lifecycle', () => ({
  readLiveTabs: vi.fn(async () => ({ tabs: lifecycle.live, uncertainWorkspaceIds: new Set<string>() })),
  onTabClosed: vi.fn((l: (e: ITabClosedEvent) => void) => {
    lifecycle.listener = l;
    return () => { lifecycle.listener = null; };
  }),
}));
vi.mock('@/lib/coordination-audit', () => ({ appendCoordinationAudit: audit }));
vi.mock('@/lib/workspace-store', () => ({ getWorkspaceById: vi.fn(async (id: string) => ({ id, allowedPeers: [] })) }));
vi.mock('@/lib/scrum-master-access', () => ({ selectedScrumMasterCanRead: async () => false }));

const T0 = Date.parse('2026-10-26T12:00:00Z');
const H = 60 * 60 * 1000;
const DAY = 24 * H;

const record = (over: Partial<IGrant> = {}): IGrant => ({
  id: 'g-own1', capability: 'owner', grantee: { workspaceId: 'ws-1', tabId: 'tab-o' }, workspaces: ['*'], reason: 'r',
  createdAt: T0, createdBy: 'human', expiresAt: T0 + H, revokedAt: null, revokedBy: null, revokeReason: null, expiryNotedAt: null,
  ...over,
});

const writeFile = async (file: string, grants: unknown[]) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ grants }));
};

const deps = () => ({
  now: () => T0, audit, passwordHash: async () => null, verifyPassword: async () => false,
  workspaceExists: async () => true, tabExists: async () => true, tabIdentity: () => 'launch' as const,
});

describe('owner grant store (ADR-0029)', () => {
  beforeEach(async () => {
    const { grantsFile, ownerGrantsFile, reloadGrants } = await import('@/lib/grant-store');
    fs.rmSync(grantsFile(), { force: true });
    fs.rmSync(ownerGrantsFile(), { force: true });
    reloadGrants();
    audit.mockClear();
    lifecycle.live = [];
  });
  afterEach(async () => {
    const { stopGrants } = await import('@/lib/grant-service');
    stopGrants();
    const { grantsFile, ownerGrantsFile, reloadGrants } = await import('@/lib/grant-store');
    fs.rmSync(grantsFile(), { force: true });
    fs.rmSync(ownerGrantsFile(), { force: true });
    reloadGrants();
  });

  it('findActiveOwnerGrant matches only the exact grantee tab of an active owner grant', async () => {
    const { findActiveOwnerGrant } = await import('@/lib/grant-store');
    const state = { grants: [record(), record({ id: 'g-drv1', capability: 'drive', workspaces: ['ws-2'], grantee: { workspaceId: 'ws-1', tabId: 'tab-d' } })] };
    expect(findActiveOwnerGrant(state, { workspaceId: 'ws-1', tabId: 'tab-o' }, T0 + 1)?.id).toBe('g-own1');
    expect(findActiveOwnerGrant(state, { workspaceId: 'ws-1', tabId: 'tab-d' }, T0 + 1)).toBeNull();
    expect(findActiveOwnerGrant(state, { workspaceId: 'ws-2', tabId: 'tab-o' }, T0 + 1)).toBeNull();
    expect(findActiveOwnerGrant(state, { workspaceId: 'ws-1', tabId: 'tab-o' }, T0 + H)).toBeNull();
    expect(findActiveOwnerGrant({ grants: [record({ revokedAt: T0 })] }, { workspaceId: 'ws-1', tabId: 'tab-o' }, T0 + 1)).toBeNull();
  });

  it.each([
    ['a drive record', record({ capability: 'drive' })],
    ['an owner record naming workspaces', record({ workspaces: ['ws-2'] })],
    ['an owner record with "*" and more', record({ workspaces: ['*', 'ws-2'] })],
  ])('owner-grants.json holding %s is refused whole, never read as empty', async (_label, bad) => {
    const { grantsRefusal, grantsSnapshot, ownerGrantsFile, reloadGrants } = await import('@/lib/grant-store');
    await writeFile(ownerGrantsFile(), [record({ id: 'g-good1' }), bad]);
    reloadGrants();
    expect(grantsSnapshot('owner')).toEqual({ grants: [] });
    expect(grantsRefusal('owner')).toMatch(/owner-grants\.json is malformed/);
    expect(grantsRefusal('drive')).toBeNull();
  });

  it('grants.json still refuses an owner record whole, as the live release does', async () => {
    const { grantsFile, grantsRefusal, reloadGrants } = await import('@/lib/grant-store');
    await writeFile(grantsFile(), [record()]);
    reloadGrants();
    expect(grantsRefusal('drive')).toMatch(/grants\.json is malformed/);
    expect(grantsRefusal('owner')).toBeNull();
  });

  it('revokes an owner grant while grants.json is malformed, and answers grant-store-unreadable for an id it cannot find', async () => {
    const { grantsFile, ownerGrantsFile, reloadGrants } = await import('@/lib/grant-store');
    const { revokeGrant } = await import('@/lib/grant-service');
    fs.mkdirSync(path.dirname(grantsFile()), { recursive: true });
    fs.writeFileSync(grantsFile(), '{nope');
    await writeFile(ownerGrantsFile(), [record()]);
    reloadGrants();
    expect(await revokeGrant(deps(), 'human', 'g-own1')).toMatchObject({ id: 'g-own1', revokeReason: 'revoked', revokedBy: 'human' });
    await expect(revokeGrant(deps(), 'human', 'g-zzzz9')).rejects.toMatchObject({ code: 'grant-store-unreadable' });
    expect(fs.readFileSync(grantsFile(), 'utf-8')).toBe('{nope');
  });

  it('answers grant-not-found when neither readable file holds the id', async () => {
    const { revokeGrant } = await import('@/lib/grant-service');
    await expect(revokeGrant(deps(), 'human', 'g-zzzz9')).rejects.toMatchObject({ code: 'grant-not-found' });
  });

  it('a malformed owner file never stops the drive sweep or the drive close revoke', async () => {
    const { createGrantInState, grantsSnapshot, mutateGrants, ownerGrantsFile, reloadGrants } = await import('@/lib/grant-store');
    const { revokeForClosedTab, sweepGrants } = await import('@/lib/grant-service');
    await mutateGrants((s) => ({
      state: createGrantInState(s, { granteeWorkspaceId: 'ws-1', granteeTabId: 'tab-o', workspaces: ['ws-2'], reason: 'r', expiresInHours: 1, createdBy: 'human' }, T0, 'g-drv1').state,
      value: null,
    }));
    fs.writeFileSync(ownerGrantsFile(), '{nope');
    reloadGrants();
    await expect(revokeForClosedTab(deps(), { workspaceId: 'ws-1', tabId: 'tab-o' })).rejects.toMatchObject({ code: 'grant-store-unreadable' });
    expect(grantsSnapshot('drive').grants[0]).toMatchObject({ id: 'g-drv1', revokeReason: 'grantee-tab-closed' });
    expect(audit).toHaveBeenCalledWith({ event: 'grant-revoked', grantId: 'g-drv1', reason: 'grantee-tab-closed', by: 'system' });
    await expect(sweepGrants({ now: () => T0 + 2 * H, audit })).rejects.toMatchObject({ code: 'grant-store-unreadable' });
  });

  it('notes an owner grant expiry once and prunes it 7 days after it ended', async () => {
    const { grantsSnapshot, ownerGrantsFile, reloadGrants } = await import('@/lib/grant-store');
    const { sweepGrants } = await import('@/lib/grant-service');
    await writeFile(ownerGrantsFile(), [record()]);
    reloadGrants();
    expect((await sweepGrants({ now: () => T0 + 2 * H, audit })).map((g) => g.id)).toEqual(['g-own1']);
    expect(await sweepGrants({ now: () => T0 + 3 * H, audit })).toEqual([]);
    expect(audit.mock.calls.filter(([e]) => e.event === 'grant-expired')).toHaveLength(1);
    await sweepGrants({ now: () => T0 + H + 7 * DAY + 1, audit });
    expect(grantsSnapshot('owner').grants).toEqual([]);
  });

  it('boot ends an owner grant whose tab closed while the server was down; a close event ends a live one', async () => {
    const { ownerGrantsFile, grantsSnapshot, reloadGrants } = await import('@/lib/grant-store');
    await writeFile(ownerGrantsFile(), [record({ expiresAt: Date.now() + H })]);
    reloadGrants();
    const { startGrants, stopGrants } = await import('@/lib/grant-service');
    await startGrants();
    expect(grantsSnapshot('owner').grants[0]).toMatchObject({ revokeReason: 'grantee-tab-closed' });
    stopGrants();

    await writeFile(ownerGrantsFile(), [record({ id: 'g-own2', expiresAt: Date.now() + H })]);
    reloadGrants();
    lifecycle.live = [{ workspaceId: 'ws-1', tabId: 'tab-o' }];
    await startGrants();
    expect(grantsSnapshot('owner').grants[0].revokedAt).toBeNull();
    lifecycle.listener!({ workspaceId: 'ws-1', tabId: 'tab-o', sessionName: 's', reason: 'layout-removed' } as ITabClosedEvent);
    await vi.waitFor(() => expect(grantsSnapshot('owner').grants[0]).toMatchObject({ revokeReason: 'grantee-tab-closed' }), { timeout: 5000 });
  });

  describe('the boot sweep with one grant file refused (ADR-0029 §1: each file fails alone)', () => {
    const NOW = () => Date.now();
    const drive = (id: string, tabId: string, over: Partial<IGrant> = {}) =>
      record({ id, capability: 'drive', grantee: { workspaceId: 'ws-1', tabId }, workspaces: ['ws-2'], expiresAt: NOW() + H, ...over });

    it('grants.json refused: an expired gone owner record listed first does not stop the active gone owner grant; the expiry sweep runs', async () => {
      const { grantsFile, grantsSnapshot, ownerGrantsFile, reloadGrants } = await import('@/lib/grant-store');
      fs.mkdirSync(path.dirname(grantsFile()), { recursive: true });
      fs.writeFileSync(grantsFile(), '{nope');
      await writeFile(ownerGrantsFile(), [
        record({ id: 'g-ownp', grantee: { workspaceId: 'ws-1', tabId: 'tab-p' }, createdAt: NOW() - 3 * H, expiresAt: NOW() - H }),
        record({ id: 'g-ownl', grantee: { workspaceId: 'ws-1', tabId: 'tab-live' }, createdAt: NOW() - 3 * H, expiresAt: NOW() - 2 * H }),
        record({ id: 'g-ownq', grantee: { workspaceId: 'ws-1', tabId: 'tab-q' }, expiresAt: NOW() + H }),
      ]);
      reloadGrants();
      lifecycle.live = [{ workspaceId: 'ws-1', tabId: 'tab-live' }];
      const { canAccessWorkspace } = await import('@/lib/cli-utils');
      const tabQ = { type: 'workspace', workspaceId: 'ws-1', tabId: 'tab-q', tabVerified: true, tabIdentity: 'launch' } as const;
      expect(await canAccessWorkspace(tabQ, 'ws-3')).toBe(true);
      const { startGrants } = await import('@/lib/grant-service');
      await startGrants();
      const byId = Object.fromEntries(grantsSnapshot('owner').grants.map((g) => [g.id, g]));
      expect(byId['g-ownp']).toMatchObject({ revokeReason: 'grantee-tab-closed' });
      expect(byId['g-ownq']).toMatchObject({ revokeReason: 'grantee-tab-closed' });
      expect(await canAccessWorkspace(tabQ, 'ws-3')).toBe(false);
      // The expiry sweep still ran over the readable file: the live tab's expired grant is noted once.
      expect(byId['g-ownl'].expiryNotedAt).not.toBeNull();
      expect(audit).toHaveBeenCalledWith(expect.objectContaining({ event: 'grant-expired', grantId: 'g-ownl' }));
      expect(fs.readFileSync(grantsFile(), 'utf-8')).toBe('{nope');
    });

    it('owner-grants.json refused: drive grants of two gone grantees are both revoked; the expiry sweep runs', async () => {
      const { grantsFile, grantsSnapshot, ownerGrantsFile, reloadGrants } = await import('@/lib/grant-store');
      await writeFile(grantsFile(), [
        drive('g-drv1', 'tab-g1'),
        drive('g-drv2', 'tab-g2'),
        drive('g-drvl', 'tab-live', { createdAt: NOW() - 3 * H, expiresAt: NOW() - H }),
      ]);
      fs.writeFileSync(ownerGrantsFile(), '{nope');
      reloadGrants();
      lifecycle.live = [{ workspaceId: 'ws-1', tabId: 'tab-live' }];
      const { startGrants } = await import('@/lib/grant-service');
      await startGrants();
      const byId = Object.fromEntries(grantsSnapshot('drive').grants.map((g) => [g.id, g]));
      expect(byId['g-drv1']).toMatchObject({ revokeReason: 'grantee-tab-closed' });
      expect(byId['g-drv2']).toMatchObject({ revokeReason: 'grantee-tab-closed' });
      expect(byId['g-drvl'].expiryNotedAt).not.toBeNull();
      expect(audit).toHaveBeenCalledWith(expect.objectContaining({ event: 'grant-expired', grantId: 'g-drvl' }));
      expect(fs.readFileSync(ownerGrantsFile(), 'utf-8')).toBe('{nope');
    });
  });
});
