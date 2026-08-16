import { describe, expect, it } from 'vitest';
import { getProvider, getProviderByPanelType, getProviderByProcessName } from '@/lib/providers';
import { grokProvider } from '@/lib/providers/grok';
import { extractGrokCwd, extractGrokSessionId, isValidGrokSessionId } from '@/lib/providers/grok/session-detection';
import {
  AGENT_PANEL_TYPES,
  agentDisplayName,
  isAgentPanelType,
  panelTypeForProviderId,
  processMatchesPanelType,
  providerIdForPanelType,
  toSessionHistoryProvider,
} from '@/lib/agent-panel-types';
import { buildGrokHookConfig } from '@/lib/providers/grok/hook-config';
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

  it('recognises the second name the installer links the binary under', () => {
    expect(grokProvider.matchesProcess('agent')).toBe(true);
  });

  it('recognises the absolute path the launcher spawns', () => {
    expect(grokProvider.matchesProcess('sh', ['/home/dev/.grok/bin/grok', '--cwd', '/repo'])).toBe(true);
  });
});

const SESSION_ID = '01a008c1-bb96-71d1-9769-b63ff478fd9f';

describe('grok session ids', () => {
  it('accepts the UUIDv7 grok mints and the client-supplied UUIDs it also allows', () => {
    expect(isValidGrokSessionId(SESSION_ID)).toBe(true);
    expect(isValidGrokSessionId('12345678-AAAA-BBBB-CCCC-1234567890AB')).toBe(true);
    expect(isValidGrokSessionId('a1b2c3d4e5f6')).toBe(false);
    expect(isValidGrokSessionId(null)).toBe(false);
  });

  it('reads --session-id and --resume off the process args', () => {
    expect(extractGrokSessionId(`grok --cwd /repo --session-id ${SESSION_ID}`)).toBe(SESSION_ID);
    expect(extractGrokSessionId(`grok -s '${SESSION_ID}'`)).toBe(SESSION_ID);
    expect(extractGrokSessionId(`grok --resume=${SESSION_ID}`)).toBe(SESSION_ID);
    expect(extractGrokSessionId(`grok -r ${SESSION_ID}`)).toBe(SESSION_ID);
    expect(extractGrokSessionId('grok --cwd /repo')).toBeNull();
  });

  it('ignores a --resume that names a title rather than an id', () => {
    expect(extractGrokSessionId('grok --resume "fix the parser"')).toBeNull();
  });

  it('reads the working directory the pane was launched against', () => {
    expect(extractGrokCwd('grok --cwd /repo/app')).toBe('/repo/app');
    expect(extractGrokCwd('grok --cwd=/repo/app')).toBe('/repo/app');
    expect(extractGrokCwd('grok')).toBeNull();
  });

  it('refuses to build a resume command for a malformed id', () => {
    expect(() => grokProvider.buildResumeCommand('not-a-session', {})).toThrow(/Invalid grok session ID/);
  });
});

describe('grok tab agent state', () => {
  it('reads and writes only its own provider slot', () => {
    const tab = { id: 't1', sessionName: 's', name: 'n', order: 0 } as ITab;
    grokProvider.writeSessionId(tab, SESSION_ID);
    grokProvider.writeSummary(tab, 'add the provider');

    expect(tab.agentState).toEqual({
      providerId: 'grok',
      sessionId: SESSION_ID,
      jsonlPath: null,
      summary: 'add the provider',
    });
    expect(grokProvider.readSessionId(tab)).toBe(SESSION_ID);

    tab.agentState = { providerId: 'codex', sessionId: 'other', jsonlPath: null, summary: null };
    expect(grokProvider.readSessionId(tab)).toBeNull();
  });

  it('reads the session id back out of the transcript path', () => {
    const tab = { id: 't1', sessionName: 's', name: 'n', order: 0 } as ITab;
    const jsonlPath = `/home/dev/.grok/sessions/%2Frepo/${SESSION_ID}/updates.jsonl`;
    grokProvider.writeJsonlPath(tab, jsonlPath);

    expect(grokProvider.readJsonlPath(tab)).toBe(jsonlPath);
    expect(grokProvider.sessionIdFromJsonlPath(jsonlPath)).toBe(SESSION_ID);
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

  it('recognises the process names an agent can actually present as', () => {
    expect(processMatchesPanelType('grok-cli', 'grok')).toBe(true);
    // The installer links the same binary as `agent` too.
    expect(processMatchesPanelType('grok-cli', 'agent')).toBe(true);
    expect(processMatchesPanelType('codex-cli', 'codex')).toBe(true);
    expect(processMatchesPanelType('codex-cli', 'Node')).toBe(true);
    expect(processMatchesPanelType('claude-code', 'claude')).toBe(true);
  });

  it('does not match another agent\'s process, a shell, or a missing one', () => {
    expect(processMatchesPanelType('grok-cli', 'claude')).toBe(false);
    expect(processMatchesPanelType('claude-code', 'agent')).toBe(false);
    expect(processMatchesPanelType('grok-cli', 'zsh')).toBe(false);
    expect(processMatchesPanelType('grok-cli', undefined)).toBe(false);
    expect(processMatchesPanelType('terminal', 'grok')).toBe(false);
    expect(processMatchesPanelType(undefined, 'grok')).toBe(false);
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
    expect(Object.keys(buildGrokHookConfig('/tmp/hook.sh').hooks).sort()).toEqual([
      'Notification',
      'PostCompact',
      'PostToolUse',
      'PreCompact',
      'SessionEnd',
      'SessionStart',
      'Stop',
      'StopCancelled',
      'StopFailure',
      'UserPromptSubmit',
    ]);
  });
});
