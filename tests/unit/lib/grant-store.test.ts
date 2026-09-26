import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createGrantInState,
  findActiveDriveGrant,
  GRANT_KEEP_ENDED_MS,
  grantsFile,
  grantsRefusal,
  grantsSnapshot,
  isGrantError,
  GrantError,
  mutateGrants,
  reloadGrants,
  revokeForTabInState,
  revokeInState,
  sweepInState,
} from '@/lib/grant-store';
import type { IGrantsState } from '@/types/grant';

// ADR-0014 / story 11. The test process's HOME is isolated (tests/setup), so
// grants.json here is a scratch file.

const T0 = Date.parse('2026-09-26T12:00:00Z');
const H = 60 * 60 * 1000;
const EMPTY: IGrantsState = { grants: [] };
const input = { granteeWorkspaceId: 'ws-1', granteeTabId: 'tab-a', workspaces: ['ws-2', 'ws-3'], reason: 'portfolio', expiresInHours: 24, createdBy: 'human' };

describe('grant state (pure)', () => {
  it('finds the active grant for this exact tab over this target only', () => {
    const { state, grant } = createGrantInState(EMPTY, input, T0, 'g-one1');
    expect(findActiveDriveGrant(state, { workspaceId: 'ws-1', tabId: 'tab-a' }, 'ws-2', T0 + 1)).toBe(grant);
    expect(findActiveDriveGrant(state, { workspaceId: 'ws-1', tabId: 'tab-a' }, 'ws-3', T0 + 1)).toBe(grant);
    expect(findActiveDriveGrant(state, { workspaceId: 'ws-1', tabId: 'tab-b' }, 'ws-2', T0 + 1)).toBeNull();
    expect(findActiveDriveGrant(state, { workspaceId: 'ws-9', tabId: 'tab-a' }, 'ws-2', T0 + 1)).toBeNull();
    expect(findActiveDriveGrant(state, { workspaceId: 'ws-1', tabId: 'tab-a' }, 'ws-4', T0 + 1)).toBeNull();
  });

  it('an expired or revoked grant allows nothing', () => {
    const { state, grant } = createGrantInState(EMPTY, input, T0, 'g-one1');
    expect(findActiveDriveGrant(state, grant.grantee, 'ws-2', T0 + 24 * H)).toBeNull();
    const revoked = revokeInState(state, 'g-one1', 'human', 'revoked', T0 + H);
    expect(revoked.grant).toMatchObject({ revokedAt: T0 + H, revokedBy: 'human', revokeReason: 'revoked' });
    expect(findActiveDriveGrant(revoked.state, grant.grantee, 'ws-2', T0 + H + 1)).toBeNull();
    expect(revokeInState(revoked.state, 'g-one1', 'human', 'revoked', T0 + 2 * H)).toEqual({ state: revoked.state, grant: null });
  });

  it('a closed grantee tab ends its active grants only', () => {
    let state = createGrantInState(EMPTY, input, T0, 'g-one1').state;
    state = createGrantInState(state, { ...input, granteeTabId: 'tab-b' }, T0, 'g-two2').state;
    const r = revokeForTabInState(state, { workspaceId: 'ws-1', tabId: 'tab-a' }, T0 + H);
    expect(r.revoked.map((g) => [g.id, g.revokeReason, g.revokedBy])).toEqual([['g-one1', 'grantee-tab-closed', 'system']]);
    expect(findActiveDriveGrant(r.state, { workspaceId: 'ws-1', tabId: 'tab-b' }, 'ws-2', T0 + H)).not.toBeNull();
    expect(revokeForTabInState(r.state, { workspaceId: 'ws-1', tabId: 'tab-a' }, T0 + 2 * H).revoked).toEqual([]);
  });

  it('the expiry boundary is exact: active until expiresAt, not at it', () => {
    const { state, grant } = createGrantInState(EMPTY, input, T0, 'g-one1');
    expect(findActiveDriveGrant(state, grant.grantee, 'ws-2', grant.expiresAt - 1)).not.toBeNull();
    expect(findActiveDriveGrant(state, grant.grantee, 'ws-2', grant.expiresAt)).toBeNull();
  });

  it('an expiry older than the keep window is still noted (audited) before it is pruned', () => {
    const { state } = createGrantInState(EMPTY, { ...input, expiresInHours: 1 }, T0, 'g-one1');
    const late = sweepInState(state, T0 + H + GRANT_KEEP_ENDED_MS + 10);
    expect(late.expired.map((g) => g.id)).toEqual(['g-one1']);
    expect(sweepInState(late.state, T0 + H + GRANT_KEEP_ENDED_MS + 20)).toMatchObject({ state: { grants: [] }, pruned: 1 });
  });

  it('notes an expiry once, and prunes grants ended more than a week ago', () => {
    const { state } = createGrantInState(EMPTY, { ...input, expiresInHours: 1 }, T0, 'g-one1');
    const first = sweepInState(state, T0 + 2 * H);
    expect(first.expired.map((g) => g.id)).toEqual(['g-one1']);
    expect(sweepInState(first.state, T0 + 3 * H).expired).toEqual([]);
    expect(sweepInState(first.state, T0 + H + GRANT_KEEP_ENDED_MS + 1)).toMatchObject({ state: { grants: [] }, pruned: 1 });
  });
});

describe('grants.json (fail closed)', () => {
  beforeEach(() => {
    fs.rmSync(grantsFile(), { force: true });
    reloadGrants();
  });
  afterEach(() => {
    fs.rmSync(grantsFile(), { force: true });
    reloadGrants();
  });

  it('absent: no grants, writes allowed; a write lands 0600 and refreshes the cache', async () => {
    expect(grantsSnapshot()).toEqual({ grants: [] });
    await mutateGrants((s) => ({ state: createGrantInState(s, input, T0, 'g-one1').state, value: null }));
    expect(grantsSnapshot().grants.map((g) => g.id)).toEqual(['g-one1']);
    expect(fs.statSync(grantsFile()).mode & 0o777).toBe(0o600);
    reloadGrants();
    expect(grantsSnapshot().grants.map((g) => g.id)).toEqual(['g-one1']);
  });

  it.each([
    ['not JSON', '{nope'],
    ['a grant missing its grantee', JSON.stringify({ grants: [{ id: 'g-x1234', capability: 'drive' }] })],
    ['not { grants }', JSON.stringify([])],
  ])('malformed (%s): NO grant is honoured and no write happens', async (_label, content) => {
    fs.mkdirSync(path.dirname(grantsFile()), { recursive: true });
    fs.writeFileSync(grantsFile(), content);
    reloadGrants();
    expect(grantsSnapshot()).toEqual({ grants: [] });
    expect(grantsRefusal()).toMatch(/malformed/);
    const err = await mutateGrants((s) => ({ state: createGrantInState(s, input, T0, 'g-one1').state, value: null })).catch((e) => e);
    expect(isGrantError(err) && err.code).toBe('grant-store-unreadable');
    expect(fs.readFileSync(grantsFile(), 'utf-8')).toBe(content);
  });

  it('recognises a GrantError from another module copy by its name and code', () => {
    const foreign = Object.assign(new Error('x'), { name: 'GrantError', code: 'grant-locked' });
    expect(isGrantError(foreign)).toBe(true);
    expect(isGrantError(Object.assign(new Error('x'), { name: 'GrantError', code: 'made-up' }))).toBe(false);
    expect(isGrantError(new GrantError('grant-invalid', 'y'))).toBe(true);
  });
});
