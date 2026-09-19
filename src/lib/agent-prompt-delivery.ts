import { findTabBySessionName } from '@/lib/layout-store';
import { sendBracketedPasteText, sendTypedText, submitComposer } from '@/lib/tmux';
import type { TPanelType } from '@/types/terminal';

/**
 * Claude Code treats a paste as untrusted data, so its prompts are typed. The
 * other agent TUIs take a paste as the prompt it is, and a paste is one tmux
 * call instead of one per chunk.
 */
export const usesTypedDelivery = (panelType: TPanelType | undefined): boolean =>
  panelType === 'claude-code';

export const sessionUsesTypedDelivery = async (sessionName: string): Promise<boolean> => {
  const tab = await findTabBySessionName(sessionName).catch(() => null);
  return usesTypedDelivery(tab?.panelType);
};

export interface IPromptDeliveryDeps {
  usesTyped: (sessionName: string) => Promise<boolean>;
  typeText: (sessionName: string, content: string) => Promise<void>;
  pasteText: (sessionName: string, content: string) => Promise<void>;
  submit: (sessionName: string) => Promise<void>;
}

const defaultDeps: IPromptDeliveryDeps = {
  usesTyped: sessionUsesTypedDelivery,
  typeText: sendTypedText,
  pasteText: sendBracketedPasteText,
  submit: submitComposer,
};

/** Put a prompt in the agent's composer WITHOUT submitting it. */
export const deliverPromptText = async (
  sessionName: string,
  content: string,
  deps: IPromptDeliveryDeps = defaultDeps,
): Promise<void> => {
  if (await deps.usesTyped(sessionName)) {
    await deps.typeText(sessionName, content);
    return;
  }
  await deps.pasteText(sessionName, content);
};

/** Put a prompt in the agent's composer and submit it. */
export const deliverPrompt = async (
  sessionName: string,
  content: string,
  deps: IPromptDeliveryDeps = defaultDeps,
): Promise<void> => {
  await deliverPromptText(sessionName, content, deps);
  await deps.submit(sessionName);
};
