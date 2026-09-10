// Hook settings path mirrors HOOK_SETTINGS_PATH (lib/hook-settings.ts) and
// the workspace prompt path mirrors getClaudePromptPath (lib/claude-prompt.ts).
// Kept literal here because this module runs in the browser and cannot import
// node-only modules. Update both sides together if those paths move.

interface IBuildClaudeLaunchCommandOptions {
  workspaceId?: string | null;
  dangerouslySkipPermissions?: boolean;
  resumeSessionId?: string | null;
  model?: string;
  effort?: string;
}

export const buildClaudeLaunchCommand = ({
  workspaceId,
  dangerouslySkipPermissions,
  resumeSessionId,
  model,
  effort,
}: IBuildClaudeLaunchCommandOptions): string => {
  const parts: string[] = [];
  if (resumeSessionId) parts.push(`--resume ${resumeSessionId}`);
  parts.push('--settings ~/.purplemux/hooks.json');
  if (workspaceId) {
    parts.push(`--append-system-prompt-file ~/.purplemux/workspaces/${workspaceId}/claude-prompt.md`);
  }
  if (model) parts.push(`--model ${model}`);
  if (effort) parts.push(`--effort ${effort}`);
  if (dangerouslySkipPermissions) parts.push('--dangerously-skip-permissions');
  return `claude ${parts.join(' ')}`;
};

export const fetchClaudeLaunchCommand = async (
  workspaceId?: string | null,
  resumeSessionId?: string | null,
  tabId?: string | null,
): Promise<string> => {
  const res = await fetch('/api/claude/launch-command', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workspaceId: workspaceId ?? null,
      resumeSessionId: resumeSessionId ?? null,
      tabId: tabId ?? null,
    }),
  });
  if (!res.ok) throw new Error('Failed to build Claude launch command');
  const data = await res.json() as { command?: unknown };
  if (typeof data.command !== 'string' || !data.command.trim()) {
    throw new Error('Invalid Claude launch command response');
  }
  return data.command;
};
