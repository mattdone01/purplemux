import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ICaller } from '@/lib/caller';
import type { IScrumMasterSnapshot } from '@/lib/scrum-master-access';

// ADR-0047 amendment (ticket PMUX-PSM-TIMEOUT-RIGHT): the Portfolio Scrum Master's verified tab writes a known host's
// ssh budget, remote.timeout-ms.<host>, with a reason and the version it read, in the bounds every writer obeys
// (5000..120000 whole ms). The fleet-wide remote.timeout-ms stays admin-only. Every other tab is refused; the admin
// token is unchanged. The host names here are examples only.

let directory = '';
let home: ReturnType<typeof vi.spyOn>;

const tabCaller = (workspaceId: string, tabId: string, verified = true): ICaller => ({
  scope: { type: 'workspace', workspaceId, tabId, ...(verified ? { tabVerified: true } : {}) } as ICaller['scope'],
  workspaceId, tabId, tabName: tabId, verified, identity: verified ? 'launch' : 'session', admin: false,
});
const admin: ICaller = { scope: { type: 'admin' } as ICaller['scope'], workspaceId: null, tabId: null, tabName: null, verified: false, identity: 'none', admin: true };
const sm = tabCaller('ws-pm', 'tab-sm');

let current: IScrumMasterSnapshot | null;
const authority = () => ({
  isWorkspaceOrchestrator: vi.fn(async (_ws: string, tabId: string) => tabId === 'tab-o' || tabId === 'tab-sm'),
  now: () => 5,
  scrumMaster: vi.fn(async (caller: ICaller) => (current && caller.verified && caller.workspaceId === current.selection.managerWorkspaceId
    && caller.tabId === current.selection.managerTabId ? current : null)),
  currentSelection: () => current,
});

const auditLines = (): Record<string, unknown>[] => {
  const file = path.join(directory, '.purplemux', 'audit', 'coordination.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
};

const KEY = 'remote.timeout-ms.host-b';
const write = (caller: ICaller, value: string, over: Record<string, unknown> = {}, key = KEY) => async () => {
  const { putValue } = await import('@/lib/fleet-config-http');
  return putValue(caller, key, { value, reason: 'tmux calls on host-b pass 5 s under load', expectedVersion: 0, ...over }, authority());
};

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-psm-timeout-'));
  home = vi.spyOn(os, 'homedir').mockReturnValue(directory);
  delete (globalThis as Record<string, unknown>).__ptFleetConfigLock;
  current = { actor: 'owner', updatedAt: 1000, selection: { managerWorkspaceId: 'ws-pm', managerTabId: 'tab-sm', workspaceIds: ['ws-a'] } };
  const { putValue } = await import('@/lib/fleet-config-http');
  await putValue(admin, 'remote.hosts', { value: 'host-b,host-c' }, authority());
});

