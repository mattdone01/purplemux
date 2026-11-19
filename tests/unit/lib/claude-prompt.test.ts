import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ dir: '' }));
vi.mock('@/lib/layout-store', () => ({ resolveLayoutDir: () => state.dir }));

import { getClaudePromptPath, writeClaudePromptFile } from '@/lib/claude-prompt';
import type { IWorkspace } from '@/types/terminal';

const workspace = { id: 'ws-prompt', name: 'prompt', directories: ['/srv/prompt'] } as unknown as IWorkspace;

beforeEach(async () => {
  state.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-prompt-'));
});
afterEach(async () => {
  await fs.rm(state.dir, { recursive: true, force: true });
});

const written = async (): Promise<string> => {
  await writeClaudePromptFile(workspace);
  return fs.readFile(getClaudePromptPath(workspace.id), 'utf8');
};

describe('the workspace prompt (story 15, AC 2)', () => {
  it('tells a tab once how to wait, and never to poll', async () => {
    const body = await written();
    expect(body).not.toMatch(/\bpoll\b/i);
    expect(body.match(/not a shell poller/g)).toHaveLength(1);
  });

  it('lists grok-cli among the tab types it creates and the tmux tabs', async () => {
    const body = await written();
    expect(body).toContain('claude-code | codex-cli | grok-cli | agent-sessions');
    expect(body).toContain('`terminal` / `claude-code` / `codex-cli` / `grok-cli` tabs');
  });

  it('seat-prompt-address-line: holds the tab address line exactly once, after the tab send line (ADR-0050)', async () => {
    const body = await written();
    const line = 'purplemux tab address -w WS TAB_ID   # a Claude seat\'s SendMessage address; on any refusal or failed send use tab send (it queues); never message a socket you did not get here';
    expect(body.split(line)).toHaveLength(2);
    expect(body.indexOf(line)).toBeGreaterThan(body.indexOf('purplemux tab send -w'));
  });

  it('says once that only a lead looks up another workspace\'s lead, and that every other seat uses a note (ADR-0050)', async () => {
    const body = await written();
    expect(body.match(/A lead may look up another workspace's lead with `purplemux tab address`; any other seat uses a note across workspaces\./g)).toHaveLength(1);
  });
});
