export interface ICodexBrowserLaunchIntent {
  command: string;
  generation: string;
  workspaceId: string;
  tabId: string;
  sessionName: string;
  resumeSessionId: string | null;
}

interface IPrepareCodexBrowserLaunchInput {
  workspaceId: string;
  tabId: string;
  resumeSessionId: string | null;
}

interface ICodexLaunchTarget {
  tabId: string;
  sessionName: string;
}

interface ICodexLaunchSubmission {
  generation: string;
  phase: 'submitted';
}

const nonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

export const prepareCodexBrowserLaunch = async (
  input: IPrepareCodexBrowserLaunchInput,
): Promise<ICodexBrowserLaunchIntent> => {
  if (!nonEmptyString(input.workspaceId) || !nonEmptyString(input.tabId)) {
    throw new Error('Codex launch requires a workspace and tab');
  }
  const res = await fetch('/api/codex/launch-command', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error('Failed to prepare Codex launch');

  const data = await res.json() as Partial<ICodexBrowserLaunchIntent>;
  if (
    !nonEmptyString(data.command)
    || !nonEmptyString(data.generation)
    || !nonEmptyString(data.workspaceId)
    || !nonEmptyString(data.tabId)
    || !nonEmptyString(data.sessionName)
    || (data.resumeSessionId !== null && typeof data.resumeSessionId !== 'string')
    || data.workspaceId !== input.workspaceId
    || data.tabId !== input.tabId
    || data.resumeSessionId !== input.resumeSessionId
  ) {
    throw new Error('Invalid Codex launch intent response');
  }
  return data as ICodexBrowserLaunchIntent;
};

export const submitCodexBrowserLaunch = async (
  intent: ICodexBrowserLaunchIntent,
): Promise<ICodexLaunchSubmission> => {
  const res = await fetch('/api/codex/launch-submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workspaceId: intent.workspaceId,
      tabId: intent.tabId,
      generation: intent.generation,
    }),
  });
  if (!res.ok) throw new Error('Failed to submit Codex launch');

  const data = await res.json() as Partial<ICodexLaunchSubmission>;
  if (data.generation !== intent.generation || data.phase !== 'submitted') {
    throw new Error('Invalid Codex launch submission response');
  }
  return data as ICodexLaunchSubmission;
};

export const isCodexLaunchTarget = (
  intent: ICodexBrowserLaunchIntent,
  target: ICodexLaunchTarget,
): boolean => intent.tabId === target.tabId && intent.sessionName === target.sessionName;
