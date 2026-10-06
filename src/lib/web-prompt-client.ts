export interface IWebPromptTarget {
  workspaceId?: string;
  tabId?: string;
  sessionName?: string;
}

/** Explicit human submission. Raw terminal input is reserved for terminal interaction. */
export const sendWebPrompt = async (
  target: IWebPromptTarget, content: string, options?: { submit?: boolean; literalPaste?: boolean },
): Promise<void> => {
  if (!target.workspaceId || !target.tabId || !target.sessionName) throw new Error('Prompt target is unavailable');
  const submit = options?.submit !== false;
  const response = await fetch(`/api/tabs/${encodeURIComponent(target.tabId)}/send?workspaceId=${encodeURIComponent(target.workspaceId)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, submit, expectedSessionName: target.sessionName,
      ...(submit && content === '' ? { submitOnly: true } : {}),
      ...(options?.literalPaste ? { literalPaste: true } : {}),
    }),
  });
  if (!response.ok) throw new Error(`Prompt delivery was not confirmed (${response.status}); check the terminal before retrying`);
};
