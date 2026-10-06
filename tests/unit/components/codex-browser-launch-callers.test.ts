import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const callerPaths = [
  'src/components/features/workspace/pane-container.tsx',
  'src/components/features/mobile/mobile-surface-view.tsx',
];

const between = (source: string, start: string, end: string): string => {
  const startAt = source.indexOf(start);
  return source.slice(startAt, source.indexOf(end, startAt + start.length));
};

describe.each(callerPaths)('%s managed Codex launches', (callerPath) => {
  const source = fs.readFileSync(path.join(ROOT, callerPath), 'utf8');

  it('submits direct launches through the server lifecycle', () => {
    const body = between(source, 'const handleNewCodexSession', 'const handleNewGrokSession');

    expect(body).toContain('prepareCodexLaunch(null)');
    expect(body).toContain('continueCodexBrowserLaunch(intent)');
    expect(body).not.toContain('sendStdin');
    expect(body).not.toContain('markAgentLaunch');
    expect(source.match(/continueCodexBrowserLaunch\(intent\)/g)).toHaveLength(5);
  });

  it('queues a connected running target and submits an exact shell target', () => {
    const body = between(source, 'const continueCodexBrowserLaunch', 'const markAgentLaunch');

    expect(body).toContain('pendingCodexRestartsRef.current.set(intent.tabId, intent)');
    expect(body).toContain('isCodexLaunchTarget(intent');
    expect(body).toContain('agentProcess === true');
    expect(body).toContain('sendCodexQuitCommand(sendStdin)');
    expect(body).toContain('submitCodexBrowserLaunch(intent)');
    expect(body).not.toContain('intent.command');
    expect(body).not.toContain('markAgentLaunch');
  });

  it('awaits non-Codex launch persistence and checks the connected target before terminal input', () => {
    const marker = between(source, 'const markAgentLaunch', 'const handleNewCodexSession');
    expect(marker).toContain('return fetch(');
    expect(marker).toContain('response.ok');
    expect(marker).toContain("panelType: options?.panelType ?? 'claude-code'");
    const grok = between(source, 'const handleNewGrokSession', 'const handleNewClaudeFromSessionList');
    expect(grok.indexOf('await markAgentLaunch')).toBeLessThan(grok.indexOf('sendStdin('));
    expect(grok).toContain('connectedSessionRef.current !== sessionName');
    expect(source).toContain('if (recorded && activeTabIdRef.current === tabId && connectedSessionRef.current === sessionName) sendStdin');
  });

  it('uses the title event tab and session when releasing a queued replacement', () => {
    const titleHandler = between(source, 'onTitleChange: (title)', 'const tab = tabsRef.current.find');
    const submitter = between(source, 'const submitPendingCodexLaunch = useCallback', 'useEffect(() => {');

    expect(titleHandler).toContain('submitPendingCodexLaunchRef.current(tabId, activeTab.sessionName)');
    expect(submitter).toContain('isCodexLaunchTarget(intent, { tabId, sessionName })');
    expect(submitter).not.toContain('activeTabIdRef');
    expect(submitter).not.toContain('sendStdin');
  });
});