afterEach(() => {
  home.mockRestore();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('the Portfolio Scrum Master writes a known host\'s remote.timeout-ms (ADR-0047 amendment)', () => {
  it('accepts a value in bounds: written with its role, audited with the reason and the selection, read by the host budget', async () => {
    const got = await write(sm, '15000')();
    expect(got).toMatchObject({ key: KEY, version: 1, changed: true, value: { value: '15000', setBy: { role: 'portfolio-scrum-master' } } });
    expect(auditLines().at(-1)).toMatchObject({
      event: 'fleet-config-set', key: KEY, newValue: '15000', reason: 'tmux calls on host-b pass 5 s under load',
      by: expect.objectContaining({ workspaceId: 'ws-pm', tabId: 'tab-sm', role: 'portfolio-scrum-master' }),
      selection: { actor: 'owner', updatedAt: 1000, managerWorkspaceId: 'ws-pm', managerTabId: 'tab-sm' },
    });
    const { readFleetConfig } = await import('@/lib/fleet-config-store');
    const { remoteTimeoutMsIn } = await import('@/lib/remote-timeouts');
    const state = await readFleetConfig();
    expect(remoteTimeoutMsIn(state, 'host-b')).toBe(15000);
    expect(remoteTimeoutMsIn(state, 'host-c')).toBe(5000);
  });

  it.each(['5000', '120000'])('accepts the bound %s', async (value) => {
    expect(await write(sm, value)()).toMatchObject({ version: 1, changed: true });
  });

  it.each([
    ['under the floor', '4999'],
    ['over the maximum', '120001'],
    ['a fraction', '15000.5'],
    ['a unit', '15s'],
    ['a negative number', '-15000'],
    ['an empty value', ' '],
  ])('refuses a value %s (%j) as config-invalid, audited with its role', async (_label, value) => {
    await expect(write(sm, value)()).rejects.toMatchObject({ code: 'config-invalid' });
    expect(auditLines().at(-1)).toMatchObject({ event: 'fleet-config-refused', key: KEY, by: { role: 'portfolio-scrum-master' } });
    const { readFleetConfig, valueOf } = await import('@/lib/fleet-config-store');
    expect(valueOf(await readFleetConfig(), KEY)).toBeNull();
  });

  it('refuses a host the pool does not know, audited as unknown-host', async () => {
    await expect(write(sm, '15000', {}, 'remote.timeout-ms.host-z')()).rejects.toMatchObject({
      code: 'config-invalid', message: expect.stringContaining('host-z, which is not on remote.hosts (host-b, host-c)'),
    });
    expect(auditLines().at(-1)).toMatchObject({ refusal: 'unknown-host', by: { role: 'portfolio-scrum-master' } });
  });

  it('refuses a write with no reason, and one with no version or a stale version', async () => {
    await expect(write(sm, '15000', { reason: undefined })()).rejects.toMatchObject({ code: 'config-invalid', message: expect.stringContaining('needs a reason') });
    expect(auditLines().at(-1)).toMatchObject({ refusal: 'reason-missing' });
    await expect(write(sm, '15000', { reason: '   ' })()).rejects.toMatchObject({ code: 'config-invalid' });
    await expect(write(sm, '15000', { expectedVersion: undefined })()).rejects.toMatchObject({ message: expect.stringContaining('needs the version it read') });
    await write(admin, '20000', { reason: undefined, expectedVersion: undefined })();
    await expect(write(sm, '15000', { expectedVersion: 0 })()).rejects.toMatchObject({ code: 'config-version-conflict' });
    expect(auditLines().at(-1)).toMatchObject({ refusal: 'version-conflict' });
    expect(await write(sm, '15000', { expectedVersion: 1 })()).toMatchObject({ version: 2 });
  });

  it('refuses when the selection changes between the proof and the lock: nothing is written', async () => {
    const { putValue } = await import('@/lib/fleet-config-http');
    const auth = authority();
    auth.scrumMaster.mockImplementationOnce(async () => {
      const proof = current;
      current = { ...current!, updatedAt: 2000 };
      return proof;
    });
    await expect(putValue(sm, KEY, { value: '15000', reason: 'r', expectedVersion: 0 }, auth)).rejects.toMatchObject({ code: 'forbidden' });
    expect(auditLines().at(-1)).toMatchObject({ refusal: 'selection-changed' });
  });

  it.each([
    ['an orchestrator tab', tabCaller('ws-a', 'tab-o')],
    ['a worker tab', tabCaller('ws-a', 'tab-w')],
    ['the Scrum Master\'s tab unverified', tabCaller('ws-pm', 'tab-sm', false)],
  ])('refuses %s', async (_label, caller) => {
    await expect(write(caller, '15000')()).rejects.toMatchObject({ code: 'forbidden' });
    const { readFleetConfig, valueOf } = await import('@/lib/fleet-config-store');
    expect(valueOf(await readFleetConfig(), KEY)).toBeNull();
  });

  it('keeps the fleet-wide remote.timeout-ms admin-only: the Scrum Master is refused', async () => {
    await expect(write(sm, '15000', {}, 'remote.timeout-ms')()).rejects.toMatchObject({ code: 'forbidden', message: expect.stringContaining('admin token only') });
    expect(auditLines().at(-1)).toMatchObject({ refusal: 'admin-only' });
  });

  it('the admin token still writes any host and the fleet key, with no reason or version, in the same bounds', async () => {
    expect(await write(admin, '30000', { reason: undefined, expectedVersion: undefined }, 'remote.timeout-ms.host-z')()).toMatchObject({ version: 1 });
    expect(await write(admin, '10000', { reason: undefined, expectedVersion: undefined }, 'remote.timeout-ms')()).toMatchObject({ version: 1 });
    await expect(write(admin, '4999', { reason: undefined, expectedVersion: undefined })()).rejects.toMatchObject({ code: 'config-invalid' });
  });
});

describe('the Scrum Master key forms', () => {
  it('names remote.timeout-ms.<host> and keeps the fleet key out', async () => {
    const { SCRUM_MASTER_KEY_FORMS, scrumMasterKey } = await import('@/lib/fleet-config-http');
    expect(scrumMasterKey('remote.timeout-ms.host-b')).toEqual({ workspaceId: null });
    expect(scrumMasterKey('remote.timeout-ms')).toBeNull();
    expect(scrumMasterKey('remote.timeout-ms.')).toBeNull();
    expect(SCRUM_MASTER_KEY_FORMS).toContain('remote.timeout-ms.<host> (a host on remote.hosts, whole ms 5000..120000)');
  });
});
