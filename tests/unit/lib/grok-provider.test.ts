import { describe, expect, it } from 'vitest';
import { getProvider, getProviderByPanelType, getProviderByProcessName } from '@/lib/providers';
import { grokProvider } from '@/lib/providers/grok';
import { extractGrokSessionId, isValidGrokSessionId } from '@/lib/providers/grok/session-detection';
import {
  AGENT_PANEL_TYPES,
  agentDisplayName,
  isAgentPanelType,
  panelTypeForProviderId,
  providerIdForPanelType,
  toSessionHistoryProvider,
} from '@/lib/agent-panel-types';
import { GROK_HOOK_EVENTS } from '@/lib/providers/grok/hook-config';
import type { ITab } from '@/types/terminal';

describe('grok provider registration', () => {
  it('is registered under its id, panel type and process name', () => {
    expect(getProvider('grok')).toBe(grokProvider);
    expect(getProviderByPanelType('grok-cli')).toBe(grokProvider);
    expect(getProviderByProcessName('grok')).toBe(grokProvider);
    expect(grokProvider.displayName).toBe('Grok');
  });

  it('does not claim another agents process', () => {
    expect(grokProvider.matchesProcess('codex')).toBe(false);
    expect(grokProvider.matchesProcess('claude')).toBe(false);
  });

  it('recognises the argv form the installer produces', () => {
    expect(grokProvider.matchesProcess('bun', ['/home/dev/.grok/bin/grok', '-d', '/repo'])).toBe(true);
  });
});

describe('grok session ids', () => {
  it('accepts grok-cli 1.1.7 ids — a uuid stripped of dashes, first 12 chars', () => {
    expect(isValidGrokSessionId('a1b2c3d4e5f6')).toBe(true);
    expect(isValidGrokSessionId('A1B2C3D4E5F6')).toBe(false);
    expect(isValidGrokSessionId('a1b2c3d4e5f')).toBe(false);
    expect(isValidGrokSessionId('12345678-aaaa-bbbb-cccc-1234567890ab')).toBe(false);
    expect(isValidGrokSessionId(null)).toBe(false);
  });

  it('reads --session and -s off the process args', () => {
    expect(extractGrokSessionId('grok -d /repo --session a1b2c3d4e5f6')).toBe('a1b2c3d4e5f6');
    expect(extractGrokSessionId("grok -s 'a1b2c3d4e5f6'")).toBe('a1b2c3d4e5f6');
    expect(extractGrokSessionId('grok --session=a1b2c3d4e5f6')).toBe('a1b2c3d4e5f6');
    expect(extractGrokSessionId('grok -d /repo')).toBeNull();
  });

  it('treats --session latest as no explicit id', () => {
    expect(extractGrokSessionId('grok --session latest')).toBeNull();
  });

  it('refuses to build a resume command for a malformed id', () => {
    expect(() => grokProvider.buildResumeCommand('not-a-session', {})).toThrow(/Invalid grok session ID/);
  });
});

describe('grok tab agent state', () => {
  it('reads and writes only its own provider slot', () => {
    const tab = { id: 't1', sessionName: 's', name: 'n', order: 0 } as ITab;
    grokProvider.writeSessionId(tab, 'a1b2c3d4e5f6');
    grokProvider.writeSummary(tab, 'add the provider');

    expect(tab.agentState).toEqual({
      providerId: 'grok',
      sessionId: 'a1b2c3d4e5f6',
      jsonlPath: null,
      summary: 'add the provider',
    });
    expect(grokProvider.readSessionId(tab)).toBe('a1b2c3d4e5f6');

    tab.agentState = { providerId: 'codex', sessionId: 'other', jsonlPath: null, summary: null };
    expect(grokProvider.readSessionId(tab)).toBeNull();
  });

  it('never reports a transcript path — grok stores its transcript in SQLite', () => {
    const tab = { id: 't1', sessionName: 's', name: 'n', order: 0 } as ITab;
    grokProvider.writeJsonlPath(tab, '/tmp/anything.jsonl');
    expect(grokProvider.sessionIdFromJsonlPath('/tmp/a1b2c3d4e5f6.jsonl')).toBeNull();
    expect(grokProvider.parsePaneTitle('✳ working')).toBeNull();
  });
});

describe('agent panel type table', () => {
  it('carries all three agents and maps both directions', () => {
    expect(AGENT_PANEL_TYPES).toEqual(['claude-code', 'codex-cli', 'grok-cli']);
    for (const panelType of AGENT_PANEL_TYPES) {
      const providerId = providerIdForPanelType(panelType);
      expect(providerId).toBeDefined();
      expect(panelTypeForProviderId(providerId)).toBe(panelType);
    }
    expect(providerIdForPanelType('grok-cli')).toBe('grok');
    expect(agentDisplayName('grok-cli')).toBe('Grok');
  });

  it('leaves non-agent panels out', () => {
    expect(isAgentPanelType('terminal')).toBe(false);
    expect(isAgentPanelType('diff')).toBe(false);
    expect(providerIdForPanelType('web-browser')).toBeUndefined();
    expect(panelTypeForProviderId('nope')).toBeUndefined();
  });

  it('narrows grok for session history and alerts', () => {
    expect(toSessionHistoryProvider('grok')).toBe('grok');
    expect(toSessionHistoryProvider('codex')).toBe('codex');
    expect(toSessionHistoryProvider(undefined)).toBe('claude');
    expect(toSessionHistoryProvider('something-else')).toBe('claude');
  });
});

describe('grok hook event set', () => {
  it('covers every event the work-state machine needs plus tool activity', () => {
    expect([...GROK_HOOK_EVENTS].sort()).toEqual([
      'Notification',
      'PostCompact',
      'PostToolUse',
      'PreCompact',
      'SessionEnd',
      'SessionStart',
      'Stop',
      'StopFailure',
      'UserPromptSubmit',
    ]);
  });
});
