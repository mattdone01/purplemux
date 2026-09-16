import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isCodexLaunchTarget,
  prepareCodexBrowserLaunch,
  submitCodexBrowserLaunch,
  type ICodexBrowserLaunchIntent,
} from '@/lib/codex-browser-launch';

const intent: ICodexBrowserLaunchIntent = {
  command: 'node launcher.js --generation gen-1 --tab-id tab-1',
  generation: 'gen-1',
  workspaceId: 'ws-1',
  tabId: 'tab-1',
  sessionName: 'pmux-ws-1-pane-1-tab-1',
  resumeSessionId: 'session-b',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('prepareCodexBrowserLaunch', () => {
  it('retains the complete server-issued launch identity', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => intent,
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(prepareCodexBrowserLaunch({
      workspaceId: 'ws-1',
      tabId: 'tab-1',
      resumeSessionId: 'session-b',
    })).resolves.toEqual(intent);
    expect(fetchMock).toHaveBeenCalledWith('/api/codex/launch-command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'ws-1', tabId: 'tab-1', resumeSessionId: 'session-b' }),
    });
  });

  it('rejects a response that could redirect the requested tab or session intent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ...intent, tabId: 'tab-2' }),
    }));

    await expect(prepareCodexBrowserLaunch({
      workspaceId: 'ws-1',
      tabId: 'tab-1',
      resumeSessionId: 'session-b',
    })).rejects.toThrow('Invalid Codex launch intent response');
  });
});

describe('submitCodexBrowserLaunch', () => {
  it('submits only the immutable server identity and never the browser-held command', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ generation: 'gen-1', phase: 'submitted' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(submitCodexBrowserLaunch(intent)).resolves.toEqual({
      generation: 'gen-1',
      phase: 'submitted',
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/codex/launch-submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'ws-1', tabId: 'tab-1', generation: 'gen-1' }),
    });
    expect(fetchMock.mock.calls[0][1].body).not.toContain(intent.command);
  });

  it('rejects responses that do not acknowledge the submitted generation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ generation: 'gen-2', phase: 'submitted' }),
    }));

    await expect(submitCodexBrowserLaunch(intent)).rejects.toThrow('Invalid Codex launch submission response');
  });
});

describe('isCodexLaunchTarget', () => {
  it('matches only the tab and tmux session captured when the intent was prepared', () => {
    expect(isCodexLaunchTarget(intent, { tabId: 'tab-1', sessionName: intent.sessionName })).toBe(true);
    expect(isCodexLaunchTarget(intent, { tabId: 'tab-2', sessionName: intent.sessionName })).toBe(false);
    expect(isCodexLaunchTarget(intent, { tabId: 'tab-1', sessionName: 'other-session' })).toBe(false);
  });
});
