import { describe, expect, it } from 'vitest';
import {
  GROK_EFFORT_LEVELS,
  isValidCodexEffort,
  isValidGrokEffort,
  isValidReasoningForPanelType,
  reasoningErrorForPanelType,
} from '@/lib/agent-effort';

describe('grok effort vocabulary', () => {
  it('accepts every grok --effort level including xhigh', () => {
    for (const level of GROK_EFFORT_LEVELS) expect(isValidGrokEffort(level)).toBe(true);
  });

  it('rejects Codex-only mistakes and junk', () => {
    expect(isValidGrokEffort('ultra')).toBe(false);
    expect(isValidGrokEffort('')).toBe(false);
    expect(isValidCodexEffort('xhigh')).toBe(false);
  });

  it('validates -r against the engine the tab will launch', () => {
    expect(isValidReasoningForPanelType('grok-cli', 'xhigh')).toBe(true);
    expect(isValidReasoningForPanelType('codex-cli', 'xhigh')).toBe(false);
    expect(isValidReasoningForPanelType('claude-code', 'xhigh')).toBe(true);
    expect(isValidReasoningForPanelType('grok-cli', 'none')).toBe(true);
    expect(isValidReasoningForPanelType('claude-code', 'none')).toBe(false);
    expect(reasoningErrorForPanelType('grok-cli')).toMatch(/grok-cli/);
  });
});
