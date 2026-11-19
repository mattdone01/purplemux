import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ICaller } from '@/lib/caller';

// ADR-0050: the delivery switches are fleet-wide, so the admin token alone writes them (ADR-0027 ruling R2), and each
// is on or off; unset reads on.

let directory = '';
let home: ReturnType<typeof vi.spyOn>;
const admin: ICaller = { scope: { type: 'admin' } as ICaller['scope'], workspaceId: null, tabId: null, tabName: null, verified: false, identity: 'none', admin: true };
const orchestrator: ICaller = {
  scope: { type: 'workspace', workspaceId: 'ws-a' } as ICaller['scope'], workspaceId: 'ws-a', tabId: 'tab-o', tabName: 'o', verified: true, identity: 'launch', admin: false,
};
const authority = { isWorkspaceOrchestrator: vi.fn(async () => true), now: () => 1 };

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-delivery-keys-'));
  home = vi.spyOn(os, 'homedir').mockReturnValue(directory);
  delete (globalThis as Record<string, unknown>).__ptFleetConfigLock;
});

afterEach(() => {
  home.mockRestore();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('delivery switches (ADR-0050)', () => {
  it('tab-send.queue reads on when unset, off once the admin token sets it off, and on again', async () => {
    const { putValue } = await import('@/lib/fleet-config-http');
    const { messageQueueOn } = await import('@/lib/delivery-switches');
    expect(await messageQueueOn()).toBe(true);
    await putValue(admin, 'tab-send.queue', { value: 'off' }, authority);
    expect(await messageQueueOn()).toBe(false);
    await putValue(admin, 'tab-send.queue', { value: 'on' }, authority);
    expect(await messageQueueOn()).toBe(true);
  });

  it('an unreadable store reads tab-send.queue on', async () => {
    fs.mkdirSync(path.join(directory, '.purplemux'), { recursive: true });
    fs.writeFileSync(path.join(directory, '.purplemux', 'fleet-config.json'), '{not json');
    const { messageQueueOn } = await import('@/lib/delivery-switches');
    expect(await messageQueueOn()).toBe(true);
  });

  it.each([
    ['tab-send.queue', 'yes', 'must be on or off'],
    ['tab-send.other', 'on', 'is not a key'],
  ])('%s = %j is refused: %s', async (key, value, message) => {
    const { putValue } = await import('@/lib/fleet-config-http');
    await expect(putValue(admin, key, { value }, authority)).rejects.toMatchObject({ code: 'config-invalid', message: expect.stringContaining(message) });
  });

  it('a workspace orchestrator cannot set a fleet-wide delivery switch', async () => {
    const { putValue } = await import('@/lib/fleet-config-http');
    await expect(putValue(orchestrator, 'tab-send.queue', { value: 'off' }, authority)).rejects.toMatchObject({ code: 'forbidden' });
  });
});
