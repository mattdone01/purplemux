// Browser entrypoint for Grok launch commands. The command is composed
// server-side because resolving the binary (PATH or `~/.grok/bin/grok`)
// needs Node-only filesystem access.

export const fetchGrokLaunchCommand = async (
  resumeSessionId?: string | null,
): Promise<string> => {
  const res = await fetch('/api/grok/launch-command', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resumeSessionId: resumeSessionId ?? null }),
  });
  if (!res.ok) {
    throw new Error('Failed to build Grok launch command');
  }
  const data = await res.json() as { command?: unknown };
  if (typeof data.command !== 'string' || !data.command.trim()) {
    throw new Error('Invalid Grok launch command response');
  }
  return data.command;
};
