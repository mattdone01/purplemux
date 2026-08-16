import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { runtimeHandleFor, runtimeProviderId } from '@/lib/agent-runtime-handle';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const JSONL = '/home/me/.claude/projects/p/s.jsonl';

describe('runtimeHandleFor', () => {
  it('hands a file-backed provider its transcript path', () => {
    expect(runtimeHandleFor('claude', { jsonlPath: JSONL, sessionId: 'sid' })).toBe(JSONL);
    expect(runtimeHandleFor('codex', { jsonlPath: JSONL, sessionId: 'sid' })).toBe(JSONL);
  });

  it('hands grok its transcript path too — Grok Build writes ACP JSONL', () => {
    const updates = '/home/me/.grok/sessions/%2Frepo/01a008c1-bb96-71d1-9769-b63ff478fd9f/updates.jsonl';
    expect(runtimeHandleFor('grok', { jsonlPath: updates, sessionId: 'grok-session' })).toBe(updates);
  });

  it('has no handle when the transcript has not been resolved yet', () => {
    expect(runtimeHandleFor('grok', { jsonlPath: null, sessionId: 'grok-session' })).toBeNull();
    expect(runtimeHandleFor('claude', { jsonlPath: null, sessionId: 'sid' })).toBeNull();
    expect(runtimeHandleFor(null, {})).toBeNull();
  });
});

describe('runtimeProviderId', () => {
  it('prefers the recorded provider and falls back to the panel type', () => {
    expect(runtimeProviderId('grok', 'terminal')).toBe('grok');
    expect(runtimeProviderId(null, 'grok-cli')).toBe('grok');
    expect(runtimeProviderId(undefined, 'codex-cli')).toBe('codex');
    expect(runtimeProviderId(null, 'terminal')).toBeNull();
  });
});

/**
 * F7: story 19 threaded the grok handle through four call sites and missed
 * `readTabMetadata`, so a grok tab that lost its hook events showed a blank
 * currentAction forever. One rule, asked by every caller.
 */
describe('status-manager reads its runtime handle through the shared rule', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src/lib/status-manager.ts'), 'utf-8');

  it('derives readTabMetadata\'s persisted handle from runtimeHandleFor', () => {
    const body = source.slice(
      source.indexOf('private async readTabMetadata'),
      source.indexOf('private async detectTerminalStatus'),
    );

    expect(body).toContain('runtimeHandleFor');
  });

  it('sizes a new agent pane by the agent panel-type table, not a hardcoded pair', () => {
    const pane = fs.readFileSync(path.join(ROOT, 'src/components/features/workspace/pane-container.tsx'), 'utf-8');

    expect(pane).toContain('const isAgentTab = isAgentPanelType(tab.panelType);');
    expect(pane).not.toMatch(/panelType === 'claude-code' \|\| tab\.panelType === 'codex-cli'/);
  });

  it('keeps the polling path on the same rule', () => {
    expect(source).toContain("from '@/lib/agent-runtime-handle'");
    expect(source).not.toMatch(/entry\.agentProviderId === GROK_PROVIDER_ID \|\| entry\.panelType === 'grok-cli'/);
  });
});
