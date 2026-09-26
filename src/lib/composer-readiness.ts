import { parsePermissionOptions } from '@/lib/permission-prompt';
import type { IClientTabStatusEntry } from '@/types/status';
import type { TPanelType } from '@/types/terminal';

// The checks an unattended sender runs before typing into an agent's
// composer (ADR-0008, ADR-0012). Extracted from Mission Control's dispatch so
// Mission Control and the tab inbox ask the same questions in the same order
// and name a refusal the same way.

const tail = (content: string, lines = 24): string => content.split('\n').slice(-lines).join('\n');

export const hasEmptyAgentComposer = (panelType: TPanelType | undefined, content: string): boolean => {
  const marker = panelType === 'codex-cli'
    ? '›'
    : panelType === 'claude-code'
      ? '❯'
      : panelType === 'grok-cli'
        ? '[›❯>]'
        : null;
  if (!marker) return false;
  const composerLines = tail(content, 12).split('\n');
  const composerPattern = new RegExp(`^[ \\t]*${marker}([ \\t\\u00a0].*)?$`);
  for (let index = composerLines.length - 1; index >= 0; index -= 1) {
    const match = composerLines[index].match(composerPattern);
    if (!match) continue;
    return (match[1] ?? '').trim() === '';
  }
  return false;
};

export type TComposerReadiness = { ok: true } | { ok: false; reason: string };

export interface IComposerReadinessInput {
  panelType: TPanelType | undefined;
  status: Pick<IClientTabStatusEntry, 'cliState' | 'permissionRequest'> | undefined;
  /** The pane, captured only after the status checks pass. */
  capture: () => Promise<string | null>;
  /**
   * A `busy` tab that is only waiting on its own background work, at an empty
   * composer (ADR-0018 ruling A′). Callers that may deliver to it pass it.
   */
  waitingAtPrompt?: boolean;
}

/**
 * The status checks first (no pane read), then the screen: no native
 * permission prompt, a state that holds a composer, no interactive option
 * list, and an empty composer. Every refusal is a reason a later look may
 * clear, so the caller decides how to back off.
 */
export const checkComposerReady = async (input: IComposerReadinessInput): Promise<TComposerReadiness> => {
  const { status } = input;
  if (!status) return { ok: false, reason: 'status-unavailable' };
  if (status.permissionRequest) return { ok: false, reason: 'native-prompt-active' };
  const stateReady = status.cliState === 'idle' || status.cliState === 'ready-for-review'
    || (status.cliState === 'busy' && input.waitingAtPrompt === true);
  if (!stateReady) return { ok: false, reason: `composer-not-ready:${status.cliState}` };

  const content = await input.capture().catch(() => null);
  if (!content) return { ok: false, reason: 'composer-unreadable' };
  if (parsePermissionOptions(tail(content)).options.length > 0) return { ok: false, reason: 'interactive-prompt-active' };
  if (!hasEmptyAgentComposer(input.panelType, content)) return { ok: false, reason: 'composer-not-empty' };
  return { ok: true };
};
