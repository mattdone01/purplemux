// Browser entrypoint for Codex launch commands. The command itself is composed
// server-side because hook flags, user config merging, and prompt content all
// depend on Node-only filesystem access.

export const fetchCodexLaunchCommand = async (
  workspaceId?: string | null,
  resumeSessionId?: string | null,
  tabId?: string | null,
): Promise<string> => {
  const res = await fetch('/api/codex/launch-command', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workspaceId: workspaceId ?? null,
      resumeSessionId: resumeSessionId ?? null,
      tabId: tabId ?? null,
    }),
  });
  if (!res.ok) {
    throw new Error('Failed to build Codex launch command');
  }
  const data = await res.json() as { command?: unknown };
  if (typeof data.command !== 'string' || !data.command.trim()) {
    throw new Error('Invalid Codex launch command response');
  }
  return data.command;
};
