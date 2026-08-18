import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/config-store', () => ({
  getDangerouslySkipPermissions: vi.fn(async () => false),
}));
vi.mock('@/lib/hook-settings', () => ({
  HOOK_SETTINGS_PATH: '/home/u/.purplemux/hooks.json',
}));
vi.mock('@/lib/claude-prompt', () => ({
  getClaudePromptPath: (wsId: string) => `/home/u/.purplemux/workspaces/${wsId}/claude-prompt.md`,
}));

import { buildClaudeFlags, isValidClaudeEffort, CLAUDE_EFFORT_LEVELS } from '@/lib/claude-command';

describe('isValidClaudeEffort', () => {
  it('accepts exactly the claude effort vocabulary', () => {
    for (const level of CLAUDE_EFFORT_LEVELS) expect(isValidClaudeEffort(level)).toBe(true);
    for (const bad of ['minimal', 'xtra-high', 'XHIGH', '', 42, null, undefined]) {
      expect(isValidClaudeEffort(bad)).toBe(false);
    }
  });
});

describe('buildClaudeFlags effort', () => {
  it('appends --effort for a valid level', async () => {
    const flags = await buildClaudeFlags('ws-1', { model: 'claude-opus-5', effort: 'high' });
    expect(flags).toContain('--model claude-opus-5');
    expect(flags).toContain('--effort high');
  });

  it('omits --effort when absent or invalid — the session then inherits the global default', async () => {
    expect(await buildClaudeFlags('ws-1', { model: 'claude-opus-5' })).not.toContain('--effort');
    expect(await buildClaudeFlags('ws-1', { effort: 'minimal' })).not.toContain('--effort');
  });
});
