import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ICaller } from '@/lib/caller';

// ADR-0038: the curator's fleet keys are checked at write time and written by the admin token only.

let directory = '';
let home: ReturnType<typeof vi.spyOn>;
const admin: ICaller = { scope: { type: 'admin' } as ICaller['scope'], workspaceId: null, tabId: null, tabName: null, verified: false, identity: 'none', admin: true };
const orchestrator: ICaller = {
  scope: { type: 'workspace', workspaceId: 'ws-a' } as ICaller['scope'], workspaceId: 'ws-a', tabId: 'tab-o', tabName: 'o', verified: true, identity: 'launch', admin: false,
};
const authority = { isWorkspaceOrchestrator: vi.fn(async () => true), now: () => 1 };

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-curator-keys-'));
  home = vi.spyOn(os, 'homedir').mockReturnValue(directory);
  delete (globalThis as Record<string, unknown>).__ptFleetConfigLock;
});

afterEach(() => {
  home.mockRestore();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('curator fleet keys', () => {
  it.each([
    ['curator.routing.workspaces', 'ws-L7eUOX,ws-o9gb_Q'],
    ['curator.min-interval-ms', '10000'],
    ['curator.enabled', 'off'],
  ])('the admin token sets %s = %j', async (key, value) => {
    const { putValue } = await import('@/lib/fleet-config-http');
    expect(await putValue(admin, key, { value }, authority)).toMatchObject({ key, changed: true });
  });

  it.each([
    ['curator.routing.workspaces', 'treasury-v2', 'takes workspace ids (ws-...), comma-separated: treasury-v2'],
    ['curator.min-interval-ms', '-1', 'must be whole milliseconds 0..600000, got "-1"'],
    ['curator.min-interval-ms', '700000', 'must be whole milliseconds 0..600000'],
    ['curator.enabled', 'yes', 'must be on or off, got "yes"'],
    ['curator.model', 'qwen', 'is not a curator key'],
  ])('%s = %j is refused: %s', async (key, value, message) => {
    const { putValue } = await import('@/lib/fleet-config-http');
    await expect(putValue(admin, key, { value }, authority)).rejects.toMatchObject({ code: 'config-invalid', message: expect.stringContaining(message) });
  });

  it("a workspace orchestrator cannot opt a workspace into routing", async () => {
    const { putValue } = await import('@/lib/fleet-config-http');
    await expect(putValue(orchestrator, 'curator.routing.workspaces', { value: 'ws-a' }, authority)).rejects.toMatchObject({ code: 'forbidden' });
  });
});
